import { createHash, randomUUID } from "node:crypto";
import {
  DISCLAIMER,
  ScreenRequestSchema,
  canonicalToken,
  detectFamily,
  getChain,
  normalizeAddress,
  tokenByAddress,
  tokensFor,
  type ChainId,
  type Coverage,
  type Evidence,
  type Report,
  type ScreenRequest,
  type TokenDef,
  type Verdict,
} from "@cr/shared";
import {
  ActivityAdapter,
  ExplorerRouter,
  FreezeIndex,
  IssuerFreezeAdapter,
  LabelStore,
  OfacAdapter,
  SanctionsOracleAdapter,
  defaultWindow,
  type AdapterResult,
  type Transfer,
  type Transport,
} from "@cr/datasources";
import { SCORING_VERSION, computeConfidence, computeScore } from "./score.js";
import { Tracer, traceOptionsFromEnv, type TraceDeps, type TraceOptions, type TraceResult } from "./trace.js";
import { DEFAULT_BEHAVIOUR, analyseBehaviour, type BehaviourOptions, type BehaviourResult } from "./behaviour.js";

export interface EngineOptions {
  transport: Transport;
  labels?: LabelStore;
  /** USD equivalent of the Travel Rule threshold; default AED 3,500 */
  travelRuleThresholdUsd?: number;
  env?: NodeJS.ProcessEnv;
  /** explorer router for inbound transfers; false disables the fetch (unit tests, air-gapped runs) */
  explorer?: ExplorerRouter | false;
  /** trace window; defaults to 90 days or 200 transfers. nowMs pins the clock for fixtures. */
  window?: { windowDays?: number; maxTransfers?: number; nowMs?: number };
  /** backward trace settings; defaults from env (CR_TRACE_DEPTH, CR_TRACE_FANOUT, CR_TRACE_DUST, CR_TRACE_FREEZE_CAP, CR_TRACE_EXPAND_CAP) */
  trace?: Partial<TraceOptions>;
  /** behavioural signal thresholds; false skips the activity and outbound fetches (CR_BEHAVIOUR=0 does the same) */
  behaviour?: Partial<BehaviourOptions> | false;
  /** historic freeze event index (data/freeze-index by default, built by pnpm index:freeze); false switches "previously frozen" off */
  freezeIndex?: FreezeIndex | false;
}

export class Engine {
  private ofac: OfacAdapter;
  private freeze: IssuerFreezeAdapter;
  private oracle: SanctionsOracleAdapter;
  private labels: LabelStore;
  private threshold: number;
  private explorer: ExplorerRouter | undefined;
  private traceOpts: TraceOptions;
  private activity: ActivityAdapter;
  private behaviourOpts: BehaviourOptions | false;
  private freezeIndex: FreezeIndex | undefined;

  constructor(private opts: EngineOptions) {
    this.ofac = new OfacAdapter(opts.transport);
    this.freeze = new IssuerFreezeAdapter(opts.transport);
    this.oracle = new SanctionsOracleAdapter(opts.transport);
    this.labels = opts.labels ?? new LabelStore();
    this.threshold = opts.travelRuleThresholdUsd ?? Number(opts.env?.CR_TRAVEL_RULE_THRESHOLD_USD ?? 953);
    this.explorer = opts.explorer === false ? undefined : (opts.explorer ?? new ExplorerRouter(opts.transport, opts.env ?? process.env));
    this.traceOpts = traceOptionsFromEnv(opts.env ?? process.env, opts.trace ?? {});
    this.activity = new ActivityAdapter(opts.transport, opts.env ?? process.env);
    const env = opts.env ?? process.env;
    this.behaviourOpts = opts.behaviour === false || env.CR_BEHAVIOUR === "0" ? false : { ...DEFAULT_BEHAVIOUR, structuringThresholds: [...new Set([1000, 3000, this.threshold, 10000])], ...(opts.behaviour ?? {}) };
    this.freezeIndex = opts.freezeIndex === false || env.CR_FREEZE_INDEX === "0" ? undefined : (opts.freezeIndex ?? new FreezeIndex(env.CR_FREEZE_INDEX_DIR ? { dir: env.CR_FREEZE_INDEX_DIR } : {}));
  }

