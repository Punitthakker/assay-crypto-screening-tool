import { z } from "zod";
import { ChainIdSchema, AssetSchema, getChain, normalizeAddress, tokenByAddress, type ChainId, type Report, type TokenDef } from "@cr/shared";
import {
  IssuerFreezeAdapter,
  LabelStore,
  OfacAdapter,
  TxResolver,
  classifyInput,
  explorerAddressUrl,
  parseTxInput,
  pickTransfer,
  type Label,
  type ResolvedTx,
  type Transfer,
  type Transport,
} from "@cr/datasources";
import type { Engine } from "./screen.js";
import type { TraceNode, TraceResult } from "./trace.js";

/**
 * Screen by transaction: paste the hash or explorer link of the transfer you are
 * about to accept. Assay resolves it, screens the sender of that exact transfer,
 * and lists where the sender's own inbound funds came from over the trace window,
 * with the hard checks (label, OFAC, issuer freeze) run on each source.
 * The 2-hop trace scores them (EXPOSURE_* in the report); the source list reuses the trace's
 * hop-1 classification so no check runs twice, and the trace graph rides along as `trace`.
 */

export const ScreenTxRequestSchema = z
  .object({
    tx: z.string().min(20),
    chain: ChainIdSchema.optional(),
    asset: AssetSchema.optional(),
    /** the address that is receiving; when given, the tx must pay it or the report says so */
    receiver: z.string().optional(),
  })
  .strict();
export type ScreenTxRequest = z.infer<typeof ScreenTxRequestSchema>;

export interface Source {
  address: string;
  /** share of the sender's inbound value in the window, 0..1 */
  share: number;
  total: number;
  count: number;
  firstSeen: string;
  lastSeen: string;
  label?: { name: string; category: Label["category"]; jurisdiction?: string };
  /** hard checks on the source itself; null = not run (beyond the per-screen cap) or unavailable */
  sanctioned: boolean | null;
  frozen: boolean | null;
  /** worst of: sanctioned, frozen, label category */
  status: "sanctioned" | "frozen" | "mixer" | "scam" | "darknet" | "gambling" | "unlicensed" | "licensed" | "unlabelled";
  txHashes: string[];
}

export interface TxReport {
  tx: ResolvedTx & { inferredFrom: "url" | "hash-format" | "none" };
  /** the transfer that was screened, or absent when the tx moved no known USDT/USDC */
  screened?: { from: string; to: string; token: string; onChainSymbol: string; value: number; genuine: boolean; paysReceiver: boolean | null };
  report?: Report;
  sources: Source[];
  sourcesNote: string;
  trace?: TraceSummary;
  /** every token the tx moved that is not a registry USDT/USDC, for the fake-token warning */
  otherTokens: { token: string; value: number; from: string; to: string }[];
}

export const LookupRequestSchema = z
  .object({
    /** address, tx hash, explorer address link or explorer tx link */
    input: z.string().min(20),
    chain: ChainIdSchema.optional(),
    asset: AssetSchema.optional(),
    amount: z.number().positive().optional(),
    receiver: z.string().optional(),
  })
  .strict();
export type LookupRequest = z.infer<typeof LookupRequestSchema>;

export interface AddressReport {
  kind: "address";
  address: string;
  chain: ChainId;
  inferredFrom: "url" | "address-format" | "none";
  explorerUrl: string;
  report: Report;
  sources: Source[];
  sourcesNote: string;
  trace?: TraceSummary;
}

/** The trace graph without the engine internals: enough to draw it and link every node to an explorer. */
export interface TraceSummary {
  depthRequested: number;
  depthReached: number;
  exposure: TraceResult["exposure"];
  untraced: number;
  boundary: number;
  dusted: number;
  inboundTotal: number;
  nodes: TraceNode[];
}

export function summarizeTrace(t: TraceResult | undefined): TraceSummary | undefined {
  if (!t) return undefined;
  return { depthRequested: t.depthRequested, depthReached: t.depthReached, exposure: t.exposure, untraced: t.untraced, boundary: t.boundary, dusted: t.dusted, inboundTotal: t.inboundTotal, nodes: t.nodes };
}

export type LookupReport = AddressReport | ({ kind: "tx" } & TxReport);

const SOURCE_CHECK_CAP = 10;

