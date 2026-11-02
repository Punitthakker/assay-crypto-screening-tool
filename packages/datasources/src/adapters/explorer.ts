import { z } from "zod";
import { getChain, normalizeAddress, type ChainId, type TokenDef } from "@cr/shared";
import type { Transport } from "../transport.js";
import { now, type AdapterResult } from "../types.js";

/**
 * Explorer adapters: inbound transfers of one token to one address inside a window.
 * Four providers behind one interface, all through Transport so fixtures work offline:
 *   Etherscan V2  - every EVM chain, one key (ETHERSCAN_API_KEY), key required even for free tier
 *   Blockscout    - hosted EVM instances, no key, used when no Etherscan key or as fallback
 *   Routescan     - Etherscan-format API for Avalanche, no key, fallback only
 *   TronGrid      - TRC-20 transfers, key optional (TRONGRID_API_KEY)
 *   Helius        - Solana enhanced transactions, key required (HELIUS_API_KEY)
 * Nothing here scores. The trace (Phase 1b, next item) consumes `Transfer[]`.
 */

export const DEFAULT_WINDOW_DAYS = 90;
export const DEFAULT_MAX_TRANSFERS = 200;
const DAY_MS = 86_400_000;

export const TransferSchema = z.object({
  chain: z.string(),
  txHash: z.string(),
  from: z.string(),
  to: z.string(),
  /** token contract or mint, as written on chain */
  token: z.string(),
  /** base units, as a decimal string (bigint-safe) */
  valueBase: z.string().regex(/^\d+$/),
  decimals: z.number().int().min(0),
  /** token units, rounded to 6 dp, for weighting and display */
  value: z.number().min(0),
  /** unix seconds */
  timestamp: z.number().int(),
  blockNumber: z.number().int().optional(),
});
export type Transfer = z.infer<typeof TransferSchema>;

export interface TransferWindow {
  windowDays: number;
  maxTransfers: number;
  /** clock for the window start; tests pin it so fixtures stay valid */
  nowMs: number;
}

export function defaultWindow(partial: Partial<TransferWindow> = {}): TransferWindow {
  return { windowDays: DEFAULT_WINDOW_DAYS, maxTransfers: DEFAULT_MAX_TRANSFERS, nowMs: Date.now(), ...partial };
}

export interface TransferPage {
  provider: string;
  transfers: Transfer[];
  /** true when the transfer cap was hit before the window start was reached */
  truncated: boolean;
}

export interface ExplorerAdapter {
  readonly provider: string;
  supports(chain: ChainId): boolean;
  inboundTransfers(address: string, token: TokenDef, window: TransferWindow): Promise<TransferPage>;
}

export interface InboundTransfersResult {
  status: "ok" | "unavailable";
  provider?: string;
  transfers: Transfer[];
  truncated: boolean;
  window: { windowDays: number; maxTransfers: number; fromIso: string };
  detail: string;
}

function unitsOf(valueBase: string, decimals: number): number {
  const v = BigInt(valueBase);
  const d = BigInt(10) ** BigInt(decimals);
  const whole = v / d;
  const frac = v % d;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6);
  return Number(`${whole}${fracStr ? "." + fracStr : ""}`);
}

