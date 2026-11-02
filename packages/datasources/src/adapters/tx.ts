import { z } from "zod";
import { keccak256, toBytes, type Hex } from "viem";
import { detectFamily, getChain, isSolanaAddress, rpcsFor, tokenByAddress, tronHexToBase58, type ChainId } from "@cr/shared";
import type { Transport } from "../transport.js";
import { TransferSchema, type Transfer } from "./explorer.js";

/**
 * Resolve a transaction (hash or explorer link) to its token transfers, so a
 * receiver can paste the thing they are looking at on tronscan or etherscan and
 * have Assay screen the sender of that exact transfer.
 * EVM via the public RPC receipt (no key). Tron via TronGrid events. Solana via RPC getTransaction.
 */

export interface TxInput {
  hash: string;
  chain?: ChainId;
  /** how the chain was decided */
  inferredFrom: "url" | "hash-format" | "none";
}

const HOST_CHAIN: [RegExp, ChainId][] = [
  [/(^|\.)tronscan\.(org|io)$/, "tron"],
  [/(^|\.)etherscan\.io$/, "ethereum"],
  [/(^|\.)eth\.blockscout\.com$/, "ethereum"],
  [/(^|\.)basescan\.org$/, "base"],
  [/(^|\.)base\.blockscout\.com$/, "base"],
  [/(^|\.)arbiscan\.io$/, "arbitrum"],
  [/(^|\.)arbitrum\.blockscout\.com$/, "arbitrum"],
  [/(^|\.)polygonscan\.com$/, "polygon"],
  [/(^|\.)polygon\.blockscout\.com$/, "polygon"],
  [/(^|\.)(snowtrace\.io|snowscan\.xyz|avascan\.info)$/, "avalanche"],
  [/(^|\.)bscscan\.com$/, "bnb"],
  [/(^|\.)optimistic\.etherscan\.io$/, "optimism"],
  [/(^|\.)(solscan\.io|solana\.fm|explorer\.solana\.com)$/, "solana"],
];

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const TRON_HASH = /^[0-9a-fA-F]{64}$/;
const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

