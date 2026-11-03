import { getChain, normalizeAddress, type Coverage, type Evidence, type TokenDef } from "@cr/shared";
import type { InboundTransfersResult, Label, LabelCategory, Transfer, TransferWindow } from "@cr/datasources";

/**
 * Backward fund-flow trace: who paid the sender, and who paid them.
 *
 * Hop 1 is the sender's inbound transfers of the screened token inside the window
 * (already fetched by the engine). Hop 2 fetches the same for every unlabelled hop-1
 * counterparty, up to the fan-out cap. Each node is classified with the cheap hard checks
 * (label store, OFAC list, issuer freeze read) and its share of value flows back to the
 * sender as exposure, decayed by hop. Nothing here blocks: a sanctioned counterparty is
 * exposure, only the sender itself can be a hard block.
 *
 * Boundaries (SCORING.md 2a): a licensed exchange terminates the branch at 0 points,
 * a labelled or frozen or sanctioned counterparty contributes and is not expanded,
 * value beyond the fan-out cap is `untraced` and lowers confidence, not the score.
 */

export type ExposureCategory =
  | "sanctioned"
  | "frozen"
  | "previously_frozen"
  | "mixer"
  | "scam"
  | "darknet"
  | "gambling"
  | "unlicensed_vasp"
  | "bridge_in"
  | "fresh_wallet";

export const EXPOSURE_WEIGHTS: Record<ExposureCategory, { points: number; cap: number }> = {
  sanctioned: { points: 80, cap: 80 },
  frozen: { points: 60, cap: 60 },
  mixer: { points: 55, cap: 55 },
  scam: { points: 50, cap: 50 },
  darknet: { points: 50, cap: 50 },
  previously_frozen: { points: 20, cap: 20 },
  unlicensed_vasp: { points: 20, cap: 20 },
  gambling: { points: 15, cap: 15 },
  bridge_in: { points: 10, cap: 10 },
  fresh_wallet: { points: 8, cap: 15 },
};

/** Any non-zero exposure to these contributes at least DUST_FLOOR_POINTS (dust rule). */
export const DUST_RULE_CATEGORIES: ExposureCategory[] = ["sanctioned", "mixer", "frozen"];
export const DUST_FLOOR_POINTS = 8;
/** hop 1 = 1.0, hop 2 = 0.5, hop 3 = 0.25 */
export const HOP_DECAY = [0, 1, 0.5, 0.25] as const;

export interface TraceOptions {
  /** hops to walk back; 0 disables, max 3 */
  depth: number;
  /** counterparties kept per hop, by value */
  fanOut: number;
  /** transfers from one counterparty totalling under this (token units) are ignored: dusting defence */
  dustFloor: number;
  /** issuer freeze reads per trace; counterparties beyond it are classified by label and list only */
  freezeCheckCap: number;
  /** hop-1 counterparties expanded to hop 2; defaults to fanOut */
  expandCap?: number;
}

export const DEFAULT_TRACE: TraceOptions = { depth: 2, fanOut: 25, dustFloor: 1, freezeCheckCap: 50 };

export function traceOptionsFromEnv(env: NodeJS.ProcessEnv = process.env, over: Partial<TraceOptions> = {}): TraceOptions {
  const num = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && env[k] !== undefined && env[k] !== "" ? v : d;
  };
  const o: TraceOptions = {
    depth: Math.min(3, Math.max(0, num("CR_TRACE_DEPTH", DEFAULT_TRACE.depth))),
    fanOut: Math.max(1, num("CR_TRACE_FANOUT", DEFAULT_TRACE.fanOut)),
    dustFloor: Math.max(0, num("CR_TRACE_DUST", DEFAULT_TRACE.dustFloor)),
    freezeCheckCap: Math.max(0, num("CR_TRACE_FREEZE_CAP", DEFAULT_TRACE.freezeCheckCap)),
    ...over,
  };
  const ec = env.CR_TRACE_EXPAND_CAP;
  if (ec !== undefined && ec !== "" && Number.isFinite(Number(ec)) && over.expandCap === undefined) o.expandCap = Math.max(0, Number(ec));
  return o;
}

export type NodeStatus = ExposureCategory | "licensed_vasp" | "unlabelled" | "internal";

export interface TraceNode {
  address: string;
  hop: number;
  /** who this node paid (the sender at hop 1) */
  paid: string;
  /** token units received by `paid` from this node in the window */
  value: number;
  count: number;
  txHashes: string[];
  /** share of the sender's inbound value that flowed through this node, 0..1, before decay */
  weight: number;
  status: NodeStatus;
  label?: { name: string; category: LabelCategory; jurisdiction?: string };
  sanctioned: boolean | null;
  frozen: boolean | null;
  /** hop-1 only: whether its own inbound was fetched for the next hop */
  expanded?: "yes" | "no_explorer" | "beyond_cap" | "not_needed";
}