export class TxScreener {
  private resolver: TxResolver;
  private freeze: IssuerFreezeAdapter;
  private ofac: OfacAdapter;
  constructor(
    private engine: Engine,
    transport: Transport,
    private labels: LabelStore,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.resolver = new TxResolver(transport, env);
    this.freeze = new IssuerFreezeAdapter(transport);
    this.ofac = new OfacAdapter(transport);
  }

  /** One entry point for the search box. */
  async lookup(input: unknown): Promise<LookupReport> {
    const req = LookupRequestSchema.parse(input);
    const c = classifyInput(req.input, req.chain);
    if (c.kind === "tx") {
      const r = await this.screen({ tx: req.input, ...(req.chain ? { chain: req.chain } : {}), ...(req.asset ? { asset: req.asset } : {}), ...(req.receiver ? { receiver: req.receiver } : {}) });
      return { kind: "tx", ...r };
    }
    if (req.chain && c.chain && c.inferredFrom === "url" && req.chain !== c.chain) {
      throw new Error(`the link is a ${getChain(c.chain).name} address but ${getChain(req.chain).name} was selected`);
    }
    const chain = c.chain ?? req.chain;
    if (!chain) throw new Error("pick the chain for an EVM address, or paste the explorer link");
    const asset = req.asset ?? "USDT";
    const { report, transfers, token, trace } = await this.engine.screenWithFlow({ address: c.address, chain, asset, ...(req.amount !== undefined ? { amount: req.amount } : {}) });
    const sources = token ? await this.sources(c.address, token, transfers, trace) : [];
    const ts = summarizeTrace(trace);
    return {
      kind: "address",
      address: c.address,
      chain,
      inferredFrom: c.inferredFrom,
      explorerUrl: explorerAddressUrl(chain, c.address),
      report,
      sources,
      sourcesNote: this.note(report, sources, transfers),
      ...(ts ? { trace: ts } : {}),
    };
  }

  private note(report: Report, sources: Source[], transfers: Transfer[]): string {
    const flowCov = report.coverage.find((c) => c.source === "explorer");
    return flowCov?.status === "unavailable"
      ? `sender's inbound history unavailable: ${flowCov.detail ?? "no explorer"}`
      : sources.length === 0
        ? "no inbound transfers of this token to the sender in the window"
        : `${sources.length} source${sources.length === 1 ? "" : "s"} over ${transfers.length} inbound transfer${transfers.length === 1 ? "" : "s"}; label, OFAC and issuer freeze checked on the top ${Math.min(sources.length, SOURCE_CHECK_CAP)} by value; ${report.coverage.find((c) => c.source === "fund-flow")?.status === "ok" || report.coverage.find((c) => c.source === "fund-flow")?.status === "partial" ? "scored by the backward trace (EXPOSURE_* lines in the report)" : "not scored: trace did not run"}`;
  }

  async screen(input: unknown): Promise<TxReport> {
    const req = ScreenTxRequestSchema.parse(input);
    const parsed = parseTxInput(req.tx, req.chain);
    if (req.chain && parsed.chain && req.chain !== parsed.chain && parsed.inferredFrom === "url") {
      throw new Error(`the link is a ${getChain(parsed.chain).name} transaction but ${getChain(req.chain).name} was selected`);
    }
    const resolved = await this.resolver.resolve(parsed);
    const tx = { ...resolved, inferredFrom: parsed.inferredFrom };
    const chain = resolved.chain as ChainId;
    const fam = getChain(chain).family;
    const otherTokens = resolved.transfers
      .filter((t) => !tokenByAddress(chain, t.token))
      .map((t) => ({ token: t.token, value: t.value, from: t.from, to: t.to }));

    if (resolved.status === "not_found") {
      return { tx, sources: [], sourcesNote: "transaction not found on this chain: wrong chain, still pending, or dropped", otherTokens };
    }
    const pick = pickTransfer(resolved, req.asset);
    if (!pick) {
      const note = resolved.transfers.length === 0 ? "the transaction moved no tokens" : `the transaction moved ${resolved.transfers.length} token transfer(s) but none is registry USDT or USDC on ${chain}; a look-alike token is likely`;
      return { tx, sources: [], sourcesNote: note, otherTokens };
    }
    const t = pick.transfer;
    const def = tokenByAddress(chain, t.token)!;
    const paysReceiver = req.receiver ? normalizeAddress(t.to, fam) === normalizeAddress(req.receiver, fam) : null;

    const { report, transfers, trace } = await this.engine.screenWithFlow({
      address: t.from,
      chain,
      asset: def.symbol,
      amount: t.value,
      tokenContract: t.token,
    });
    const sources = await this.sources(t.from, def, transfers, trace);
    const sourcesNote = this.note(report, sources, transfers);
    const ts = summarizeTrace(trace);

    return {
      tx,
      screened: { from: t.from, to: t.to, token: t.token, onChainSymbol: def.onChainSymbol, value: t.value, genuine: pick.registry && def.kind !== "bridged", paysReceiver },
      report,
      sources,
      sourcesNote,
      ...(ts ? { trace: ts } : {}),
      otherTokens,
    };
  }