  /** Real adapters behind the tracer: explorer for hop 2, labels, the OFAC set, issuer freeze reads. */
  private traceDeps(chain: ChainId): TraceDeps {
    const fam = getChain(chain).family;
    let ofacSet: Promise<Set<string> | null> | undefined;
    return {
      inbound: (address, token, window) => this.explorer!.inboundTransfers(address, token, window),
      label: (address) => this.labels.lookup(address, chain),
      sanctioned: async (address) => {
        ofacSet ??= this.ofac.setFor(chain).then((r) => r.set).catch(() => null);
        const set = await ofacSet;
        return set ? set.has(normalizeAddress(address, fam)) : null;
      },
      frozen: async (address, token) => {
        const r = await this.freeze.screen(address, token);
        return typeof r.facts?.frozen === "boolean" ? r.facts.frozen : null;
      },
      history: (address, token) => this.freezeIndex?.history(address, token) ?? null,
    };
  }

  /**
   * The sender's own freeze history (SCORING.md 2a, "previously frozen" at hop 0). A currently
   * frozen sender is already a hard block; this only speaks when the live read says not frozen
   * (previously frozen, 20 points) or could not answer while the index still lists it (flag only,
   * no points: the index may be a day behind the chain).
   */
  private senderFreezeHistory(address: string, token: TokenDef, frozenNow: boolean | null, checkedAt: string): { evidence: Evidence[]; coverage: Coverage; flags: string[] } {
    const src = "freeze-index";
    if (!this.freezeIndex) return { evidence: [], coverage: { source: src, status: "disabled", detail: "freeze event index switched off" }, flags: [] };
    const cov = this.freezeIndex.coverage(token);
    if (!cov.indexed) {
      const applicable = cov.reason?.startsWith("no freeze index");
      return { evidence: [], coverage: { source: src, status: applicable ? "unavailable" : "not_applicable", detail: cov.reason ?? "" }, flags: [] };
    }
    const coverage: Coverage = { source: src, status: "ok", detail: `${cov.events} events via ${cov.provider}, updated ${cov.updatedAt}`, ...(cov.ageHours !== undefined ? { ageHours: cov.ageHours } : {}) };
    const h = this.freezeIndex.history(address, token);
    if (!h || !h.everFrozen || frozenNow === true) return { evidence: [], coverage, flags: [] };
    const when = (t: number) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : "unknown date");
    const last = h.events[h.events.length - 1];
    const destroyed = h.destroyed ? `; ${h.destroyed} DestroyedBlackFunds event${h.destroyed === 1 ? "" : "s"} (${(Number(h.destroyedBase) / 10 ** token.decimals).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${token.onChainSymbol} burned)` : "";
    if (frozenNow === false || (frozenNow === null && !h.listedPerIndex)) {
      return {
        evidence: [
          {
            code: "EXPOSURE_DIRECT_PREVIOUSLY_FROZEN",
            source: src,
            severity: "risk",
            points: 20,
            hop: 0,
            summary: `Sender was blacklisted by ${token.issuer} for ${token.onChainSymbol} on ${token.chain} on ${when(h.firstFrozenAt)} and released on ${when(h.releasedAt ?? 0)} (${h.added} add, ${h.removed} remove${destroyed}). Not frozen now.`,
            ...(last ? { ref: last.txHash } : {}),
            checkedAt,
          },
        ],
        coverage,
        flags: [],
      };
    }
    // live read unavailable, index says still listed
    return {
      evidence: [
        {
          code: "FREEZE_LISTED_PER_INDEX",
          source: src,
          severity: "info",
          points: 0,
          hop: 0,
          summary: `Issuer freeze read failed, but the local freeze index last saw ${token.issuer} blacklist this address on ${when(h.firstFrozenAt)} with no later removal (index updated ${h.indexUpdatedAt.slice(0, 10)}). Treat as frozen until the live read answers.`,
          ...(last ? { ref: last.txHash } : {}),
          checkedAt,
        },
      ],
      coverage,
      flags: ["FREEZE_INDEX_SAYS_LISTED"],
    };
  }

  async screen(input: unknown): Promise<Report> {
    return (await this.screenWithFlow(input)).report;
  }

  /** Same as screen() but also hands back the sender's inbound transfers for source listing. */
  async screenWithFlow(input: unknown): Promise<{ report: Report; transfers: Transfer[]; token?: TokenDef; trace?: TraceResult; behaviour?: BehaviourResult }> {
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
    // 2b. the sender's own freeze history from the local index
    if (token) {
      const fh = this.senderFreezeHistory(req.address, token, typeof freezeR?.facts?.frozen === "boolean" ? freezeR.facts.frozen : null, checkedAt);
      evidence.push(...fh.evidence);
      coverage.push(fh.coverage);
      flags.push(...fh.flags);
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

    // 4. inbound transfers of the screened token (explorer adapters), then the backward trace that scores them.
    //    A hard-blocked sender is not traced: the verdict is settled and the calls would be wasted.
    let transfers: Transfer[] = [];
    let trace: TraceResult | undefined;
    let behaviour: BehaviourResult | undefined;
    if (this.explorer && token) {
      const w = this.opts.window ?? {};
      const window = defaultWindow({ ...(w.windowDays !== undefined ? { windowDays: w.windowDays } : {}), ...(w.maxTransfers !== undefined ? { maxTransfers: w.maxTransfers } : {}), ...(w.nowMs !== undefined ? { nowMs: w.nowMs } : {}) });
      const ex = await this.explorer.screen(req.address, token, window);
      evidence.push(...ex.evidence);
      coverage.push(ex.coverage);
      transfers = ex.transfers;
      const blocked = evidence.some((e) => e.severity === "block");
      const depth = req.traceDepth ?? this.traceOpts.depth;
      if (blocked) {
        coverage.push({ source: "fund-flow", status: "not_applicable", detail: "sender is hard-blocked; trace skipped" });
      } else if (ex.coverage.status === "unavailable") {
        coverage.push({ source: "fund-flow", status: "unavailable", detail: `inbound transfers unavailable, exposure not evaluated: ${ex.coverage.detail ?? ""}`.trim() });
      } else {
        // the trace and the behavioural fetches (outbound transfers, account activity, approvals) run side by side
        const tracer = new Tracer(this.traceDeps(token.chain), { ...this.traceOpts, depth });
        const [t, b] = await Promise.all([
          tracer.trace(req.address, token, transfers, window, ex.facts?.truncated === true),
          this.behaviourOpts ? this.behaviour(req.address, token, transfers, window.nowMs, label, this.behaviourOpts) : Promise.resolve(undefined),
        ]);
        trace = t;
        evidence.push(...trace.evidence);
        coverage.push(trace.coverage);
        if (b) {
          behaviour = b;
          evidence.push(...b.evidence);
          coverage.push(b.coverage);
        } else coverage.push({ source: "behaviour", status: "disabled", detail: "behavioural signals switched off" });
      }
      if (!behaviour && !coverage.some((c) => c.source === "behaviour")) {
        coverage.push({ source: "behaviour", status: blocked ? "not_applicable" : "unavailable", detail: blocked ? "sender is hard-blocked; behavioural signals skipped" : "inbound transfers unavailable; behavioural signals not evaluated" });
      }
    } else {
      coverage.push({ source: "fund-flow", status: "disabled", detail: token ? "explorer fetch switched off; exposure not evaluated" : "token not resolved; exposure not evaluated" });
      coverage.push({ source: "behaviour", status: "disabled", detail: "explorer fetch switched off; behavioural signals not evaluated" });
    }

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
    // confidence first: computeScore copies the flags, so the CONFIDENCE_* flag must exist before the copy
    const c = computeConfidence(coverage);
    if (c.confidence !== "high") flags.push(`CONFIDENCE_${c.confidence.toUpperCase()}:${c.reasons.join("; ")}`);
    const s = computeScore(evidence, verdictFloor ? { verdictFloor, flags } : { flags });

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
    return { report: { ...report, reportHash }, transfers, ...(token ? { token } : {}), ...(trace ? { trace } : {}), ...(behaviour ? { behaviour } : {}) };
  }

  /** Outbound transfers, account activity and approvals for the sender, then the 2b signals. Never throws. */
  private async behaviour(address: string, token: TokenDef, inbound: Transfer[], nowMs: number, senderLabel: ReturnType<LabelStore["lookup"]>, opts: BehaviourOptions): Promise<BehaviourResult> {
    const w = this.opts.window ?? {};
    const window = defaultWindow({ ...(w.windowDays !== undefined ? { windowDays: w.windowDays } : {}), ...(w.maxTransfers !== undefined ? { maxTransfers: w.maxTransfers } : {}), nowMs });
    const [out, activity, approvals] = await Promise.all([
      this.explorer!.outboundTransfers(address, token, window).catch(() => null),
      this.activity.activity(address, token.chain).catch(() => null),
      this.activity.approvals(address, token).catch(() => null),
    ]);
    return analyseBehaviour(
      {
        sender: address,
        token,
        nowMs,
        inbound,
        outbound: out && out.status === "ok" ? out.transfers : null,
        activity,
        approvals,
        label: (a) => this.labels.lookup(a, token.chain),
        senderLabel,
      },
      opts,
    );
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