export interface TraceResult {
  depthRequested: number;
  depthReached: number;
  nodes: TraceNode[];
  /** share per category, decayed, 0..1 */
  exposure: Partial<Record<ExposureCategory, number>>;
  /** share of inbound value not examined (beyond fan-out, hop-2 fetch failed) */
  untraced: number;
  /** share of inbound value that stopped at a licensed VASP */
  boundary: number;
  /** share dropped as dust */
  dusted: number;
  inboundTotal: number;
  evidence: Evidence[];
  coverage: Coverage;
}

/** What the tracer needs from the rest of the system; the engine wires real adapters, tests wire maps. */
export interface TraceDeps {
  inbound(address: string, token: TokenDef, window: TransferWindow): Promise<InboundTransfersResult>;
  label(address: string): Label | undefined;
  /** null when the list is unavailable */
  sanctioned(address: string): Promise<boolean | null>;
  /** null when the read is unavailable or not applicable */
  frozen(address: string, token: TokenDef): Promise<boolean | null>;
}

interface Agg {
  address: string;
  value: number;
  count: number;
  hashes: string[];
}

function aggregate(transfers: Transfer[], exclude: Set<string>, fam: ReturnType<typeof getChain>["family"]): { rows: Agg[]; total: number } {
  const m = new Map<string, Agg>();
  for (const t of transfers) {
    const k = normalizeAddress(t.from, fam);
    if (exclude.has(k)) continue;
    const a = m.get(k) ?? { address: t.from, value: 0, count: 0, hashes: [] };
    a.value += t.value;
    a.count++;
    if (a.hashes.length < 5) a.hashes.push(t.txHash);
    m.set(k, a);
  }
  const rows = [...m.values()].sort((a, b) => b.value - a.value);
  return { rows, total: rows.reduce((s, r) => s + r.value, 0) };
}

function categoryOf(label: Label | undefined, sanctioned: boolean | null, frozen: boolean | null): NodeStatus {
  if (sanctioned || label?.category === "sanctioned") return "sanctioned";
  if (frozen) return "frozen";
  switch (label?.category) {
    case "mixer":
      return "mixer";
    case "scam":
      return "scam";
    case "darknet":
      return "darknet";
    case "gambling":
      return "gambling";
    case "exchange_unlicensed":
      return "unlicensed_vasp";
    case "bridge":
      return "bridge_in";
    case "exchange_licensed":
      return "licensed_vasp";
    default:
      return "unlabelled";
  }
}

const pct = (x: number) => `${(x * 100).toFixed(x * 100 >= 10 ? 0 : 1)}%`;
const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });

export class Tracer {
  constructor(
    private deps: TraceDeps,
    private opts: TraceOptions = DEFAULT_TRACE,
  ) {}