  /** Aggregate inbound transfers by counterparty and run the cheap hard checks on the top N, reusing the trace's hop-1 answers when it ran. */
  async sources(sender: string, token: TokenDef, transfers: Transfer[], trace?: TraceResult): Promise<Source[]> {
    const fam = getChain(token.chain).family;
    const traced = new Map<string, TraceNode>();
    for (const n of trace?.nodes ?? []) if (n.hop === 1) traced.set(normalizeAddress(n.address, fam), n);
    const agg = new Map<string, { address: string; total: number; count: number; first: number; last: number; hashes: string[] }>();
    let grand = 0;
    for (const t of transfers) {
      const k = normalizeAddress(t.from, fam);
      if (k === normalizeAddress(sender, fam)) continue;
      grand += t.value;
      const a = agg.get(k) ?? { address: t.from, total: 0, count: 0, first: t.timestamp, last: t.timestamp, hashes: [] };
      a.total += t.value;
      a.count++;
      a.first = Math.min(a.first, t.timestamp);
      a.last = Math.max(a.last, t.timestamp);
      if (a.hashes.length < 5) a.hashes.push(t.txHash);
      agg.set(k, a);
    }
    const rows = [...agg.values()].sort((a, b) => b.total - a.total);
    let ofacSet: Set<string> | undefined;
    try {
      ofacSet = (await this.ofac.setFor(token.chain)).set;
    } catch {
      ofacSet = undefined;
    }
    const out: Source[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const label = this.labels.lookup(r.address, token.chain);
      const checked = i < SOURCE_CHECK_CAP;
      let sanctioned: boolean | null = null;
      let frozen: boolean | null = null;
      const node = traced.get(normalizeAddress(r.address, fam));
      if (node) {
        sanctioned = node.sanctioned;
        frozen = node.frozen;
        if (label?.category === "sanctioned") sanctioned = true;
      } else if (checked) {
        sanctioned = ofacSet ? ofacSet.has(normalizeAddress(r.address, fam)) : null;
        if (label?.category === "sanctioned") sanctioned = true;
        const fr = await this.freeze.screen(r.address, token);
        frozen = typeof fr.facts?.frozen === "boolean" ? fr.facts.frozen : null;
      }
      const status: Source["status"] = sanctioned
        ? "sanctioned"
        : frozen
          ? "frozen"
          : label?.category === "mixer"
            ? "mixer"
            : label?.category === "scam"
              ? "scam"
              : label?.category === "darknet"
                ? "darknet"
                : label?.category === "gambling"
                  ? "gambling"
                  : label?.category === "exchange_unlicensed"
                    ? "unlicensed"
                    : label?.category === "exchange_licensed"
                      ? "licensed"
                      : "unlabelled";
      out.push({
        address: r.address,
        share: grand > 0 ? Math.round((r.total / grand) * 10000) / 10000 : 0,
        total: Math.round(r.total * 1e6) / 1e6,
        count: r.count,
        firstSeen: new Date(r.first * 1000).toISOString(),
        lastSeen: new Date(r.last * 1000).toISOString(),
        ...(label ? { label: { name: label.name, category: label.category, ...(label.jurisdiction ? { jurisdiction: label.jurisdiction } : {}) } } : {}),
        sanctioned,
        frozen,
        status,
        txHashes: r.hashes,
      });
    }
    return out;
  }
}