export function looksLikeTx(s: string): boolean {
  const v = s.trim();
  if (/^https?:\/\//i.test(v)) return /\/(tx|transaction|transactions)\//i.test(v) || /#\/transaction\//i.test(v);
  return EVM_HASH.test(v) || TRON_HASH.test(v) || SOL_SIG.test(v);
}

/** Accepts a raw hash or an explorer URL. The chain is taken from the host when it is a URL, else from the hash shape. */
export function parseTxInput(raw: string, chainHint?: ChainId): TxInput {
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error("not a valid explorer link");
    }
    const host = u.hostname.toLowerCase();
    const chain = HOST_CHAIN.find(([re]) => re.test(host))?.[1];
    const pathAndHash = `${u.pathname}${u.hash}`;
    const m = pathAndHash.match(/(?:\/tx|\/transaction|\/transactions)\/([^/?#]+)/i);
    if (!m) throw new Error(`no transaction hash found in ${host} link`);
    const hash = m[1]!;
    if (!chain) {
      if (chainHint) return { hash, chain: chainHint, inferredFrom: "none" };
      return parseTxInput(hash, chainHint);
    }
    return { hash, chain, inferredFrom: "url" };
  }
  if (EVM_HASH.test(v)) return chainHint && getChain(chainHint).family === "evm" ? { hash: v, chain: chainHint, inferredFrom: "none" } : { hash: v, inferredFrom: "hash-format" };
  if (TRON_HASH.test(v)) return { hash: v.toLowerCase(), chain: "tron", inferredFrom: "hash-format" };
  if (SOL_SIG.test(v)) return { hash: v, chain: "solana", inferredFrom: "hash-format" };
  throw new Error("not a transaction hash or explorer link");
}

export interface AddressInput {
  address: string;
  chain?: ChainId;
  inferredFrom: "url" | "address-format" | "none";
}

/** Explorer address links: tronscan.org/address/T..., etherscan.io/address/0x..., solscan.io/account/... */
export function parseAddressInput(raw: string, chainHint?: ChainId): AddressInput {
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error("not a valid explorer link");
    }
    const host = u.hostname.toLowerCase();
    const chain = HOST_CHAIN.find(([re]) => re.test(host))?.[1];
    const m = `${u.pathname}${u.hash}`.match(/(?:\/address|\/account|\/token)\/([^/?#]+)/i);
    if (!m) throw new Error(`no address found in ${host} link`);
    const address = m[1]!;
    const fam = detectFamily(address);
    if (!fam) throw new Error(`"${address}" is not a recognised address format`);
    if (chain) return { address, chain, inferredFrom: "url" };
    return parseAddressInput(address, chainHint);
  }
  const fam = detectFamily(v);
  if (!fam) throw new Error(`"${v}" is not a recognised address format`);
  if (fam === "tron") return { address: v, chain: "tron", inferredFrom: "address-format" };
  if (fam === "solana") return { address: v, chain: "solana", inferredFrom: "address-format" };
  if (chainHint && getChain(chainHint).family === fam) return { address: v, chain: chainHint, inferredFrom: "none" };
  return { address: v, inferredFrom: "address-format" };
}

export type LookupInput = ({ kind: "tx" } & TxInput) | ({ kind: "address" } & AddressInput);

/** One box for everything: address, tx hash, explorer address link or explorer tx link. */
export function classifyInput(raw: string, chainHint?: ChainId): LookupInput {
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) {
    if (/(\/tx|\/transaction|\/transactions)\/[^/?#]+/i.test(v)) return { kind: "tx", ...parseTxInput(v, chainHint) };
    return { kind: "address", ...parseAddressInput(v, chainHint) };
  }
  if (looksLikeTx(v)) return { kind: "tx", ...parseTxInput(v, chainHint) };
  return { kind: "address", ...parseAddressInput(v, chainHint) };
}

export function explorerAddressUrl(chain: ChainId, address: string): string {
  const base: Record<ChainId, string> = {
    ethereum: "https://etherscan.io/address/",
    tron: "https://tronscan.org/#/address/",
    solana: "https://solscan.io/account/",
    base: "https://basescan.org/address/",
    arbitrum: "https://arbiscan.io/address/",
    polygon: "https://polygonscan.com/address/",
    avalanche: "https://snowscan.xyz/address/",
    bnb: "https://bscscan.com/address/",
    optimism: "https://optimistic.etherscan.io/address/",
  };
  return base[chain] + address;
}

export function explorerTxUrl(chain: ChainId, hash: string): string {
  const base: Record<ChainId, string> = {
    ethereum: "https://etherscan.io/tx/",
    tron: "https://tronscan.org/#/transaction/",
    solana: "https://solscan.io/tx/",
    base: "https://basescan.org/tx/",
    arbitrum: "https://arbiscan.io/tx/",
    polygon: "https://polygonscan.com/tx/",
    avalanche: "https://snowscan.xyz/tx/",
    bnb: "https://bscscan.com/tx/",
    optimism: "https://optimistic.etherscan.io/tx/",
  };
  return base[chain] + hash;
}

export const ResolvedTxSchema = z.object({
  chain: z.string(),
  hash: z.string(),
  status: z.enum(["confirmed", "failed", "not_found"]),
  blockNumber: z.number().int().optional(),
  timestamp: z.number().int().optional(),
  /** every token transfer in the tx, any token, in log order */
  transfers: z.array(TransferSchema),
  explorerUrl: z.string(),
  source: z.string(),
});
export type ResolvedTx = z.infer<typeof ResolvedTxSchema>;

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));

function topicToAddress(t: string): string {
  return `0x${t.slice(-40)}`;
}

function units(valueBase: string, decimals: number): number {
  const v = BigInt(valueBase);
  const d = 10n ** BigInt(decimals);
  return Number(`${v / d}.${(v % d).toString().padStart(decimals, "0").slice(0, 6) || "0"}`);
}

/* TronGrid events */
const TronEvent = z.object({
  block_number: z.number(),
  block_timestamp: z.number(),
  contract_address: z.string(),
  event_name: z.string(),
  result: z.record(z.string()),
  transaction_id: z.string(),
});
const TronEvents = z.object({ data: z.array(TronEvent).default([]), success: z.boolean().optional(), error: z.string().optional() });

/* Solana getTransaction (jsonParsed) */
const SolBalance = z.object({
  accountIndex: z.number(),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({ amount: z.string(), decimals: z.number() }),
});
const SolTx = z.object({
  result: z
    .object({
      slot: z.number(),
      blockTime: z.number().nullable().optional(),
      meta: z.object({ err: z.unknown().nullable(), preTokenBalances: z.array(SolBalance).default([]), postTokenBalances: z.array(SolBalance).default([]) }).nullable(),
    })
    .nullable()
    .optional(),
  error: z.unknown().optional(),
});

export class TxResolver {
  constructor(
    private transport: Transport,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  async resolve(input: TxInput): Promise<ResolvedTx> {
    if (!input.chain) throw new Error("chain is needed for an EVM transaction hash: pick the chain or paste the explorer link");
    const chain = getChain(input.chain);
    if (!chain.enabled) throw new Error(`${chain.name} is not enabled in v1`);
    switch (chain.family) {
      case "evm":
        return this.evm(chain.id, input.hash);
      case "tron":
        return this.tron(input.hash);
      case "solana":
        return this.solana(input.hash);
      default:
        throw new Error(`transactions on ${chain.family} are not supported`);
    }
  }

  private async evm(chain: ChainId, hash: string): Promise<ResolvedTx> {
    if (!EVM_HASH.test(hash)) throw new Error("EVM transaction hashes are 0x followed by 64 hex characters");
    const explorerUrl = explorerTxUrl(chain, hash);
    let r;
    try {
      r = await this.transport.evmGetTransactionReceipt(chain, hash as Hex);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not (be )?found|could not find|null/i.test(msg)) return { chain, hash, status: "not_found", transfers: [], explorerUrl, source: "rpc" };
      throw e;
    }
    const transfers: Transfer[] = [];
    for (const log of r.logs) {
      if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
      const tok = tokenByAddress(chain, log.address);
      const decimals = tok?.decimals ?? 18;
      const valueBase = BigInt(log.data === "0x" ? "0x0" : log.data).toString();
      transfers.push({
        chain,
        txHash: hash,
        from: topicToAddress(log.topics[1]!),
        to: topicToAddress(log.topics[2]!),
        token: log.address,
        valueBase,
        decimals,
        value: units(valueBase, decimals),
        timestamp: r.timestamp,
        blockNumber: r.blockNumber,
      });
    }
    return { chain, hash, status: r.status === "success" ? "confirmed" : "failed", blockNumber: r.blockNumber, timestamp: r.timestamp, transfers, explorerUrl, source: "rpc" };
  }

  private async tron(hash: string): Promise<ResolvedTx> {
    const base = (rpcsFor(getChain("tron"), this.env)[0] ?? "https://api.trongrid.io").replace(/\/$/, "");
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = this.env.TRONGRID_API_KEY;
    const explorerUrl = explorerTxUrl("tron", hash);
    const res = TronEvents.parse(await this.transport.fetchJson(`${base}/v1/transactions/${hash}/events`, { headers }));
    if (res.success === false || res.error) throw new Error(`trongrid: ${res.error ?? "request failed"}`);
    if (res.data.length === 0) return { chain: "tron", hash, status: "not_found", transfers: [], explorerUrl, source: "trongrid" };
    const transfers: Transfer[] = [];
    let blockNumber: number | undefined;
    let timestamp: number | undefined;
    for (const ev of res.data) {
      blockNumber = ev.block_number;
      timestamp = Math.floor(ev.block_timestamp / 1000);
      if (ev.event_name !== "Transfer") continue;
      const from = ev.result.from ?? ev.result["0"];
      const to = ev.result.to ?? ev.result["1"];
      const value = ev.result.value ?? ev.result["2"];
      if (!from || !to || value === undefined) continue;
      const tok = tokenByAddress("tron", ev.contract_address);
      const decimals = tok?.decimals ?? 6;
      transfers.push({
        chain: "tron",
        txHash: hash,
        from: from.startsWith("T") ? from : tronHexToBase58(from),
        to: to.startsWith("T") ? to : tronHexToBase58(to),
        token: ev.contract_address,
        valueBase: BigInt(value).toString(),
        decimals,
        value: units(BigInt(value).toString(), decimals),
        timestamp,
        blockNumber,
      });
    }
    return {
      chain: "tron",
      hash,
      status: "confirmed",
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      transfers,
      explorerUrl,
      source: "trongrid",
    };
  }

  private async solana(sig: string): Promise<ResolvedTx> {
    if (!isSolanaAddress(sig) && !SOL_SIG.test(sig)) throw new Error("not a Solana transaction signature");
    const rpc = this.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${this.env.HELIUS_API_KEY}` : (rpcsFor(getChain("solana"), this.env)[0] ?? "https://api.mainnet-beta.solana.com");
    const explorerUrl = explorerTxUrl("solana", sig);
    const res = SolTx.parse(
      await this.transport.fetchJson(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] }),
      }),
    );
    if (res.error) throw new Error(`solana rpc error: ${JSON.stringify(res.error)}`);
    if (!res.result || !res.result.meta) return { chain: "solana", hash: sig, status: "not_found", transfers: [], explorerUrl, source: "solana-rpc" };
    const { meta, slot, blockTime } = res.result;
    const timestamp = blockTime ?? 0;
    // per mint: owner deltas; the largest outflow is the sender, the largest inflow the receiver
    const delta = new Map<string, Map<string, { d: bigint; decimals: number }>>();
    const apply = (b: z.infer<typeof SolBalance>, sign: 1n | -1n) => {
      if (!b.owner) return;
      const m = delta.get(b.mint) ?? new Map();
      const cur = m.get(b.owner) ?? { d: 0n, decimals: b.uiTokenAmount.decimals };
      cur.d += sign * BigInt(b.uiTokenAmount.amount);
      m.set(b.owner, cur);
      delta.set(b.mint, m);
    };
    for (const b of meta.preTokenBalances) apply(b, -1n);
    for (const b of meta.postTokenBalances) apply(b, 1n);
    const transfers: Transfer[] = [];
    for (const [mint, owners] of delta) {
      const rows = [...owners.entries()];
      const outs = rows.filter(([, v]) => v.d < 0n).sort((a, b) => (a[1].d < b[1].d ? -1 : 1));
      const ins = rows.filter(([, v]) => v.d > 0n).sort((a, b) => (a[1].d > b[1].d ? -1 : 1));
      if (!outs.length || !ins.length) continue;
      const [from, fv] = outs[0]!;
      const [to, tv] = ins[0]!;
      const amount = -fv.d < tv.d ? -fv.d : tv.d;
      const decimals = fv.decimals;
      transfers.push({ chain: "solana", txHash: sig, from, to, token: mint, valueBase: amount.toString(), decimals, value: units(amount.toString(), decimals), timestamp, blockNumber: slot });
    }
    return { chain: "solana", hash: sig, status: meta.err ? "failed" : "confirmed", blockNumber: slot, timestamp, transfers, explorerUrl, source: "solana-rpc" };
  }
}

/**
 * The transfer to screen: a USDT/USDC transfer from the registry when one exists, the largest by value.
 * When `asset` is given, that symbol wins. Returns undefined when the tx moved no known stablecoin.
 */
export function pickTransfer(tx: ResolvedTx, asset?: "USDT" | "USDC"): { transfer: Transfer; registry: boolean } | undefined {
  const chain = tx.chain as ChainId;
  const known = tx.transfers
    .map((t) => ({ t, def: tokenByAddress(chain, t.token) }))
    .filter((x) => x.def && (!asset || x.def.symbol === asset))
    .sort((a, b) => b.t.value - a.t.value);
  if (known[0]) return { transfer: known[0].t, registry: true };
  return undefined;
}