  async trace(sender: string, token: TokenDef, hop1: Transfer[], window: TransferWindow, hop1Truncated = false): Promise<TraceResult> {
    const checkedAt = new Date().toISOString();
    const fam = getChain(token.chain).family;
    const norm = (a: string) => normalizeAddress(a, fam);
    const me = norm(sender);
    const depth = Math.min(3, Math.max(0, this.opts.depth));
    const nodes: TraceNode[] = [];
    const exposure: Partial<Record<ExposureCategory, number>> = {};
    const contributors: Partial<Record<ExposureCategory, { node: TraceNode; share: number }[]>> = {};
    let untraced = 0;
    let boundary = 0;
    let dusted = 0;
    let freezeReads = 0;
    let fetchFailures = 0;
    let depthReached = 0;

    const add = (cat: ExposureCategory, node: TraceNode, share: number) => {
      exposure[cat] = (exposure[cat] ?? 0) + share;
      (contributors[cat] ??= []).push({ node, share });
    };

    const classify = async (address: string, hop: number, paid: string, agg: Agg, weight: number): Promise<TraceNode> => {
      const label = this.deps.label(address);
      const sanctioned = await this.deps.sanctioned(address);
      let frozen: boolean | null = null;
      // labels and the list settle the risky cases without an RPC call
      const settled = sanctioned === true || (label && label.category !== "exchange_licensed" && label.category !== "dex" && label.category !== "protocol");
      if (!settled && freezeReads < this.opts.freezeCheckCap) {
        freezeReads++;
        frozen = await this.deps.frozen(address, token);
      }
      const status = categoryOf(label, sanctioned, frozen);
      const node: TraceNode = {
        address,
        hop,
        paid,
        value: Math.round(agg.value * 1e6) / 1e6,
        count: agg.count,
        txHashes: agg.hashes,
        weight: Math.round(weight * 1e6) / 1e6,
        status,
        ...(label ? { label: { name: label.name, category: label.category, ...(label.jurisdiction ? { jurisdiction: label.jurisdiction } : {}) } } : {}),
        sanctioned,
        frozen,
      };
      nodes.push(node);
      return node;
    };

    // hop 1
    const h1 = aggregate(hop1, new Set([me]), fam);
    const inboundTotal = h1.total;
    if (depth === 0 || inboundTotal === 0) {
      const detail = depth === 0 ? "trace depth 0: exposure not evaluated" : "no inbound transfers in the window: nothing to trace";
      return {
        depthRequested: depth,
        depthReached: 0,
        nodes,
        exposure,
        untraced: 0,
        boundary: 0,
        dusted: 0,
        inboundTotal,
        evidence: [],
        coverage: { source: "fund-flow", status: depth === 0 ? "disabled" : "ok", detail },
      };
    }
    const live1 = h1.rows.filter((r) => r.value >= this.opts.dustFloor);
    dusted = (inboundTotal - live1.reduce((s, r) => s + r.value, 0)) / inboundTotal;
    const kept1 = live1.slice(0, this.opts.fanOut);
    untraced += live1.slice(this.opts.fanOut).reduce((s, r) => s + r.value, 0) / inboundTotal;
    depthReached = 1;

    const hop1Nodes: TraceNode[] = [];
    for (const r of kept1) {
      const weight = r.value / inboundTotal;
      const n = await classify(r.address, 1, sender, r, weight);
      hop1Nodes.push(n);
      if (n.status === "licensed_vasp") {
        boundary += weight;
        n.expanded = "not_needed";
      } else if (n.status === "unlabelled" || n.status === "internal") {
        n.expanded = depth >= 2 ? "beyond_cap" : "not_needed";
      } else {
        add(n.status, n, weight * HOP_DECAY[1]);
        n.expanded = "not_needed";
      }
    }

    // hop 2 (and 3 only by the same rule; v1 stops at 2 unless asked)
    if (depth >= 2) {
      const expandCap = this.opts.expandCap ?? this.opts.fanOut;
      const seen = new Set<string>([me, ...hop1Nodes.map((n) => norm(n.address))]);
      const toExpand = hop1Nodes.filter((n) => n.status === "unlabelled").slice(0, expandCap);
      for (const n of hop1Nodes.filter((x) => x.status === "unlabelled").slice(expandCap)) untraced += n.weight;
      for (const parent of toExpand) {
        let res: InboundTransfersResult;
        try {
          res = await this.deps.inbound(parent.address, token, window);
        } catch (e) {
          res = { status: "unavailable", transfers: [], truncated: false, window: { windowDays: window.windowDays, maxTransfers: window.maxTransfers, fromIso: "" }, detail: e instanceof Error ? e.message : String(e) };
        }
        if (res.status !== "ok") {
          parent.expanded = "no_explorer";
          fetchFailures++;
          untraced += parent.weight;
          continue;
        }
        parent.expanded = "yes";
        depthReached = Math.max(depthReached, 2);
        const h2 = aggregate(res.transfers, new Set([norm(parent.address)]), fam);
        if (h2.total === 0) continue;
        const live2 = h2.rows.filter((r) => r.value >= this.opts.dustFloor);
        const kept2 = live2.slice(0, this.opts.fanOut);
        untraced += (live2.slice(this.opts.fanOut).reduce((s, r) => s + r.value, 0) / h2.total) * parent.weight;
        for (const r of kept2) {
          const w2 = parent.weight * (r.value / h2.total);
          const k = norm(r.address);
          if (seen.has(k)) {
            // the sender or another hop-1 wallet feeding this one: a loop, counted once already
            nodes.push({ address: r.address, hop: 2, paid: parent.address, value: Math.round(r.value * 1e6) / 1e6, count: r.count, txHashes: r.hashes, weight: Math.round(w2 * 1e6) / 1e6, status: "internal", sanctioned: null, frozen: null });
            continue;
          }
          const n = await classify(r.address, 2, parent.address, r, w2);
          if (n.status === "licensed_vasp") boundary += w2;
          else if (n.status !== "unlabelled" && n.status !== "internal") add(n.status, n, w2 * HOP_DECAY[2]);
        }
      }
    }

    // evidence
    const evidence: Evidence[] = [];
    for (const [catKey, raw] of Object.entries(exposure) as [ExposureCategory, number][]) {
      const share = Math.min(1, raw);
      const w = EXPOSURE_WEIGHTS[catKey];
      let points = Math.min(w.cap, Math.round(w.points * share * 10) / 10);
      let floored = false;
      if (share > 0 && DUST_RULE_CATEGORIES.includes(catKey) && points < DUST_FLOOR_POINTS) {
        points = DUST_FLOOR_POINTS;
        floored = true;
      }
      const top = (contributors[catKey] ?? []).sort((a, b) => b.share - a.share).slice(0, 3);
      const minHop = Math.min(...top.map((c) => c.node.hop));
      const who = top
        .map((c) => `${c.node.address}${c.node.label ? ` "${c.node.label.name}"` : ""} at hop ${c.node.hop} (${fmt(c.node.value)} ${token.onChainSymbol}${c.node.txHashes[0] ? `, tx ${c.node.txHashes[0]}` : ""})`)
        .join("; ");
      evidence.push({
        code: `EXPOSURE_${catKey.toUpperCase()}`,
        source: "fund-flow",
        severity: "risk",
        points,
        hop: minHop,
        summary: `${pct(share)} of inbound ${token.onChainSymbol} value (hop-decayed) traces to ${CATEGORY_TEXT[catKey]}: ${who}.${floored ? ` Dust rule: floored to ${DUST_FLOOR_POINTS} points.` : ""}`,
        ...(top[0]?.node.txHashes[0] ? { ref: top[0].node.txHashes[0] } : {}),
        checkedAt,
      });
    }

    const h1Count = hop1Nodes.length;
    const h2Count = nodes.filter((n) => n.hop === 2).length;
    const boundaryCount = nodes.filter((n) => n.status === "licensed_vasp").length;
    const expandedCount = hop1Nodes.filter((n) => n.expanded === "yes").length;
    const untracedR = Math.round(untraced * 1e4) / 1e4;
    const parts = [
      `${depthReached} hop${depthReached === 1 ? "" : "s"} of ${depth}`,
      `${h1Count} counterpart${h1Count === 1 ? "y" : "ies"} at hop 1${depth >= 2 ? `, ${expandedCount} expanded, ${h2Count} at hop 2` : ""}`,
      boundaryCount ? `${boundaryCount} licensed VASP boundar${boundaryCount === 1 ? "y" : "ies"} (${pct(boundary)} of value)` : "",
      untracedR > 0 ? `untraced ${pct(untracedR)}` : "fully traced",
      dusted > 0 ? `dust dropped ${pct(dusted)}` : "",
      fetchFailures ? `${fetchFailures} hop-2 fetch${fetchFailures === 1 ? "" : "es"} failed` : "",
      hop1Truncated ? "hop 1 capped by the explorer window" : "",
    ].filter(Boolean);
    const shallow = depthReached < 2 && hop1Nodes.some((n) => n.status === "unlabelled");
    if (shallow) parts.push("trace depth 1 only");
    const partial = untracedR > 0.2 || fetchFailures > 0 || hop1Truncated || shallow;
    evidence.push({
      code: "FLOW_TRACE",
      source: "fund-flow",
      severity: "info",
      points: 0,
      hop: 0,
      summary: `Backward trace: ${parts.join("; ")}. ${Object.keys(exposure).length === 0 ? "No labelled, frozen or sanctioned counterparty found on the traced paths." : ""}`.trim(),
      checkedAt,
    });

    return {
      depthRequested: depth,
      depthReached,
      nodes,
      exposure: Object.fromEntries(Object.entries(exposure).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6])) as Partial<Record<ExposureCategory, number>>,
      untraced: untracedR,
      boundary: Math.round(boundary * 1e4) / 1e4,
      dusted: Math.round(dusted * 1e4) / 1e4,
      inboundTotal: Math.round(inboundTotal * 1e6) / 1e6,
      evidence,
      coverage: { source: "fund-flow", status: partial ? "partial" : "ok", detail: parts.join("; ") },
    };
  }
}

const CATEGORY_TEXT: Record<ExposureCategory, string> = {
  sanctioned: "an OFAC-sanctioned address",
  frozen: "an address currently frozen by the issuer",
  previously_frozen: "an address previously frozen by the issuer",
  mixer: "a mixer or privacy pool",
  scam: "a scam, phishing or drainer address",
  darknet: "a darknet market",
  gambling: "a gambling service",
  unlicensed_vasp: "an unlicensed VASP",
  bridge_in: "a bridge with unknown origin chain",
  fresh_wallet: "a fresh wallet",
};
