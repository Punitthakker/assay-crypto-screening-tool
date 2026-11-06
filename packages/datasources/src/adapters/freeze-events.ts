import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { toEventSelector } from "viem";
import { getChain, normalizeAddress, tronHexToBase58, type ChainId, type TokenDef } from "@cr/shared";
import type { Transport } from "../transport.js";

/**
 * Historic freeze event index: every blacklist add, remove and destroy the issuer has
 * ever emitted for a token, kept in a local table (data/freeze-index/<chain>-<symbol>.json)
 * so "previously frozen" can be answered without a log scan per screen.
 *
 *   Tether (TetherToken)   AddedBlackList(address)  RemovedBlackList(address)  DestroyedBlackFunds(address,uint256)
 *                          the address is NOT indexed: it sits in the first word of `data`
 *   Circle (FiatToken)     Blacklisted(address indexed)  UnBlacklisted(address indexed)
 *                          the address is topics[1]
 *   Tron USDT              same Tether events via TronGrid /v1/contracts/{contract}/events
 *   Solana                 no event log: freezes are per token account (FreezeAccount / ThawAccount
 *                          instructions) and are read live by the issuer-freeze adapter only
 *
 * Reads go through Transport (Etherscan V2 getLogs with a key, Blockscout's Etherscan-compatible
 * /api without one, TronGrid events). The builder is incremental: it resumes from the stored
 * cursor block and dedupes on txHash:logIndex, so a daily run costs a page or two.
 */

export type FreezeEventType = "added" | "removed" | "destroyed";

export const FreezeEventSchema = z.object({
  type: z.enum(["added", "removed", "destroyed"]),
  address: z.string().min(1),
  block: z.number().int().nonnegative(),
  /** unix seconds; 0 when the provider did not say */
  timestamp: z.number().int().nonnegative(),
  txHash: z.string().min(1),
  /** base units burned, DestroyedBlackFunds only */
  amountBase: z.string().optional(),
});
export type FreezeEvent = z.infer<typeof FreezeEventSchema>;

export const FreezeIndexFileSchema = z.object({
  chain: z.string(),
  token: z.string(),
  symbol: z.string(),
  issuer: z.string(),
  provider: z.string(),
  /** last block (EVM) or block timestamp in ms (Tron) covered, inclusive */
  cursor: z.object({ block: z.number().int().nonnegative(), timestampMs: z.number().int().nonnegative().optional() }),
  updatedAt: z.string(),
  events: z.array(FreezeEventSchema),
});
export type FreezeIndexFile = z.infer<typeof FreezeIndexFileSchema> & { chain: ChainId };

export interface FreezeEventDef {
  type: FreezeEventType;
  name: string;
  signature: string;
  /** where the address lives in an EVM log */
  addressIn: "topic1" | "data";
}

const TETHER_EVENTS: FreezeEventDef[] = [
  { type: "added", name: "AddedBlackList", signature: "AddedBlackList(address)", addressIn: "data" },
  { type: "removed", name: "RemovedBlackList", signature: "RemovedBlackList(address)", addressIn: "data" },
  { type: "destroyed", name: "DestroyedBlackFunds", signature: "DestroyedBlackFunds(address,uint256)", addressIn: "data" },
];
const CIRCLE_EVENTS: FreezeEventDef[] = [
  { type: "added", name: "Blacklisted", signature: "Blacklisted(address)", addressIn: "topic1" },
  { type: "removed", name: "UnBlacklisted", signature: "UnBlacklisted(address)", addressIn: "topic1" },
];

/** Event set for a token, or undefined when the issuer keeps no on-chain freeze log for it. */
export function freezeEventsFor(token: TokenDef): FreezeEventDef[] | undefined {
  if (token.freeze.kind === "evm") return token.freeze.fn === "isBlackListed" ? TETHER_EVENTS : CIRCLE_EVENTS;
  if (token.freeze.kind === "tron") return TETHER_EVENTS;
  return undefined;
}

export function topicFor(def: FreezeEventDef): string {
  return toEventSelector(def.signature);
}

/* ------------------------------------ providers ------------------------------------ */

