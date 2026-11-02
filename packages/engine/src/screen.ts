import { createHash, randomUUID } from "node:crypto";
import {
  DISCLAIMER,
  ScreenRequestSchema,
  canonicalToken,
  detectFamily,
  getChain,
  tokenByAddress,
  tokensFor,
  type Coverage,
  type Evidence,
  type Report,
  type ScreenRequest,
  type TokenDef,
  type Verdict,
} from "@cr/shared";
import {
  ExplorerRouter,
  IssuerFreezeAdapter,
  LabelStore,
  OfacAdapter,
  SanctionsOracleAdapter,
  defaultWindow,
  type AdapterResult,
  type Transport,
} from "@cr/datasources";
import { SCORING_VERSION, computeConfidence, computeScore } from "./score.js";

export interface EngineOptions {
  transport: Transport;
  labels?: LabelStore;
  /** USD equivalent of the Travel Rule threshold; default AED 3,500 */
  travelRuleThresholdUsd?: number;
  env?: NodeJS.ProcessEnv;
  /** explorer router for inbound transfers; false disables the fetch (unit tests, air-gapped runs) */
  explorer?: ExplorerRouter | false;
  /** trace window; defaults to 90 days or 200 transfers */
  window?: { windowDays?: number; maxTransfers?: number };
}

export class Engine {
  private ofac: OfacAdapter;
  private freeze: IssuerFreezeAdapter;
  private oracle: SanctionsOracleAdapter;
  private labels: LabelStore;
  private threshold: number;
  private explorer: ExplorerRouter | undefined;

  constructor(private opts: EngineOptions) {
    this.ofac = new OfacAdapter(opts.transport);
    this.freeze = new IssuerFreezeAdapter(opts.transport);
    this.oracle = new SanctionsOracleAdapter(opts.transport);
    this.labels = opts.labels ?? new LabelStore();
    this.threshold = opts.travelRuleThresholdUsd ?? Number(opts.env?.CR_TRAVEL_RULE_THRESHOLD_USD ?? 953);
    this.explorer = opts.explorer === false ? undefined : (opts.explorer ?? new ExplorerRouter(opts.transport, opts.env ?? process.env));
  }

