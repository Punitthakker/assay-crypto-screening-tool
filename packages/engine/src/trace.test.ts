import { describe, expect, it } from "vitest";
import { canonicalToken } from "@cr/shared";
import { defaultWindow, type InboundTransfersResult, type Label, type Transfer } from "@cr/datasources";
import { DEFAULT_TRACE, Tracer, traceOptionsFromEnv, type TraceDeps } from "./trace.js";
import { computeConfidence, computeScore } from "./score.js";

/**
 * Hand-built graphs, no fixtures on disk: the tracer only sees Transfer[] per address,
 * so every SCORING.md worked example can be encoded as a few lines.
 */

const USDT = canonicalToken("ethereum", "USDT")!;
const NOW = Date.UTC(2026, 10, 2);
const win = defaultWindow({ nowMs: NOW });

const S = "0xS000000000000000000000000000000000000000";
const A = "0xA000000000000000000000000000000000000000";
const B = "0xB000000000000000000000000000000000000000";
const C = "0xC000000000000000000000000000000000000000";
const D = "0xD000000000000000000000000000000000000000";
const MIX = "0x722122dF12D4e14e13Ac3b6895a86e84145b6967";
const BINANCE = "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549";
const FROZEN = "0xF000000000000000000000000000000000000000";
const OFAC = "0x0330070FD38Ec3bB94F58FA55D40368271E9e54A";
const SCAM = "0x5CA0000000000000000000000000000000000000";

let n = 0;
const tx = (from: string, to: string, value: number, daysAgo = 1): Transfer => ({
  chain: "ethereum",
  txHash: `0x${(++n).toString(16).padStart(4, "0")}`,
  from,
  to,
  token: USDT.address,
  valueBase: String(Math.round(value * 1e6)),
  decimals: 6,
  value,
  timestamp: Math.floor(NOW / 1000) - daysAgo * 86400,
});

const LABELS: Record<string, Label> = {
  [MIX.toLowerCase()]: { address: MIX, chainFamily: "evm", category: "mixer", name: "Tornado Cash Router", source: "test" },
  [BINANCE.toLowerCase()]: { address: BINANCE, chainFamily: "evm", category: "exchange_licensed", name: "Binance 15", jurisdiction: "AE", source: "test" },
  [SCAM.toLowerCase()]: { address: SCAM, chainFamily: "evm", category: "scam", name: "Drainer", source: "test" },
};

function deps(graph: Record<string, Transfer[]>, over: Partial<TraceDeps> = {}): TraceDeps & { fetches: string[] } {
  const fetches: string[] = [];
  return {
    fetches,
    inbound: async (address): Promise<InboundTransfersResult> => {
      fetches.push(address);
      const t = graph[address.toLowerCase()];
      if (!t) return { status: "unavailable", transfers: [], truncated: false, window: { windowDays: 90, maxTransfers: 200, fromIso: "" }, detail: "no explorer" };
      return { status: "ok", provider: "test", transfers: t, truncated: false, window: { windowDays: 90, maxTransfers: 200, fromIso: "" }, detail: "" };
    },
    label: (a) => LABELS[a.toLowerCase()],
    sanctioned: async (a) => a.toLowerCase() === OFAC.toLowerCase(),
    frozen: async (a) => a.toLowerCase() === FROZEN.toLowerCase(),
    ...over,
  };
}

const run = (graph: Record<string, Transfer[]>, hop1: Transfer[], opts = DEFAULT_TRACE, d = deps(graph)) => new Tracer(d, opts).trace(S, USDT, hop1, win);

