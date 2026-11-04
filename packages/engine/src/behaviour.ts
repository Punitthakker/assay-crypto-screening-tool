import { getChain, normalizeAddress, type Coverage, type Evidence, type TokenDef } from "@cr/shared";
import type { Activity, ApprovalsResult, Label, Transfer } from "@cr/datasources";

/**
 * Behavioural signals about the sender itself (SCORING.md 2b). Nothing here blocks.
 *
 * Inputs are what the engine already holds (inbound transfers of the screened token,
 * labels) plus two cheap extras: the sender's outbound transfers and its account
 * activity (age, tx count, recent timestamps, contract status, approvals). Each signal
 * states what it saw; a signal whose input is missing is listed as not evaluated in
 * the coverage line rather than silently scored 0.
 *
 * Suppressed for a sender labelled as a licensed exchange (worked example 2): a hot
 * wallet is fresh, busy and concentrated by design.
 */

export const BEHAV_WEIGHTS = {
  BEHAV_FRESH_WALLET: 10,
  BEHAV_LOW_TX_COUNT: 6,
  BEHAV_DORMANT_REACTIVATED: 8,
  BEHAV_PASS_THROUGH: 15,
  BEHAV_STRUCTURING: 12,
  BEHAV_CONCENTRATION: 6,
  BEHAV_CONTRACT_ADMIN: 10,
  BEHAV_DRAINER_APPROVAL: 12,
} as const;
export type BehavCode = keyof typeof BEHAV_WEIGHTS;
export const BEHAV_CAP = 35;

export interface BehaviourOptions {
  /** wallet younger than this is fresh */
  freshDays: number;
  /** fewer transactions than this is low */
  lowTxCount: number;
  /** quiet for at least this long ... */
  dormantDays: number;
  /** ... then active within this many days */
  reactivatedDays: number;
  /** median in-to-out dwell under this (seconds) over the last N outbound transfers */
  passThroughSeconds: number;
  passThroughSample: number;
  passThroughMinPairs: number;
  /** structuring: at least this many transfers in the lookback, each inside the band below a threshold */
  structuringCount: number;
  structuringDays: number;
  structuringBand: number;
  /** USD-equivalent reporting thresholds; stablecoin units are taken as USD */
  structuringThresholds: number[];
  /** share of inbound value from one unlabelled counterparty */
  concentrationShare: number;
  concentrationMinCounterparties: number;
}

export const DEFAULT_BEHAVIOUR: BehaviourOptions = {
  freshDays: 7,
  lowTxCount: 5,
  dormantDays: 180,
  reactivatedDays: 7,
  passThroughSeconds: 600,
  passThroughSample: 20,
  passThroughMinPairs: 5,
  structuringCount: 5,
  structuringDays: 30,
  structuringBand: 0.05,
  structuringThresholds: [1000, 3000, 953, 10000],
  concentrationShare: 0.7,
  concentrationMinCounterparties: 2,
};

export interface BehaviourInput {
  sender: string;
  token: TokenDef;
  nowMs: number;
  inbound: Transfer[];
  /** null when the outbound fetch failed */
  outbound: Transfer[] | null;
  activity: Activity | null;
  approvals: ApprovalsResult | null;
  label: (address: string) => Label | undefined;
  senderLabel?: Label | undefined;
}

export interface BehaviourResult {
  evidence: Evidence[];
  coverage: Coverage;
  /** signals that could not be evaluated, with the reason */
  notEvaluated: Record<string, string>;
  facts: {
    walletAgeDays: number | null;
    txCount: number | null;
    passThroughMedianSeconds: number | null;
    passThroughPairs: number;
    topCounterpartyShare: number | null;
    structuringHits: { threshold: number; count: number } | null;
  };
}

const DAY = 86_400;
const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (x: number) => `${(x * 100).toFixed(x * 100 >= 10 ? 0 : 1)}%`;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Dwell time between each of the latest `sample` outbound transfers and the nearest earlier inbound. */
export function passThroughPairs(inbound: Transfer[], outbound: Transfer[], sample: number): number[] {
  const ins = [...inbound].sort((a, b) => a.timestamp - b.timestamp);
  const outs = [...outbound].sort((a, b) => b.timestamp - a.timestamp).slice(0, sample);
  const dwell: number[] = [];
  for (const o of outs) {
    let best: Transfer | undefined;
    for (const i of ins) {
      if (i.timestamp <= o.timestamp) best = i;
      else break;
    }
    if (best) dwell.push(o.timestamp - best.timestamp);
  }
  return dwell;
}