/** Keep only inbound transfers of the screened token inside the window, newest first, capped. */
function finalize(
  provider: string,
  raw: Transfer[],
  address: string,
  token: TokenDef,
  window: TransferWindow,
  reachedWindowEnd: boolean,
): TransferPage {
  const fam = getChain(token.chain).family;
  const me = normalizeAddress(address, fam);
  const tok = token.address.toLowerCase();
  const start = Math.floor((window.nowMs - window.windowDays * DAY_MS) / 1000);
  const inbound = raw
    .filter((t) => t.token.toLowerCase() === tok)
    .filter((t) => normalizeAddress(t.to, fam) === me)
    .filter((t) => t.timestamp >= start)
    .filter((t) => BigInt(t.valueBase) > 0n)
    .sort((a, b) => b.timestamp - a.timestamp);
  const seen = new Set<string>();
  const deduped = inbound.filter((t) => {
    const k = `${t.txHash}:${t.from}:${t.valueBase}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const capped = deduped.slice(0, window.maxTransfers);
  const truncated = deduped.length > window.maxTransfers || (!reachedWindowEnd && capped.length >= window.maxTransfers);
  return { provider, transfers: capped.map((t) => TransferSchema.parse(t)), truncated };
}

/* ---------------------------------- Etherscan V2 / Routescan ---------------------------------- */

const EtherscanRow = z.object({
  blockNumber: z.string(),
  timeStamp: z.string(),
  hash: z.string(),
  from: z.string(),
  to: z.string(),
  value: z.string(),
  contractAddress: z.string(),
  tokenDecimal: z.string(),
});
const EtherscanResponse = z.object({
  status: z.string(),
  message: z.string().optional(),
  result: z.union([z.array(EtherscanRow), z.string()]),
});

export interface EtherscanOptions {
  baseUrl?: string;
  apiKey?: string | undefined;
  /** tokentx returns in and out mixed; pages of 200 until the window start or this many pages */
  maxPages?: number;
  /** restrict to one chain (Routescan instances are per chain) */
  only?: ChainId[];
  provider?: string;
}

export class EtherscanV2Explorer implements ExplorerAdapter {
  readonly provider: string;
  private baseUrl: string;
  private apiKey: string | undefined;
  private maxPages: number;
  private only: ChainId[] | undefined;
  constructor(
    private transport: Transport,
    opts: EtherscanOptions = {},
  ) {
    this.baseUrl = opts.baseUrl ?? "https://api.etherscan.io/v2/api";
    this.apiKey = opts.apiKey;
    this.maxPages = opts.maxPages ?? 5;
    this.only = opts.only;
    this.provider = opts.provider ?? "etherscan-v2";
  }
  supports(chain: ChainId): boolean {
    const c = getChain(chain);
    if (c.family !== "evm" || !c.etherscanChainId) return false;
    return this.only ? this.only.includes(chain) : true;
  }
  async inboundTransfers(address: string, token: TokenDef, window: TransferWindow): Promise<TransferPage> {
    const c = getChain(token.chain);
    const start = Math.floor((window.nowMs - window.windowDays * DAY_MS) / 1000);
    const rows: Transfer[] = [];
    let reachedWindowEnd = false;
    let inbound = 0;
    for (let page = 1; page <= this.maxPages; page++) {
      const q = new URLSearchParams({
        chainid: String(c.etherscanChainId),
        module: "account",
        action: "tokentx",
        contractaddress: token.address,
        address,
        page: String(page),
        offset: "200",
        sort: "desc",
      });
      if (this.apiKey) q.set("apikey", this.apiKey);
      const res = EtherscanResponse.parse(await this.transport.fetchJson(`${this.baseUrl}?${q.toString()}`));
      if (typeof res.result === "string") {
        if (/no transactions found/i.test(res.result) || /no transactions found/i.test(res.message ?? "")) {
          reachedWindowEnd = true;
          break;
        }
        throw new Error(`${this.provider}: ${res.message ?? "error"}: ${res.result}`);
      }
      if (res.result.length === 0) {
        reachedWindowEnd = true;
        break;
      }
      for (const r of res.result) {
        const ts = Number(r.timeStamp);
        const dec = Number(r.tokenDecimal);
        rows.push({
          chain: token.chain,
          txHash: r.hash,
          from: r.from,
          to: r.to,
          token: r.contractAddress,
          valueBase: r.value,
          decimals: dec,
          value: unitsOf(r.value, dec),
          timestamp: ts,
          blockNumber: Number(r.blockNumber),
        });
        if (r.to.toLowerCase() === address.toLowerCase() && ts >= start) inbound++;
      }
      const oldest = res.result[res.result.length - 1]!;
      if (Number(oldest.timeStamp) < start) {
        reachedWindowEnd = true;
        break;
      }
      if (res.result.length < 200) {
        reachedWindowEnd = true;
        break;
      }
      if (inbound >= window.maxTransfers) break;
    }
    return finalize(this.provider, rows, address, token, window, reachedWindowEnd);
  }
}

/** Avalanche C-Chain via Routescan's Etherscan-compatible API, no key. */
export function routescanAvalanche(transport: Transport): EtherscanV2Explorer {
  return new EtherscanV2Explorer(transport, {
    baseUrl: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api",
    only: ["avalanche"],
    provider: "routescan",
    maxPages: 3,
  });
}

/* ---------------------------------- Blockscout ---------------------------------- */

const BlockscoutItem = z.object({
  transaction_hash: z.string(),
  timestamp: z.string(),
  block_number: z.number().optional(),
  from: z.object({ hash: z.string() }),
  to: z.object({ hash: z.string() }),
  token: z.object({ address: z.string(), decimals: z.string().nullable().optional() }),
  total: z.object({ value: z.string(), decimals: z.string().nullable().optional() }),
});
const BlockscoutResponse = z.object({
  items: z.array(BlockscoutItem),
  next_page_params: z.record(z.unknown()).nullable().optional(),
});

/** Hosted instances we rely on without a key. Override with BLOCKSCOUT_<CHAIN>=https://host. */
export const BLOCKSCOUT_HOSTS: Partial<Record<ChainId, string>> = {
  ethereum: "https://eth.blockscout.com",
  base: "https://base.blockscout.com",
  arbitrum: "https://arbitrum.blockscout.com",
  polygon: "https://polygon.blockscout.com",
  optimism: "https://optimism.blockscout.com",
};

export class BlockscoutExplorer implements ExplorerAdapter {
  readonly provider = "blockscout";
  private hosts: Partial<Record<ChainId, string>>;
  constructor(
    private transport: Transport,
    env: NodeJS.ProcessEnv = process.env,
    private maxPages = 5,
  ) {
    this.hosts = { ...BLOCKSCOUT_HOSTS };
    for (const id of Object.keys(this.hosts).concat(["avalanche", "bnb"]) as ChainId[]) {
      const o = env[`BLOCKSCOUT_${id.toUpperCase()}`];
      if (o && o.trim()) this.hosts[id] = o.trim().replace(/\/$/, "");
    }
  }
  supports(chain: ChainId): boolean {
    return getChain(chain).family === "evm" && Boolean(this.hosts[chain]);
  }
  async inboundTransfers(address: string, token: TokenDef, window: TransferWindow): Promise<TransferPage> {
    const host = this.hosts[token.chain];
    if (!host) throw new Error(`blockscout: no host for ${token.chain}`);
    const start = Math.floor((window.nowMs - window.windowDays * DAY_MS) / 1000);
    const rows: Transfer[] = [];
    let reachedWindowEnd = false;
    let next: Record<string, unknown> | null | undefined = undefined;
    for (let page = 1; page <= this.maxPages; page++) {
      const q = new URLSearchParams({ type: "ERC-20", filter: "to", token: token.address });
      if (next) for (const [k, v] of Object.entries(next)) q.set(k, String(v));
      const res = BlockscoutResponse.parse(
        await this.transport.fetchJson(`${host}/api/v2/addresses/${address}/token-transfers?${q.toString()}`),
      );
      for (const it of res.items) {
        const dec = Number(it.total.decimals ?? it.token.decimals ?? token.decimals);
        const ts = Math.floor(Date.parse(it.timestamp) / 1000);
        rows.push({
          chain: token.chain,
          txHash: it.transaction_hash,
          from: it.from.hash,
          to: it.to.hash,
          token: it.token.address,
          valueBase: it.total.value,
          decimals: dec,
          value: unitsOf(it.total.value, dec),
          timestamp: ts,
          ...(it.block_number !== undefined ? { blockNumber: it.block_number } : {}),
        });
      }
      const oldest = rows[rows.length - 1];
      if (!res.next_page_params || res.items.length === 0 || (oldest && oldest.timestamp < start)) {
        reachedWindowEnd = true;
        break;
      }
      if (rows.length >= window.maxTransfers) break;
      next = res.next_page_params;
    }
    return finalize(this.provider, rows, address, token, window, reachedWindowEnd);
  }
}

/* ---------------------------------- TronGrid ---------------------------------- */

const TronRow = z.object({
  transaction_id: z.string(),
  block_timestamp: z.number(),
  from: z.string(),
  to: z.string(),
  type: z.string().optional(),
  value: z.string(),
  token_info: z.object({ address: z.string(), decimals: z.number() }),
});
const TronResponse = z.object({
  success: z.boolean().optional(),
  data: z.array(TronRow).default([]),
  meta: z.object({ fingerprint: z.string().optional() }).passthrough().optional(),
  error: z.string().optional(),
});

export class TronGridExplorer implements ExplorerAdapter {
  readonly provider = "trongrid";
  private base: string;
  private key: string | undefined;
  constructor(
    private transport: Transport,
    env: NodeJS.ProcessEnv = process.env,
    private maxPages = 3,
  ) {
    const override = env.RPC_TRON?.split(",")[0]?.trim();
    this.base = (override && override.length ? override : "https://api.trongrid.io").replace(/\/$/, "");
    this.key = env.TRONGRID_API_KEY;
  }
  supports(chain: ChainId): boolean {
    return chain === "tron";
  }
  async inboundTransfers(address: string, token: TokenDef, window: TransferWindow): Promise<TransferPage> {
    const startMs = window.nowMs - window.windowDays * DAY_MS;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.key) headers["TRON-PRO-API-KEY"] = this.key;
    const rows: Transfer[] = [];
    let fingerprint: string | undefined;
    let reachedWindowEnd = false;
    for (let page = 1; page <= this.maxPages; page++) {
      const q = new URLSearchParams({
        only_to: "true",
        only_confirmed: "true",
        limit: "200",
        contract_address: token.address,
        min_timestamp: String(startMs),
        order_by: "block_timestamp,desc",
      });
      if (fingerprint) q.set("fingerprint", fingerprint);
      const res = TronResponse.parse(
        await this.transport.fetchJson(`${this.base}/v1/accounts/${address}/transactions/trc20?${q.toString()}`, { headers }),
      );
      if (res.success === false || res.error) throw new Error(`trongrid: ${res.error ?? "request failed"}`);
      for (const r of res.data) {
        if (r.type && r.type !== "Transfer") continue;
        const dec = r.token_info.decimals;
        rows.push({
          chain: "tron",
          txHash: r.transaction_id,
          from: r.from,
          to: r.to,
          token: r.token_info.address,
          valueBase: r.value,
          decimals: dec,
          value: unitsOf(r.value, dec),
          timestamp: Math.floor(r.block_timestamp / 1000),
        });
      }
      fingerprint = res.meta?.fingerprint;
      if (!fingerprint || res.data.length === 0) {
        reachedWindowEnd = true;
        break;
      }
      if (rows.length >= window.maxTransfers) break;
    }
    return finalize(this.provider, rows, address, token, window, reachedWindowEnd);
  }
}

/* ---------------------------------- Tronscan (fallback) ---------------------------------- */

const TronscanTransfer = z.object({
  transaction_id: z.string(),
  block_ts: z.number(),
  from_address: z.string(),
  to_address: z.string(),
  block: z.number().optional(),
  contract_address: z.string(),
  quant: z.string(),
  confirmed: z.boolean().optional(),
  contractRet: z.string().optional(),
  finalResult: z.string().optional(),
  event_type: z.string().optional(),
  tokenInfo: z.object({ tokenDecimal: z.number().optional() }).passthrough().optional(),
});
const TronscanTransfers = z.object({
  total: z.number().optional(),
  rangeTotal: z.number().optional(),
  token_transfers: z.array(TronscanTransfer).default([]),
});

export const TRONSCAN_API = "https://apilist.tronscanapi.com";

/** Tronscan's public API, no key (TRONSCAN_API_KEY optional). Pages of 50, used when TronGrid throttles. */
export class TronscanExplorer implements ExplorerAdapter {
  readonly provider = "tronscan";
  private key: string | undefined;
  private base: string;
  constructor(
    private transport: Transport,
    env: NodeJS.ProcessEnv = process.env,
    private maxPages = 4,
  ) {
    this.key = env.TRONSCAN_API_KEY;
    this.base = (env.TRONSCAN_API ?? TRONSCAN_API).replace(/\/$/, "");
  }
  supports(chain: ChainId): boolean {
    return chain === "tron";
  }
  async inboundTransfers(address: string, token: TokenDef, window: TransferWindow): Promise<TransferPage> {
    const startMs = window.nowMs - window.windowDays * DAY_MS;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.key) headers["TRON-PRO-API-KEY"] = this.key;
    const rows: Transfer[] = [];
    let reachedWindowEnd = false;
    for (let page = 0; page < this.maxPages; page++) {
      const q = new URLSearchParams({
        limit: "50",
        start: String(page * 50),
        contract_address: token.address,
        toAddress: address,
        start_timestamp: String(startMs),
        end_timestamp: String(window.nowMs),
        confirm: "true",
      });
      const res = TronscanTransfers.parse(await this.transport.fetchJson(`${this.base}/api/token_trc20/transfers?${q.toString()}`, { headers }));
      for (const r of res.token_transfers) {
        if (r.event_type && r.event_type !== "Transfer") continue;
        if ((r.finalResult ?? r.contractRet ?? "SUCCESS") !== "SUCCESS") continue;
        const dec = r.tokenInfo?.tokenDecimal ?? token.decimals;
        rows.push({
          chain: "tron",
          txHash: r.transaction_id,
          from: r.from_address,
          to: r.to_address,
          token: r.contract_address,
          valueBase: BigInt(r.quant).toString(),
          decimals: dec,
          value: unitsOf(BigInt(r.quant).toString(), dec),
          timestamp: Math.floor(r.block_ts / 1000),
          ...(r.block !== undefined ? { blockNumber: r.block } : {}),
        });
      }
      const total = res.rangeTotal ?? res.total ?? 0;
      if (res.token_transfers.length < 50 || (page + 1) * 50 >= total) {
        reachedWindowEnd = true;
        break;
      }
      if (rows.length >= window.maxTransfers) break;
    }
    return finalize(this.provider, rows, address, token, window, reachedWindowEnd);
  }
}

/* ---------------------------------- Helius (Solana) ---------------------------------- */

const HeliusTokenTransfer = z.object({
  fromUserAccount: z.string().nullable().optional(),
  toUserAccount: z.string().nullable().optional(),
  tokenAmount: z.number(),
  mint: z.string(),
});
const HeliusTx = z.object({
  signature: z.string(),
  timestamp: z.number(),
  slot: z.number().optional(),
  tokenTransfers: z.array(HeliusTokenTransfer).default([]),
});
const HeliusResponse = z.array(HeliusTx);

export class HeliusExplorer implements ExplorerAdapter {
  readonly provider = "helius";
  private key: string | undefined;
  constructor(
    private transport: Transport,
    env: NodeJS.ProcessEnv = process.env,
    private maxPages = 5,
  ) {
    this.key = env.HELIUS_API_KEY;
  }
  supports(chain: ChainId): boolean {
    return chain === "solana" && Boolean(this.key);
  }
  async inboundTransfers(address: string, token: TokenDef, window: TransferWindow): Promise<TransferPage> {
    if (!this.key) throw new Error("helius: HELIUS_API_KEY not set");
    const start = Math.floor((window.nowMs - window.windowDays * DAY_MS) / 1000);
    const rows: Transfer[] = [];
    let before: string | undefined;
    let reachedWindowEnd = false;
    const scale = BigInt(10) ** BigInt(token.decimals);
    for (let page = 1; page <= this.maxPages; page++) {
      const q = new URLSearchParams({ "api-key": this.key, limit: "100", type: "TRANSFER" });
      if (before) q.set("before", before);
      const res = HeliusResponse.parse(
        await this.transport.fetchJson(`https://api.helius.xyz/v0/addresses/${address}/transactions?${q.toString()}`),
      );
      if (res.length === 0) {
        reachedWindowEnd = true;
        break;
      }
      for (const tx of res) {
        for (const tt of tx.tokenTransfers) {
          if (tt.mint !== token.address || !tt.toUserAccount || !tt.fromUserAccount) continue;
          // Helius reports UI amounts; rebuild base units from the registry decimals
          const base = (BigInt(Math.round(tt.tokenAmount * 1e6)) * scale) / 1_000_000n;
          rows.push({
            chain: "solana",
            txHash: tx.signature,
            from: tt.fromUserAccount,
            to: tt.toUserAccount,
            token: tt.mint,
            valueBase: base.toString(),
            decimals: token.decimals,
            value: unitsOf(base.toString(), token.decimals),
            timestamp: tx.timestamp,
            ...(tx.slot !== undefined ? { blockNumber: tx.slot } : {}),
          });
        }
      }
      const oldest = res[res.length - 1]!;
      if (oldest.timestamp < start || res.length < 100) {
        reachedWindowEnd = true;
        break;
      }
      if (rows.filter((r) => r.to === address).length >= window.maxTransfers) break;
      before = oldest.signature;
    }
    return finalize(this.provider, rows, address, token, window, reachedWindowEnd);
  }
}

