import type { Confidence, Coverage, Evidence, Verdict } from "@cr/shared";

export const SCORING_VERSION = "1.1.0";

export const BANDS: { verdict: Verdict; min: number }[] = [
  { verdict: "BLOCK", min: 80 },
  { verdict: "HIGH", min: 60 },
  { verdict: "CAUTION", min: 40 },
  { verdict: "LOW", min: 20 },
  { verdict: "CLEAR", min: 0 },
];

export function bandFor(score: number): Verdict {
  return BANDS.find((b) => score >= b.min)!.verdict;
}

const ORDER: Verdict[] = ["CLEAR", "LOW", "CAUTION", "HIGH", "BLOCK"];
export function maxVerdict(a: Verdict, b: Verdict): Verdict {
  return ORDER[Math.max(ORDER.indexOf(a), ORDER.indexOf(b))]!;
}

/** Category caps from SCORING.md 2a-2d. Codes map to a cap bucket. */
const CAPS: Record<string, number> = {
  exposure: 85,
  behavioural: 35,
  asset: 30,
  identity: 25,
};

const BUCKET_OF: Record<string, keyof typeof CAPS> = {
  ASSET_BRIDGED: "asset",
  ASSET_OFT_UNCONFIRMED: "asset",
  ASSET_YOUNG_CONTRACT: "asset",
  XCHAIN_FROZEN_ELSEWHERE: "exposure",
  IDENTITY_PEP: "identity",
  IDENTITY_OPAQUE_OWNERSHIP: "identity",
};

export interface ScoreResult {
  score: number;
  verdict: Verdict;
  hardBlock?: string;
  flags: string[];
}

export function computeScore(evidence: Evidence[], opts: { verdictFloor?: Verdict; flags?: string[] } = {}): ScoreResult {
  const flags = [...(opts.flags ?? [])];
  const block = evidence.find((e) => e.severity === "block");
  if (block) {
    const others = evidence.filter((e) => e.severity === "block" && e.code !== block.code).map((e) => e.code);
    if (others.length) flags.push(`ALSO_BLOCKED_BY:${others.join(",")}`);
    return { score: 100, verdict: "BLOCK", hardBlock: block.code, flags };
  }
  const buckets: Record<string, number> = {};
  for (const e of evidence) {
    if (e.severity !== "risk" || e.points <= 0) continue;
    const bucket = BUCKET_OF[e.code] ?? (e.code.startsWith("EXPOSURE_") ? "exposure" : e.code.startsWith("BEHAV_") ? "behavioural" : "exposure");
    buckets[bucket] = (buckets[bucket] ?? 0) + e.points;
  }
  let total = 0;
  for (const [b, v] of Object.entries(buckets)) total += Math.min(v, CAPS[b] ?? v);
  const score = Math.min(95, Math.round(total));
  let verdict = bandFor(score);
  if (opts.verdictFloor) verdict = maxVerdict(verdict, opts.verdictFloor);
  return { score, verdict, flags };
}

/**
 * Confidence from coverage: see SCORING.md.
 * Required sources for "high": issuer-freeze ok, ofac-sdn ok, chainalysis-oracle ok or not_applicable, lists < 36h.
 * Fund-flow "disabled" or "unavailable", behaviour "unavailable" and watchman "unavailable" cap at "medium"; behaviour "partial"
 * (a signal or two not evaluated on a keyless deployment) is stated in the coverage line and does not downgrade.
 */
export function computeConfidence(coverage: Coverage[]): { confidence: Confidence; reasons: string[] } {
  const reasons: string[] = [];
  const get = (s: string) => coverage.find((c) => c.source === s);
  const freeze = get("issuer-freeze");
  const ofac = get("ofac-sdn");
  const oracle = get("chainalysis-oracle");
  const flow = get("fund-flow");

  let level: Confidence = "high";
  const downgrade = (to: Confidence, why: string) => {
    reasons.push(why);
    if (ORDER_C.indexOf(to) < ORDER_C.indexOf(level)) level = to;
  };

  if (!freeze || freeze.status === "unavailable") downgrade("low", "issuer freeze read unavailable");
  else if (freeze.status === "partial") downgrade("medium", "freeze method unconfirmed for this token");
  if (!ofac || ofac.status === "unavailable") downgrade("low", "OFAC list unavailable");
  else {
    if (ofac.status === "partial") downgrade("medium", "OFAC list partially loaded");
    if ((ofac.ageHours ?? 0) > 72) downgrade("low", `OFAC snapshot ${Math.round(ofac.ageHours!)}h old`);
    else if ((ofac.ageHours ?? 0) > 36) downgrade("medium", `OFAC snapshot ${Math.round(ofac.ageHours!)}h old`);
  }
  if (oracle && oracle.status === "unavailable") downgrade("medium", "sanctions oracle unreachable");
  if (!flow || flow.status === "disabled" || flow.status === "unavailable") downgrade("medium", "fund-flow trace not run; exposure and behavioural signals absent");
  else if (flow.status === "partial") downgrade("medium", flow.detail ?? "trace depth or fan-out limited");
  const behaviour = get("behaviour");
  if (behaviour && behaviour.status === "unavailable") downgrade("medium", "behavioural signals not evaluated");
  // only present when an originator was supplied; "disabled" is a deployment choice and is stated, not penalised
  const watchman = get("watchman");
  if (watchman && watchman.status === "unavailable") downgrade("medium", "originator name screening unavailable");

  return { confidence: level, reasons };
}
const ORDER_C: Confidence[] = ["low", "medium", "high"];