export function structuringHits(transfers: Transfer[], opts: BehaviourOptions, nowS: number): { threshold: number; count: number; hashes: string[] } | null {
  const since = nowS - opts.structuringDays * DAY;
  const recent = transfers.filter((t) => t.timestamp >= since);
  let best: { threshold: number; count: number; hashes: string[] } | null = null;
  for (const th of opts.structuringThresholds) {
    const lo = th * (1 - opts.structuringBand);
    const hits = recent.filter((t) => t.value >= lo && t.value < th);
    if (hits.length >= opts.structuringCount && (!best || hits.length > best.count)) {
      best = { threshold: th, count: hits.length, hashes: hits.slice(0, 5).map((t) => t.txHash) };
    }
  }
  return best;
}

export function analyseBehaviour(input: BehaviourInput, opts: BehaviourOptions = DEFAULT_BEHAVIOUR): BehaviourResult {
  const checkedAt = new Date().toISOString();
  const nowS = Math.floor(input.nowMs / 1000);
  const fam = getChain(input.token.chain).family;
  const sym = input.token.onChainSymbol;
  const evidence: Evidence[] = [];
  const notEvaluated: Record<string, string> = {};
  const facts: BehaviourResult["facts"] = { walletAgeDays: null, txCount: null, passThroughMedianSeconds: null, passThroughPairs: 0, topCounterpartyShare: null, structuringHits: null };
  const add = (code: BehavCode, summary: string, ref?: string) =>
    evidence.push({ code, source: "behaviour", severity: "risk", points: BEHAV_WEIGHTS[code], hop: 0, summary, ...(ref ? { ref } : {}), checkedAt });

  if (input.senderLabel?.category === "exchange_licensed") {
    return {
      evidence,
      coverage: { source: "behaviour", status: "not_applicable", detail: `sender is a licensed VASP wallet (${input.senderLabel.name}); behavioural signals suppressed` },
      notEvaluated,
      facts,
    };
  }

  const act = input.activity;

  // 1. wallet age
  if (act?.firstSeen !== null && act?.firstSeen !== undefined) {
    const ageDays = (nowS - act.firstSeen) / DAY;
    facts.walletAgeDays = Math.max(0, ageDays);
    if (ageDays < opts.freshDays) add("BEHAV_FRESH_WALLET", `Sender wallet is ${ageDays < 1 ? "under a day" : `${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? "" : "s"}`} old (first transaction ${new Date(act.firstSeen * 1000).toISOString().slice(0, 10)})`);
  } else notEvaluated.BEHAV_FRESH_WALLET = act ? "first transaction date not available from any configured source" : "activity not fetched";

  // 2. transaction count
  if (act?.txCount !== null && act?.txCount !== undefined) {
    facts.txCount = act.txCount;
    if (act.txCount < opts.lowTxCount) add("BEHAV_LOW_TX_COUNT", `Sender has ${act.txCount} ${act.txCountBasis === "nonce" ? "outbound transaction" : "transaction"}${act.txCount === 1 ? "" : "s"} on ${getChain(input.token.chain).name}`);
  } else notEvaluated.BEHAV_LOW_TX_COUNT = act ? "transaction count not available from any configured source" : "activity not fetched";

  // 3. dormancy then reactivation: needs the two latest transactions
  if (act && act.recentTimestamps.length >= 2) {
    const [latest, previous] = act.recentTimestamps as [number, number];
    const quietDays = (latest - previous) / DAY;
    if (nowS - latest <= opts.reactivatedDays * DAY && quietDays >= opts.dormantDays) {
      add("BEHAV_DORMANT_REACTIVATED", `Sender was quiet for ${Math.floor(quietDays)} days (${new Date(previous * 1000).toISOString().slice(0, 10)} to ${new Date(latest * 1000).toISOString().slice(0, 10)}) and became active in the last ${opts.reactivatedDays} days`);
    }
  } else if (act && act.recentTimestamps.length === 1 && act.firstSeen !== null && act.lastSeen !== null && act.firstSeen < act.lastSeen) {
    // Tron: only first and latest operation times are known
    const quietDays = (act.lastSeen - act.firstSeen) / DAY;
    if (act.txCount !== null && act.txCount <= 2 && nowS - act.lastSeen <= opts.reactivatedDays * DAY && quietDays >= opts.dormantDays) {
      add("BEHAV_DORMANT_REACTIVATED", `Sender was created ${Math.floor(quietDays)} days before its latest activity and has ${act.txCount} transactions; active in the last ${opts.reactivatedDays} days`);
    }
  } else notEvaluated.BEHAV_DORMANT_REACTIVATED = act ? "recent transaction timestamps not available" : "activity not fetched";

  // 4. pass-through speed
  if (input.outbound) {
    const dwell = passThroughPairs(input.inbound, input.outbound, opts.passThroughSample);
    facts.passThroughPairs = dwell.length;
    if (dwell.length >= opts.passThroughMinPairs) {
      const med = median(dwell);
      facts.passThroughMedianSeconds = med;
      if (med < opts.passThroughSeconds) {
        const latestOut = [...input.outbound].sort((a, b) => b.timestamp - a.timestamp)[0];
        add("BEHAV_PASS_THROUGH", `Median hold between an inbound ${sym} transfer and the next outbound is ${Math.round(med / 60)} min over ${dwell.length} outbound transfers (mule pattern)`, latestOut?.txHash);
      }
    }
  } else notEvaluated.BEHAV_PASS_THROUGH = "outbound transfers not fetched";

  // 5. structuring under reporting thresholds
  {
    const all = input.outbound ? [...input.inbound, ...input.outbound] : input.inbound;
    const hit = structuringHits(all, opts, nowS);
    if (hit) {
      facts.structuringHits = { threshold: hit.threshold, count: hit.count };
      add("BEHAV_STRUCTURING", `${hit.count} ${sym} transfers in ${opts.structuringDays} days each within ${pct(opts.structuringBand)} below ${fmt(hit.threshold)} (structuring pattern)`, hit.hashes[0]);
    }
    if (!input.outbound) notEvaluated.BEHAV_STRUCTURING = "outbound transfers not fetched; inbound side only";
  }

  // 6. counterparty concentration
  {
    const m = new Map<string, { address: string; value: number }>();
    let total = 0;
    for (const t of input.inbound) {
      const k = normalizeAddress(t.from, fam);
      const a = m.get(k) ?? { address: t.from, value: 0 };
      a.value += t.value;
      total += t.value;
      m.set(k, a);
    }
    const top = [...m.values()].sort((a, b) => b.value - a.value)[0];
    if (top && total > 0) {
      const share = top.value / total;
      facts.topCounterpartyShare = share;
      if (m.size >= opts.concentrationMinCounterparties && share > opts.concentrationShare && !input.label(top.address)) {
        add("BEHAV_CONCENTRATION", `${pct(share)} of inbound ${sym} value (${fmt(top.value)}) came from one unlabelled counterparty ${top.address}`, top.address);
      }
    }
  }

  // 7. unverified contract with an upgrade admin
  if (act?.isContract === true) {
    const c = act.contract;
    if (c && c.verified === false && c.upgradeable === true) {
      add("BEHAV_CONTRACT_ADMIN", `Sender is an unverified contract with ${c.admin ? `owner ${c.admin}` : "a proxy admin"}${c.implementation ? ` (implementation ${c.implementation})` : ""}: its behaviour can change at any time`, c.admin ?? c.implementation);
    } else if (!c || c.verified === null) notEvaluated.BEHAV_CONTRACT_ADMIN = "sender is a contract but source verification could not be checked (needs ETHERSCAN_API_KEY or a Blockscout host)";
  } else if (act?.isContract === null || !act) notEvaluated.BEHAV_CONTRACT_ADMIN = act ? "contract status unknown" : "activity not fetched";

  // 8. approvals granted to a labelled drainer or scam contract
  if (input.approvals?.status === "ok") {
    const bad = input.approvals.approvals.map((ap) => ({ ap, label: input.label(ap.spender) })).filter((x) => x.label && (x.label.category === "scam" || x.label.category === "darknet"));
    if (bad.length) {
      const first = bad[0]!;
      add("BEHAV_DRAINER_APPROVAL", `Sender approved ${bad.length === 1 ? "a" : `${bad.length}`} labelled ${first.label!.category} contract${bad.length === 1 ? "" : "s"} to spend its ${sym} (${first.label!.name}); the wallet may be compromised`, first.ap.txHash ?? first.ap.spender);
    }
  } else if (input.approvals?.status === "not_applicable") notEvaluated.BEHAV_DRAINER_APPROVAL = input.approvals.detail;
  else notEvaluated.BEHAV_DRAINER_APPROVAL = input.approvals?.detail ?? "approvals not fetched";

  const skipped = Object.keys(notEvaluated);
  const status: Coverage["status"] = !act && !input.outbound ? "unavailable" : skipped.length ? "partial" : "ok";
  const detail =
    status === "unavailable"
      ? `activity and outbound transfers unavailable: ${act?.errors.join("; ") || "not fetched"}`
      : `${evidence.length} signal${evidence.length === 1 ? "" : "s"} fired` +
        (skipped.length ? `; not evaluated: ${skipped.map((k) => `${k} (${notEvaluated[k]})`).join(", ")}` : "") +
        (act?.providers.length ? ` via ${[...new Set(act.providers)].join(", ")}` : "");
  return { evidence, coverage: { source: "behaviour", status, detail }, notEvaluated, facts };
}