describe("Tracer: SCORING.md worked examples", () => {
  it("example 3: 12% of value from a mixer at hop 2 is 3.3 points, floored to 8 by the dust rule", async () => {
    // S receives 1000 from A; A received 120 from Tornado and 880 from B
    const hop1 = [tx(A, S, 1000)];
    const r = await run({ [A.toLowerCase()]: [tx(MIX, A, 120), tx(B, A, 880)] }, hop1);
    expect(r.exposure.mixer).toBeCloseTo(0.06, 5);
    const ev = r.evidence.find((e) => e.code === "EXPOSURE_MIXER")!;
    expect(ev.points).toBe(8);
    expect(ev.hop).toBe(2);
    expect(ev.summary).toContain("Dust rule");
    expect(ev.summary).toContain("Tornado Cash Router");
    expect(r.coverage.status).toBe("ok");
    expect(computeScore(r.evidence).score).toBe(8);
  });

  it("example 4: 65% of inbound directly from a frozen address scores 39", async () => {
    const hop1 = [tx(FROZEN, S, 650), tx(A, S, 350)];
    const r = await run({ [A.toLowerCase()]: [tx(B, A, 350)] }, hop1);
    expect(r.exposure.frozen).toBeCloseTo(0.65, 5);
    const ev = r.evidence.find((e) => e.code === "EXPOSURE_FROZEN")!;
    expect(ev.points).toBe(39);
    expect(ev.hop).toBe(1);
    expect(ev.summary).toContain("currently frozen by the issuer");
    expect(computeScore(r.evidence).score).toBe(39); // LOW on exposure alone; the example reaches CAUTION with the BEHAV_* 16 points that land next
  });

  it("licensed exchange hot wallet terminates the branch at zero points", async () => {
    const hop1 = [tx(BINANCE, S, 900), tx(A, S, 100)];
    const d = deps({ [A.toLowerCase()]: [tx(B, A, 100)] });
    const r = await run({}, hop1, DEFAULT_TRACE, d);
    expect(r.boundary).toBeCloseTo(0.9, 4);
    expect(r.evidence.filter((e) => e.severity === "risk")).toHaveLength(0);
    expect(d.fetches).toEqual([A]); // the exchange is never expanded
    expect(r.nodes.find((x) => x.address === BINANCE)?.status).toBe("licensed_vasp");
    expect(r.coverage.detail).toContain("1 licensed VASP boundary (90% of value)");
    expect(computeScore(r.evidence).score).toBe(0);
  });

  it("sanctioned counterparty at hop 1 is exposure, never a hard block, capped at 80", async () => {
    const r = await run({}, [tx(OFAC, S, 500)]);
    const ev = r.evidence.find((e) => e.code === "EXPOSURE_SANCTIONED")!;
    expect(ev.severity).toBe("risk");
    expect(ev.points).toBe(80);
    const s = computeScore(r.evidence);
    expect(s.hardBlock).toBeUndefined();
    expect(s.verdict).toBe("BLOCK"); // 80 points sits in the BLOCK band by arithmetic, as SCORING.md intends
  });

  it("decay: the same mixer share at hop 2 is worth half of hop 1", async () => {
    const direct = await run({}, [tx(MIX, S, 400), tx(A, S, 600)], { ...DEFAULT_TRACE, depth: 1 });
    const viaA = await run({ [A.toLowerCase()]: [tx(MIX, A, 400), tx(B, A, 600)] }, [tx(A, S, 1000)]);
    expect(direct.exposure.mixer).toBeCloseTo(0.4, 5);
    expect(viaA.exposure.mixer).toBeCloseTo(0.2, 5);
    expect(direct.evidence.find((e) => e.code === "EXPOSURE_MIXER")!.points).toBe(22);
    expect(viaA.evidence.find((e) => e.code === "EXPOSURE_MIXER")!.points).toBe(11);
  });
});