const EtherscanLog = z
  .object({
    topics: z.array(z.string()),
    data: z.string(),
    blockNumber: z.union([z.string(), z.number()]),
    timeStamp: z.union([z.string(), z.number()]).optional(),
    transactionHash: z.string(),
    logIndex: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
const EtherscanLogs = z.object({ status: z.string().optional(), message: z.string().optional(), result: z.union([z.array(EtherscanLog), z.string(), z.null()]) });

const TronEventRow = z
  .object({
    block_number: z.number(),
    block_timestamp: z.number(),
    transaction_id: z.string(),
    event_name: z.string(),
    result: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  })
  .passthrough();
const TronEvents = z.object({
  success: z.boolean().optional(),
  data: z.array(TronEventRow).default([]),
  meta: z.object({ fingerprint: z.string().optional() }).passthrough().optional(),
  error: z.string().optional(),
});

const num = (v: string | number | undefined): number => {
  if (v === undefined) return 0;
  if (typeof v === "number") return v;
  const s = v.trim();
  if (/^0x/i.test(s)) return parseInt(s, 16);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
const word = (hex: string, i: number) => hex.replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
const evmAddr = (w: string) => `0x${w.slice(-40)}`;

export const FREEZE_BLOCKSCOUT_HOSTS: Partial<Record<ChainId, string>> = {
  ethereum: "https://eth.blockscout.com",
  base: "https://base.blockscout.com",
  arbitrum: "https://arbitrum.blockscout.com",
  polygon: "https://polygon.blockscout.com",
  optimism: "https://optimism.blockscout.com",
};

export interface FreezeIndexerOptions {
  /** logs per request; Etherscan caps getLogs at 1000 */
  pageSize?: number;
  /** requests per event type per run, so a first build on a busy token cannot run away */
  maxPages?: number;
}

export interface FreezeIndexUpdate {
  file: FreezeIndexFile;
  /** events appended this run */
  added: number;
  pages: number;
}

/** Builds and refreshes one index file per token. Live only through Transport; tests stub it. */
export class FreezeIndexer {
  private etherscanKey: string | undefined;
  private etherscanBase = "https://api.etherscan.io/v2/api";
  private blockscout: Partial<Record<ChainId, string>>;
  private tronBase: string;
  private tronKey: string | undefined;
  private pageSize: number;
  private maxPages: number;

  constructor(
    private transport: Transport,
    env: NodeJS.ProcessEnv = process.env,
    opts: FreezeIndexerOptions = {},
  ) {
    this.etherscanKey = env.ETHERSCAN_API_KEY?.trim() || undefined;
    this.blockscout = { ...FREEZE_BLOCKSCOUT_HOSTS };
    for (const id of Object.keys(this.blockscout).concat(["avalanche", "bnb"]) as ChainId[]) {
      const o = env[`BLOCKSCOUT_${id.toUpperCase()}`];
      if (o && o.trim()) this.blockscout[id] = o.trim().replace(/\/$/, "");
    }
    const tron = env.RPC_TRON?.split(",")[0]?.trim();
    this.tronBase = (tron && tron.length ? tron : "https://api.trongrid.io").replace(/\/$/, "");
    this.tronKey = env.TRONGRID_API_KEY;
    this.pageSize = Math.max(1, Math.min(1000, opts.pageSize ?? 1000));
    this.maxPages = Math.max(1, opts.maxPages ?? 50);
  }

  /** Which provider a token would be indexed with, or a reason it cannot be. */
  providerFor(token: TokenDef): { provider: string } | { reason: string } {
    if (!freezeEventsFor(token)) return { reason: token.freeze.kind === "spl" ? "Solana freezes are per token account, no event log to index" : `no issuer freeze log for ${token.onChainSymbol} on ${token.chain} (${token.freeze.kind})` };
    const chain = getChain(token.chain);
    if (chain.family === "tron") return { provider: "trongrid" };
    if (this.etherscanKey && chain.etherscanChainId) return { provider: "etherscan-v2" };
    if (this.blockscout[token.chain]) return { provider: "blockscout" };
    return { reason: `no log provider for ${token.chain}: set ETHERSCAN_API_KEY or BLOCKSCOUT_${token.chain.toUpperCase()}` };
  }

  /** Fetches everything after `existing.cursor` (or from genesis) and returns the merged file. Throws on a provider error so a partial run never writes a wrong cursor. */
  async update(token: TokenDef, existing?: FreezeIndexFile): Promise<FreezeIndexUpdate> {
    const p = this.providerFor(token);
    if ("reason" in p) throw new Error(p.reason);
    const defs = freezeEventsFor(token)!;
    const base: FreezeIndexFile = existing ?? emptyIndex(token, p.provider);
    const seen = new Set(base.events.map((e) => `${e.txHash}:${e.type}:${e.address.toLowerCase()}:${e.block}`));
    const fresh: FreezeEvent[] = [];
    let pages = 0;
    let cursor = { ...base.cursor };
    const take = (list: FreezeEvent[]) => {
      for (const e of list) {
        const k = keyOf(e);
        if (seen.has(k)) continue;
        seen.add(k);
        fresh.push(e);
      }
    };
    if (p.provider === "trongrid") {
      const r = await this.tron(token, defs, cursor.timestampMs ?? 0);
      pages = r.pages;
      take(r.events);
      cursor = { block: Math.max(cursor.block, ...r.events.map((e) => e.block)), timestampMs: Math.max(cursor.timestampMs ?? 0, r.maxTimestampMs) };
    } else {
      const from = existing ? cursor.block + 1 : 0;
      const r = await this.evm(token, defs, from, p.provider);
      pages = r.pages;
      take(r.events);
      cursor = { block: Math.max(cursor.block, r.toBlock) };
    }
    const events = [...base.events, ...fresh].sort((a, b) => a.block - b.block || a.timestamp - b.timestamp);
    return { file: { ...base, provider: p.provider, cursor, updatedAt: new Date().toISOString(), events }, added: fresh.length, pages };
  }

  private async evm(token: TokenDef, defs: FreezeEventDef[], fromBlock: number, provider: string): Promise<{ events: FreezeEvent[]; toBlock: number; pages: number }> {
    const chain = getChain(token.chain);
    const events: FreezeEvent[] = [];
    let pages = 0;
    let highest = Math.max(0, fromBlock - 1);
    for (const def of defs) {
      let from = fromBlock;
      for (let page = 0; page < this.maxPages; page++) {
        pages++;
        const q = new URLSearchParams({ module: "logs", action: "getLogs", address: token.address, topic0: topicFor(def), fromBlock: String(from), toBlock: "latest", page: "1", offset: String(this.pageSize) });
        let url: string;
        if (provider === "etherscan-v2") {
          q.set("chainid", String(chain.etherscanChainId));
          q.set("apikey", this.etherscanKey!);
          url = `${this.etherscanBase}?${q.toString()}`;
        } else url = `${this.blockscout[token.chain]}/api?${q.toString()}`;
        const res = EtherscanLogs.parse(await this.transport.fetchJson(url));
        if (!Array.isArray(res.result)) {
          const text = `${res.message ?? ""} ${res.result ?? ""}`;
          if (/no records found|no logs found/i.test(text)) break;
          throw new Error(`${provider} getLogs ${def.name}: ${text.trim() || "error"}`);
        }
        let pageMax = from;
        for (const l of res.result) {
          const block = num(l.blockNumber);
          pageMax = Math.max(pageMax, block);
          const address = def.addressIn === "topic1" ? (l.topics[1] ? evmAddr(l.topics[1]) : undefined) : evmAddr(word(l.data, 0));
          if (!address || address.length !== 42) continue;
          const e: FreezeEvent = { type: def.type, address, block, timestamp: num(l.timeStamp), txHash: l.transactionHash };
          if (def.type === "destroyed" && l.data.replace(/^0x/, "").length >= 128) e.amountBase = BigInt(`0x${word(l.data, 1)}`).toString();
          events.push(e);
        }
        highest = Math.max(highest, pageMax);
        if (res.result.length < this.pageSize) break;
        // a full page: resume at its last block (re-read, deduped by the caller) in case that block was cut
        from = pageMax;
      }
    }
    return { events, toBlock: highest, pages };
  }

  private async tron(token: TokenDef, defs: FreezeEventDef[], sinceMs: number): Promise<{ events: FreezeEvent[]; maxTimestampMs: number; pages: number }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.tronKey) headers["TRON-PRO-API-KEY"] = this.tronKey;
    const events: FreezeEvent[] = [];
    let pages = 0;
    let maxTs = sinceMs;
    for (const def of defs) {
      let fingerprint: string | undefined;
      for (let page = 0; page < this.maxPages; page++) {
        pages++;
        const q = new URLSearchParams({ event_name: def.name, only_confirmed: "true", limit: String(Math.min(200, this.pageSize)), order_by: "block_timestamp,asc" });
        if (sinceMs > 0) q.set("min_block_timestamp", String(sinceMs + 1));
        if (fingerprint) q.set("fingerprint", fingerprint);
        const res = TronEvents.parse(await this.transport.fetchJson(`${this.tronBase}/v1/contracts/${token.address}/events?${q.toString()}`, { headers }));
        if (res.success === false || res.error) throw new Error(`trongrid events ${def.name}: ${res.error ?? "request failed"}`);
        for (const r of res.data) {
          const raw = r.result["_user"] ?? r.result["_blackListedUser"] ?? r.result["0"];
          const address = raw === undefined ? undefined : tronAddress(String(raw));
          if (!address) continue;
          const e: FreezeEvent = { type: def.type, address, block: r.block_number, timestamp: Math.floor(r.block_timestamp / 1000), txHash: r.transaction_id };
          const bal = r.result["_balance"] ?? r.result["1"];
          if (def.type === "destroyed" && bal !== undefined) e.amountBase = String(bal);
          events.push(e);
          maxTs = Math.max(maxTs, r.block_timestamp);
        }
        fingerprint = res.meta?.fingerprint;
        if (!fingerprint || res.data.length === 0) break;
      }
    }
    return { events, maxTimestampMs: maxTs, pages };
  }
}

const keyOf = (e: FreezeEvent) => `${e.txHash}:${e.type}:${e.address.toLowerCase()}:${e.block}`;

/** TronGrid event params arrive as base58, 41-hex or 0x-hex depending on the endpoint version. */
export function tronAddress(s: string): string | undefined {
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) return s;
  const h = s.toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]{40}$/.test(h) || /^41[0-9a-f]{40}$/.test(h)) {
    try {
      return tronHexToBase58(h);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function emptyIndex(token: TokenDef, provider: string): FreezeIndexFile {
  return { chain: token.chain, token: token.address, symbol: token.onChainSymbol, issuer: token.issuer, provider, cursor: { block: 0 }, updatedAt: new Date(0).toISOString(), events: [] };
}

export function indexFileName(token: TokenDef): string {
  return `${token.chain}-${token.onChainSymbol.toLowerCase()}.json`;
}

/* ------------------------------------ store ------------------------------------ */

export interface FreezeHistory {
  /** the issuer has blacklisted this address at least once */
  everFrozen: boolean;
  /** latest event says it is still listed (no later removal) */
  listedPerIndex: boolean;
  /** unix seconds of the first add */
  firstFrozenAt: number;
  /** unix seconds of the latest removal, when the latest event is a removal */
  releasedAt?: number;
  /** base units destroyed across all DestroyedBlackFunds events */
  destroyedBase: string;
  added: number;
  removed: number;
  destroyed: number;
  events: FreezeEvent[];
  /** index freshness, for the evidence line */
  indexUpdatedAt: string;
}

export interface FreezeIndexCoverage {
  indexed: boolean;
  provider?: string;
  updatedAt?: string;
  ageHours?: number;
  events?: number;
  cursor?: number;
  reason?: string;
}

export interface FreezeIndexOptions {
  /** directory of index files, default data/freeze-index */
  dir?: string;
  /** in-memory files instead of a directory (tests) */
  files?: FreezeIndexFile[];
  /** pins "now" for age computation */
  nowMs?: number;
}

/**
 * Read side: loads every index file once and answers per address. Missing files mean
 * "not indexed", never "never frozen"; the engine states that in its coverage line.
 */
export class FreezeIndex {
  private byToken = new Map<string, { file: FreezeIndexFile; byAddress: Map<string, FreezeEvent[]> }>();
  private nowMs: number | undefined;
  readonly dir: string | undefined;

  constructor(dirOrOpts: string | FreezeIndexOptions = {}) {
    const opts: FreezeIndexOptions = typeof dirOrOpts === "string" ? { dir: dirOrOpts } : dirOrOpts;
    this.nowMs = opts.nowMs;
    if (opts.files) for (const f of opts.files) this.add(f);
    else {
      this.dir = opts.dir ?? path.resolve(process.cwd(), "data/freeze-index");
      if (existsSync(this.dir)) {
        for (const f of readdirSync(this.dir).filter((x) => x.endsWith(".json")).sort()) {
          this.add(FreezeIndexFileSchema.parse(JSON.parse(readFileSync(path.join(this.dir, f), "utf8"))) as FreezeIndexFile);
        }
      }
    }
  }

  private static key(chain: ChainId, token: string) {
    return `${chain}:${normalizeAddress(token, getChain(chain).family)}`;
  }

  add(file: FreezeIndexFile) {
    const fam = getChain(file.chain).family;
    const byAddress = new Map<string, FreezeEvent[]>();
    for (const e of [...file.events].sort((a, b) => a.block - b.block || a.timestamp - b.timestamp)) {
      const k = normalizeAddress(e.address, fam);
      const arr = byAddress.get(k) ?? [];
      arr.push(e);
      byAddress.set(k, arr);
    }
    this.byToken.set(FreezeIndex.key(file.chain, file.token), { file, byAddress });
  }

  get tokens(): { chain: ChainId; token: string; symbol: string; events: number; addresses: number; updatedAt: string }[] {
    return [...this.byToken.values()].map(({ file, byAddress }) => ({ chain: file.chain, token: file.token, symbol: file.symbol, events: file.events.length, addresses: byAddress.size, updatedAt: file.updatedAt }));
  }

  file(token: TokenDef): FreezeIndexFile | undefined {
    return this.byToken.get(FreezeIndex.key(token.chain, token.address))?.file;
  }

  coverage(token: TokenDef): FreezeIndexCoverage {
    const entry = this.byToken.get(FreezeIndex.key(token.chain, token.address));
    if (!entry) {
      const reason = freezeEventsFor(token) ? `no freeze index for ${token.onChainSymbol} on ${token.chain}; run pnpm index:freeze` : token.freeze.kind === "spl" ? "Solana freezes are per token account, no event log" : `issuer freeze log not applicable (${token.freeze.kind})`;
      return { indexed: false, reason };
    }
    const now = this.nowMs ?? Date.now();
    const updated = Date.parse(entry.file.updatedAt);
    return {
      indexed: true,
      provider: entry.file.provider,
      updatedAt: entry.file.updatedAt,
      ageHours: Number.isFinite(updated) ? Math.max(0, Math.round(((now - updated) / 3_600_000) * 10) / 10) : undefined,
      events: entry.file.events.length,
      cursor: entry.file.cursor.block,
    } as FreezeIndexCoverage;
  }

  /** null when the token is not indexed; a history with everFrozen=false when it is and the address never appears */
  history(address: string, token: TokenDef): FreezeHistory | null {
    const entry = this.byToken.get(FreezeIndex.key(token.chain, token.address));
    if (!entry) return null;
    const events = entry.byAddress.get(normalizeAddress(address, getChain(token.chain).family)) ?? [];
    const h: FreezeHistory = { everFrozen: false, listedPerIndex: false, firstFrozenAt: 0, destroyedBase: "0", added: 0, removed: 0, destroyed: 0, events, indexUpdatedAt: entry.file.updatedAt };
    let destroyed = 0n;
    let listed = false;
    for (const e of events) {
      if (e.type === "added") {
        h.added++;
        listed = true;
        if (!h.firstFrozenAt) h.firstFrozenAt = e.timestamp;
      } else if (e.type === "removed") {
        h.removed++;
        listed = false;
        h.releasedAt = e.timestamp;
      } else {
        h.destroyed++;
        if (e.amountBase) destroyed += BigInt(e.amountBase);
      }
    }
    h.everFrozen = h.added > 0 || h.destroyed > 0;
    h.listedPerIndex = listed;
    if (listed) delete h.releasedAt;
    h.destroyedBase = destroyed.toString();
    return h;
  }
}

export function writeIndexFile(dir: string, token: TokenDef, file: FreezeIndexFile): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, indexFileName(token));
  writeFileSync(p, JSON.stringify(file, null, 1));
  return p;
}

export function readIndexFile(dir: string, token: TokenDef): FreezeIndexFile | undefined {
  const p = path.join(dir, indexFileName(token));
  if (!existsSync(p)) return undefined;
  return FreezeIndexFileSchema.parse(JSON.parse(readFileSync(p, "utf8"))) as FreezeIndexFile;
}