  async screen(input: unknown): Promise<Report> {
    const req: ScreenRequest = ScreenRequestSchema.parse(input);
    const chain = getChain(req.chain);
    const checkedAt = new Date().toISOString();
    const evidence: Evidence[] = [];
    const coverage: Coverage[] = [];
    const flags: string[] = [];
    let verdictFloor: Verdict | undefined;

    // 0. address / chain sanity
    const fam = detectFamily(req.address);
    if (!fam) throw new Error(`"${req.address}" is not a recognised address format`);
    if (fam !== chain.family) throw new Error(`Address format is ${fam} but chain ${chain.id} is ${chain.family}. Screen on the chain the funds move on.`);

    // 1. resolve token
    const { token, authenticity } = this.resolveToken(req, checkedAt);
    if (authenticity) evidence.push(authenticity);

    // 2. hard-block sources in parallel
    const [freezeR, ofacR, oracleR] = await Promise.all([
      token ? this.freeze.screen(req.address, token) : Promise.resolve<AdapterResult | undefined>(undefined),
      this.ofac.screen(req.address, req.chain),
      this.oracle.screen(req.address, req.chain),
    ]);
    for (const r of [freezeR, ofacR, oracleR]) {
      if (!r) continue;
      evidence.push(...r.evidence);
      coverage.push(r.coverage);
    }
    // sanctions sources disagreement
    const listHit = ofacR.facts?.sanctioned === true;
    const oracleHit = oracleR.facts?.sanctioned === true;
    if (oracleR.facts?.sanctioned !== null && oracleR.coverage.status === "ok" && listHit !== oracleHit) {
      flags.push("SANCTIONS_SOURCE_DISCREPANCY");
    }

    // 3. sender attribution (Phase 1a: local labels only)
    const label = this.labels.lookup(req.address, req.chain);
    if (label) {
      const sev = label.category === "sanctioned" ? "block" : ["mixer", "scam", "darknet"].includes(label.category) ? "risk" : "info";
      const pts = label.category === "mixer" ? 55 : label.category === "scam" || label.category === "darknet" ? 50 : label.category === "gambling" ? 15 : label.category === "exchange_unlicensed" ? 20 : 0;
      evidence.push({
        code: sev === "block" ? "HB_SANCTIONED_LABEL" : sev === "risk" ? `EXPOSURE_DIRECT_${label.category.toUpperCase()}` : `LABEL_${label.category.toUpperCase()}`,
        source: `labels:${label.source}`,
        severity: sev,
        points: sev === "block" ? 100 : pts,
        hop: 0,
        summary: `Sender is labelled "${label.name}" (${label.category}${label.jurisdiction ? `, ${label.jurisdiction}` : ""}${label.licence ? `, ${label.licence}` : ""})`,
        checkedAt,
      });
      if (label.category === "exchange_licensed") flags.push("SENDER_IS_LICENSED_VASP");
    }
    coverage.push({ source: "labels", status: this.labels.size > 0 ? "ok" : "partial", detail: `${this.labels.size} labels loaded` });

    // 4. inbound transfers of the screened token (explorer adapters). The trace that scores them is the next item;
    //    until it lands, fund-flow stays declared as disabled and confidence stays capped at medium.
    if (this.explorer && token) {
      const w = this.opts.window ?? {};
      const ex = await this.explorer.screen(req.address, token, defaultWindow({ ...(w.windowDays !== undefined ? { windowDays: w.windowDays } : {}), ...(w.maxTransfers !== undefined ? { maxTransfers: w.maxTransfers } : {}) }));
      evidence.push(...ex.evidence);
      coverage.push(ex.coverage);
    }
    coverage.push({ source: "fund-flow", status: "disabled", detail: "2-hop trace lands next; exposure and behavioural signals not evaluated" });

    // 5. identity layer
    let identity: Report["identity"] = "unverified";
    if (req.originator) {
      identity = "attested";
      coverage.push({ source: "watchman", status: "disabled", detail: "name screening lands in Phase 1b" });
    }
    if (req.direction === "inbound" && req.amount !== undefined && req.amount >= this.threshold && !req.originator) {
      verdictFloor = "CAUTION";
      flags.push("TRAVEL_RULE_DATA_REQUIRED");
      evidence.push({
        code: "IDENTITY_TRAVEL_RULE_GAP",
        source: "policy",
        severity: "info",
        points: 0,
        hop: 0,
        summary: `Amount ${req.amount} ${req.asset} is at or above the Travel Rule threshold (USD ${this.threshold} eq.) and no originator data was supplied. Verdict floored at CAUTION.`,
        checkedAt,
      });
    }

    // 6. score + confidence
    const s = computeScore(evidence, verdictFloor ? { verdictFloor, flags } : { flags });
    const c = computeConfidence(coverage);
    if (c.confidence !== "high") flags.push(`CONFIDENCE_${c.confidence.toUpperCase()}:${c.reasons.join("; ")}`);

    const report: Omit<Report, "reportHash"> = {
      reportId: randomUUID(),
      scoringVersion: SCORING_VERSION,
      checkedAt,
      request: req,
      ...(token
        ? { resolvedToken: { address: token.address, onChainSymbol: token.onChainSymbol, issuer: token.issuer, kind: token.kind, ...(token.note ? { note: token.note } : {}) } }
        : {}),
      score: s.score,
      verdict: s.verdict,
      confidence: c.confidence,
      ...(s.hardBlock ? { hardBlock: s.hardBlock } : {}),
      flags: s.flags,
      identity,
      evidence: evidence.sort((a, b) => sevRank(a) - sevRank(b) || b.points - a.points),
      coverage,
      disclaimer: DISCLAIMER,
    };
    const reportHash = createHash("sha256").update(JSON.stringify(report)).digest("hex");
    return { ...report, reportHash };
  }

  private resolveToken(req: ScreenRequest, checkedAt: string): { token?: TokenDef; authenticity?: Evidence } {
    if (req.tokenContract) {
      const t = tokenByAddress(req.chain, req.tokenContract);
      if (!t) {
        return {
          authenticity: {
            code: "HB_FAKE_TOKEN",
            source: "registry",
            severity: "block",
            points: 100,
            hop: 0,
            summary: `Token contract ${req.tokenContract} is not a known ${req.asset} deployment on ${req.chain}. Likely a look-alike token.`,
            ref: req.tokenContract,
            checkedAt,
          },
        };
      }
      if (t.symbol !== req.asset) {
        return {
          token: t,
          authenticity: {
            code: "HB_FAKE_TOKEN",
            source: "registry",
            severity: "block",
            points: 100,
            hop: 0,
            summary: `Contract ${req.tokenContract} is ${t.onChainSymbol}, not ${req.asset}.`,
            ref: req.tokenContract,
            checkedAt,
          },
        };
      }
      return { token: t };
    }
    const canon = canonicalToken(req.chain, req.asset);
    if (canon) return { token: canon };
    const bridged = tokensFor(req.chain, req.asset)[0];
    if (bridged) return { token: bridged };
    return {
      authenticity: {
        code: "ASSET_NOT_IN_REGISTRY",
        source: "registry",
        severity: "risk",
        points: 15,
        hop: 0,
        summary: `${req.asset} has no known deployment on ${req.chain} in the registry.`,
        checkedAt,
      },
    };
  }
}

function sevRank(e: Evidence) {
  return e.severity === "block" ? 0 : e.severity === "risk" ? 1 : 2;
}