/* ---------------------------------- Router ---------------------------------- */

const SOURCE = "explorer";

/**
 * Picks providers per chain in order and falls through on failure.
 * EVM: Etherscan V2 when a key is set, then Blockscout, then Routescan (Avalanche).
 * Tron: TronGrid, then Tronscan's public API. Solana: Helius when a key is set.
 */
export class ExplorerRouter {
  private adapters: ExplorerAdapter[];
  constructor(
    transport: Transport,
    env: NodeJS.ProcessEnv = process.env,
    adapters?: ExplorerAdapter[],
  ) {
    const etherscanKey = env.ETHERSCAN_API_KEY?.trim();
    this.adapters = adapters ?? [
      ...(etherscanKey ? [new EtherscanV2Explorer(transport, { apiKey: etherscanKey })] : []),
      new BlockscoutExplorer(transport, env),
      routescanAvalanche(transport),
      new TronGridExplorer(transport, env),
      new TronscanExplorer(transport, env),
      new HeliusExplorer(transport, env),
    ];
  }

  candidates(chain: ChainId): ExplorerAdapter[] {
    return this.adapters.filter((a) => a.supports(chain));
  }

  async inboundTransfers(address: string, token: TokenDef, window: TransferWindow = defaultWindow()): Promise<InboundTransfersResult> {
    const fromIso = new Date(window.nowMs - window.windowDays * DAY_MS).toISOString();
    const base = { window: { windowDays: window.windowDays, maxTransfers: window.maxTransfers, fromIso } };
    const cands = this.candidates(token.chain);
    if (cands.length === 0) {
      const need = token.chain === "solana" ? "HELIUS_API_KEY" : `ETHERSCAN_API_KEY or BLOCKSCOUT_${token.chain.toUpperCase()}`;
      return { status: "unavailable", transfers: [], truncated: false, ...base, detail: `no explorer configured for ${token.chain}; set ${need}` };
    }
    const errors: string[] = [];
    for (const a of cands) {
      try {
        const page = await a.inboundTransfers(address, token, window);
        const n = page.transfers.length;
        return {
          status: "ok",
          provider: page.provider,
          transfers: page.transfers,
          truncated: page.truncated,
          ...base,
          detail: `${n} inbound ${token.onChainSymbol} transfer${n === 1 ? "" : "s"} since ${fromIso.slice(0, 10)} via ${page.provider}${page.truncated ? ` (capped at ${window.maxTransfers})` : ""}${errors.length ? `; ${errors.join("; ")}` : ""}`,
        };
      } catch (e) {
        errors.push(`${a.provider}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { status: "unavailable", transfers: [], truncated: false, ...base, detail: errors.join("; ") };
  }

  /** Engine-facing wrapper: a coverage line plus one informational evidence line. Never throws. */
  async screen(address: string, token: TokenDef, window: TransferWindow = defaultWindow()): Promise<AdapterResult & { transfers: Transfer[] }> {
    const checkedAt = now();
    let r: InboundTransfersResult;
    try {
      r = await this.inboundTransfers(address, token, window);
    } catch (e) {
      r = { status: "unavailable", transfers: [], truncated: false, window: { windowDays: window.windowDays, maxTransfers: window.maxTransfers, fromIso: "" }, detail: e instanceof Error ? e.message : String(e) };
    }
    if (r.status !== "ok") {
      return { transfers: [], evidence: [], facts: { inboundCount: null }, coverage: { source: SOURCE, status: "unavailable", detail: r.detail } };
    }
    const total = r.transfers.reduce((s, t) => s + t.value, 0);
    const counterparties = new Set(r.transfers.map((t) => t.from)).size;
    return {
      transfers: r.transfers,
      facts: { inboundCount: r.transfers.length, inboundTotal: total, counterparties, provider: r.provider, truncated: r.truncated },
      coverage: { source: SOURCE, status: r.truncated ? "partial" : "ok", detail: r.detail },
      evidence: [
        {
          code: "FLOW_INBOUND_WINDOW",
          source: `${SOURCE}:${r.provider}`,
          severity: "info",
          points: 0,
          hop: 0,
          summary: `${r.transfers.length} inbound ${token.onChainSymbol} transfer${r.transfers.length === 1 ? "" : "s"} from ${counterparties} counterpart${counterparties === 1 ? "y" : "ies"} totalling ${total.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${token.onChainSymbol} since ${r.window.fromIso.slice(0, 10)}${r.truncated ? ` (capped at ${window.maxTransfers}, older transfers not fetched)` : ""}`,
          checkedAt,
        },
      ],
    };
  }
}