describe("Tracer: boundaries and coverage", () => {
  it("fan-out cap buckets the remainder as untraced and marks coverage partial above 20%", async () => {
    const hop1 = [tx(A, S, 100), tx(B, S, 50), tx(C, S, 30), tx(D, S, 20)];
    const r = await run({}, hop1, { ...DEFAULT_TRACE, depth: 1, fanOut: 2 });
    expect(r.nodes).toHaveLength(2);
    expect(r.untraced).toBeCloseTo(0.25, 4);
    expect(r.coverage.status).toBe("partial");
    expect(computeConfidence([ok("issuer-freeze"), ok("ofac-sdn"), ok("chainalysis-oracle"), r.coverage]).confidence).toBe("medium");
  });

  it("full 2-hop trace with no findings is ok coverage and lets confidence reach high", async () => {
    const r = await run({ [A.toLowerCase()]: [tx(B, A, 100)], [C.toLowerCase()]: [tx(D, C, 40)] }, [tx(A, S, 100), tx(C, S, 40)]);
    expect(r.depthReached).toBe(2);
    expect(r.untraced).toBe(0);
    expect(r.coverage.status).toBe("ok");
    expect(r.evidence.map((e) => e.code)).toEqual(["FLOW_TRACE"]);
    expect(r.evidence[0]!.summary).toContain("No labelled, frozen or sanctioned counterparty");
    expect(computeConfidence([ok("issuer-freeze"), ok("ofac-sdn"), ok("chainalysis-oracle"), r.coverage]).confidence).toBe("high");
  });

  it("a hop-2 fetch failure moves that branch to untraced and marks coverage partial", async () => {
    const r = await run({ [A.toLowerCase()]: [tx(B, A, 100)] }, [tx(A, S, 70), tx(C, S, 30)]);
    expect(r.nodes.find((x) => x.address === C)?.expanded).toBe("no_explorer");
    expect(r.untraced).toBeCloseTo(0.3, 4);
    expect(r.coverage.status).toBe("partial");
    expect(r.coverage.detail).toContain("1 hop-2 fetch failed");
  });

  it("dust floor drops tiny counterparties so a dusting attack cannot poison the trace", async () => {
    const r = await run({}, [tx(A, S, 1000), tx(OFAC, S, 0.5)], { ...DEFAULT_TRACE, depth: 1 });
    expect(r.nodes.map((x) => x.address)).toEqual([A]);
    expect(r.exposure.sanctioned).toBeUndefined();
    expect(r.dusted).toBeCloseTo(0.0005, 6);
  });

  it("a dust transfer above the floor still triggers the dust rule floor of 8 points", async () => {
    const r = await run({}, [tx(A, S, 1000), tx(OFAC, S, 2)], { ...DEFAULT_TRACE, depth: 1 });
    expect(r.evidence.find((e) => e.code === "EXPOSURE_SANCTIONED")!.points).toBe(8);
  });

  it("loops back to the sender or a hop-1 wallet are internal and never double-counted", async () => {
    const r = await run({ [A.toLowerCase()]: [tx(S, A, 50), tx(MIX, A, 50)] }, [tx(A, S, 100)]);
    const loop = r.nodes.find((x) => x.hop === 2 && x.address === S);
    expect(loop?.status).toBe("internal");
    expect(r.exposure.mixer).toBeCloseTo(0.25, 5);
  });

  it("depth 0 reports fund-flow disabled, depth 1 never fetches", async () => {
    const d = deps({ [A.toLowerCase()]: [tx(MIX, A, 10)] });
    const r0 = await new Tracer(d, { ...DEFAULT_TRACE, depth: 0 }).trace(S, USDT, [tx(A, S, 10)], win);
    expect(r0.coverage.status).toBe("disabled");
    const r1 = await new Tracer(d, { ...DEFAULT_TRACE, depth: 1 }).trace(S, USDT, [tx(A, S, 10)], win);
    expect(d.fetches).toEqual([]);
    expect(r1.depthReached).toBe(1);
    expect(r1.coverage.status).toBe("partial"); // depth 1 with unlabelled counterparties left unexpanded caps confidence at medium
    expect(r1.coverage.detail).toContain("trace depth 1 only");
  });

  it("freeze reads are skipped for labelled and sanctioned nodes and capped per trace", async () => {
    const reads: string[] = [];
    const d = deps({}, { frozen: async (a) => (reads.push(a), false) });
    await new Tracer(d, { ...DEFAULT_TRACE, depth: 1, freezeCheckCap: 2 }).trace(S, USDT, [tx(MIX, S, 500), tx(OFAC, S, 400), tx(A, S, 300), tx(B, S, 200), tx(C, S, 100)], win);
    expect(reads).toEqual([A, B]);
  });

  it("scam label at hop 1 and frozen at hop 2 produce two evidence lines with the right hops", async () => {
    const r = await run({ [A.toLowerCase()]: [tx(FROZEN, A, 100)] }, [tx(SCAM, S, 200), tx(A, S, 800)]);
    const codes = r.evidence.filter((e) => e.severity === "risk").map((e) => `${e.code}@${e.hop}`);
    expect(codes.sort()).toEqual(["EXPOSURE_FROZEN@2", "EXPOSURE_SCAM@1"]);
    expect(r.evidence.find((e) => e.code === "EXPOSURE_SCAM")!.points).toBe(10); // 0.2 x 50
    expect(r.evidence.find((e) => e.code === "EXPOSURE_FROZEN")!.points).toBe(24); // 0.8 x 0.5 x 60
    expect(computeScore(r.evidence).score).toBe(34);
  });

  it("unavailable OFAC list leaves sanctioned as null and the trace still runs", async () => {
    const d = deps({}, { sanctioned: async () => null });
    const r = await new Tracer(d, { ...DEFAULT_TRACE, depth: 1 }).trace(S, USDT, [tx(OFAC, S, 10)], win);
    expect(r.nodes[0]?.sanctioned).toBeNull();
    expect(r.nodes[0]?.status).toBe("unlabelled");
  });
});

describe("traceOptionsFromEnv", () => {
  it("reads and clamps env overrides", () => {
    const o = traceOptionsFromEnv({ CR_TRACE_DEPTH: "9", CR_TRACE_FANOUT: "10", CR_TRACE_DUST: "0.5", CR_TRACE_EXPAND_CAP: "3" });
    expect(o).toMatchObject({ depth: 3, fanOut: 10, dustFloor: 0.5, expandCap: 3 });
    expect(traceOptionsFromEnv({})).toEqual(DEFAULT_TRACE);
    expect(traceOptionsFromEnv({ CR_TRACE_DEPTH: "0" }, { depth: 2 }).depth).toBe(2);
  });
});

const ok = (source: string) => ({ source, status: "ok" as const });
