import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { Engine } from "./screen.js";
import { FixtureTransport, LabelStore } from "@cr/datasources";

const root = path.resolve(import.meta.dirname, "../../..");
let engine: Engine;

beforeAll(() => {
  process.chdir(root);
  const transport = new FixtureTransport(path.join(root, "data/fixtures/recorded.json"));
  engine = new Engine({ transport, labels: new LabelStore(path.join(root, "data/labels")), env: {} });
});

describe("explorer coverage", () => {
  it("reports the explorer as unavailable in fixture mode when nothing is recorded, without touching the score", async () => {
    const r = await engine.screen({ address: "0x1111111111111111111111111111111111111111", chain: "base", asset: "USDC" });
    const ex = r.coverage.find((c) => c.source === "explorer");
    expect(ex?.status).toBe("unavailable");
    expect(r.coverage.find((c) => c.source === "fund-flow")?.status).toBe("unavailable");
    expect(r.confidence).toBe("medium");
  });

  it("marks fund-flow disabled when the explorer is switched off", async () => {
    const transport = new FixtureTransport(path.join(root, "data/fixtures/recorded.json"));
    const e = new Engine({ transport, labels: new LabelStore(path.join(root, "data/labels")), explorer: false });
    const r = await e.screen({ address: "0x1111111111111111111111111111111111111111", chain: "base", asset: "USDC" });
    expect(r.coverage.find((c) => c.source === "fund-flow")?.status).toBe("disabled");
  });

  it("skips the trace for a hard-blocked sender", async () => {
    const r = await engine.screen({ address: "0x0330070FD38Ec3bB94F58FA55D40368271E9e54A", chain: "ethereum", asset: "USDT" });
    expect(r.coverage.find((c) => c.source === "fund-flow")?.status).toBe("not_applicable");
  });
});

describe("2-hop trace end to end (data/fixtures/trace.json)", () => {
  const NOW = Date.UTC(2026, 10, 2);
  const SENDER = "0x5e0d000000000000000000000000000000000001";
  const mk = (over: Partial<ConstructorParameters<typeof Engine>[0]> = {}) =>
    new Engine({
      transport: new FixtureTransport(path.join(root, "data/fixtures/trace.json")),
      labels: new LabelStore(path.join(root, "data/labels")),
      env: { ETHERSCAN_API_KEY: "test" },
      window: { nowMs: NOW },
      ...over,
    });

  it("worked example 3: mixer at hop 2 behind an unlabelled wallet, dust-floored to 8, CLEAR with high confidence", async () => {
    const { report: r, trace } = await mk().screenWithFlow({ address: SENDER, chain: "ethereum", asset: "USDT" });
    expect(r.verdict).toBe("CLEAR");
    expect(r.score).toBe(8);
    expect(r.confidence).toBe("high");
    expect(r.coverage.find((c) => c.source === "fund-flow")?.status).toBe("ok");
    const mixer = r.evidence.find((e) => e.code === "EXPOSURE_MIXER")!;
    expect(mixer.hop).toBe(2);
    expect(mixer.ref).toBe("0x7b01");
    expect(mixer.summary).toMatch(/^4\.0% of inbound USDT value/);
    expect(trace?.boundary).toBeCloseTo(1 / 3, 4);
    expect(trace?.nodes.map((n) => `${n.hop}:${n.status}`).sort()).toEqual(["1:licensed_vasp", "1:unlabelled", "2:mixer", "2:unlabelled"]);
    expect(trace?.nodes.find((n) => n.hop === 2 && n.status === "unlabelled")?.frozen).toBe(false);
  });

  it("traceDepth 1 on the request stops at the sender's counterparties and caps confidence at medium", async () => {
    const r = await mk().screen({ address: SENDER, chain: "ethereum", asset: "USDT", traceDepth: 1 });
    expect(r.score).toBe(0);
    expect(r.confidence).toBe("medium");
    expect(r.flags.join()).toContain("trace depth 1 only");
    expect(r.evidence.find((e) => e.code === "EXPOSURE_MIXER")).toBeUndefined();
  });

  it("env CR_TRACE_DEPTH=0 disables the trace", async () => {
    const r = await mk({ env: { ETHERSCAN_API_KEY: "test", CR_TRACE_DEPTH: "0" } }).screen({ address: SENDER, chain: "ethereum", asset: "USDT" });
    expect(r.coverage.find((c) => c.source === "fund-flow")?.status).toBe("disabled");
    expect(r.confidence).toBe("medium");
  });

  it("can be switched off", async () => {
    const transport = new FixtureTransport(path.join(root, "data/fixtures/recorded.json"));
    const e = new Engine({ transport, labels: new LabelStore(path.join(root, "data/labels")), explorer: false });
    const r = await e.screen({ address: "0x1111111111111111111111111111111111111111", chain: "base", asset: "USDC" });
    expect(r.coverage.find((c) => c.source === "explorer")).toBeUndefined();
  });
});

describe("control cases (SCORING.md)", () => {
  it("fresh benign wallet scores CLEAR with zero sanctions evidence", async () => {
    const r = await engine.screen({ address: "0x1111111111111111111111111111111111111111", chain: "base", asset: "USDC" });
    expect(r.verdict).toBe("CLEAR");
    expect(r.score).toBeLessThan(20);
    expect(r.evidence.filter((e) => e.severity === "block")).toHaveLength(0);
  });

  it("licensed exchange hot wallet scores CLEAR and is flagged as a VASP", async () => {
    const r = await engine.screen({ address: "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549", chain: "ethereum", asset: "USDT" });
    expect(r.verdict).toBe("CLEAR");
    expect(r.score).toBeLessThan(20);
    expect(r.flags).toContain("SENDER_IS_LICENSED_VASP");
  });

  it("a labelled exchange wallet that the issuer has frozen is still a hard BLOCK (Binance 14, verified live 2026-11-01)", async () => {
    const r = await engine.screen({ address: "0x28C6c06298d514Db089934071355E5743bf21d60", chain: "ethereum", asset: "USDT" });
    expect(r.hardBlock).toBe("HB_FROZEN");
    expect(r.flags).toContain("SENDER_IS_LICENSED_VASP"); // label survives, verdict does not soften
  });

  it("OFAC-listed sender is a hard BLOCK from the list, with oracle agreeing", async () => {
    const r = await engine.screen({ address: "0x0330070FD38Ec3bB94F58FA55D40368271E9e54A", chain: "ethereum", asset: "USDT" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.score).toBe(100);
    expect(r.hardBlock).toBe("HB_SANCTIONED_LIST");
    expect(r.flags.join()).toContain("HB_SANCTIONED_ORACLE");
    expect(r.flags).not.toContain("SANCTIONS_SOURCE_DISCREPANCY");
  });

  it("Tether-frozen Tron address is a hard BLOCK for USDT on Tron", async () => {
    const r = await engine.screen({ address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", chain: "tron", asset: "USDT" });
    expect(r.hardBlock).toBe("HB_FROZEN");
    expect(r.verdict).toBe("BLOCK");
  });

  it("Circle-frozen address is a hard BLOCK for USDC on Ethereum", async () => {
    const r = await engine.screen({ address: "0x5555555555555555555555555555555555555555", chain: "ethereum", asset: "USDC" });
    expect(r.hardBlock).toBe("HB_FROZEN");
  });

  it("delisted mixer router is CAUTION by label, not BLOCK", async () => {
    const r = await engine.screen({ address: "0x722122dF12D4e14e13Ac3b6895a86e84145b6967", chain: "ethereum", asset: "USDT" });
    expect(r.verdict).toBe("CAUTION");
    expect(r.hardBlock).toBeUndefined();
  });

  it("amount over the Travel Rule threshold without originator floors verdict at CAUTION", async () => {
    const r = await engine.screen({ address: "0x1111111111111111111111111111111111111111", chain: "base", asset: "USDC", amount: 25000 });
    expect(r.verdict).toBe("CAUTION");
    expect(r.flags).toContain("TRAVEL_RULE_DATA_REQUIRED");
    expect(r.score).toBeLessThan(20); // on-chain score unchanged, only the floor applies
  });

  it("Binance-peg on BNB Chain reports freeze as not applicable and adds bridged-asset risk", async () => {
    const r = await engine.screen({ address: "0x7777777777777777777777777777777777777777", chain: "bnb", asset: "USDT" });
    expect(r.coverage.find((c) => c.source === "issuer-freeze")?.status).toBe("not_applicable");
    expect(r.evidence.some((e) => e.code === "ASSET_BRIDGED")).toBe(true);
    expect(r.resolvedToken?.kind).toBe("bridged");
  });

  it("unknown token contract is a fake-token hard BLOCK", async () => {
    const r = await engine.screen({ address: "0x1111111111111111111111111111111111111111", chain: "base", asset: "USDC", tokenContract: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    expect(r.hardBlock).toBe("HB_FAKE_TOKEN");
  });

  it("rejects an address screened on the wrong chain family", async () => {
    await expect(engine.screen({ address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", chain: "ethereum", asset: "USDT" })).rejects.toThrow(/format is tron/);
  });

  it("report hash is stable for identical content", async () => {
    const r = await engine.screen({ address: "0x7777777777777777777777777777777777777777", chain: "bnb", asset: "USDT" });
    const { reportHash, ...rest } = r;
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(JSON.stringify(rest)).digest("hex")).toBe(reportHash);
  });
});

describe("behavioural signals end to end (data/fixtures/behaviour.json)", () => {
  const NOW = Date.UTC(2026, 10, 3);
  const FRESH = "0xf5e5000000000000000000000000000000000001";
  const MULE = "T9yD14Nj9j7xAB4dbGeiX9h8unkkhXvDAx";
  const mk = (env: NodeJS.ProcessEnv = { ETHERSCAN_API_KEY: "test" }) =>
    new Engine({
      transport: new FixtureTransport(path.join(root, "data/fixtures/behaviour.json")),
      labels: new LabelStore(path.join(root, "data/labels")),
      env,
      window: { nowMs: NOW },
    });

  it("worked example 1: fresh benign EOA on Base scores 16 (age 10 + tx count 6), CLEAR, confidence high, behaviour ok", async () => {
    const { report: r, behaviour } = await mk().screenWithFlow({ address: FRESH, chain: "base", asset: "USDC" });
    expect(r.score).toBe(16);
    expect(r.verdict).toBe("CLEAR");
    expect(r.confidence).toBe("high");
    expect(r.evidence.filter((e) => e.code.startsWith("BEHAV_")).map((e) => e.code).sort()).toEqual(["BEHAV_FRESH_WALLET", "BEHAV_LOW_TX_COUNT"]);
    expect(r.coverage.find((c) => c.source === "behaviour")).toMatchObject({ status: "ok" });
    expect(r.coverage.find((c) => c.source === "fund-flow")?.status).toBe("ok");
    expect(behaviour?.facts.txCount).toBe(3);
    expect(behaviour?.facts.walletAgeDays).toBeCloseTo(2, 3);
    expect(behaviour?.facts.topCounterpartyShare).toBeCloseTo(0.6, 6);
  });

  it("mule pattern on Tron: pass-through 15 + structuring 12 + concentration 6 = 33, LOW; approvals not evaluated on Tron", async () => {
    const { report: r, behaviour } = await mk({}).screenWithFlow({ address: MULE, chain: "tron", asset: "USDT" });
    expect(r.evidence.filter((e) => e.code.startsWith("BEHAV_")).map((e) => `${e.code}:${e.points}`).sort()).toEqual(["BEHAV_CONCENTRATION:6", "BEHAV_PASS_THROUGH:15", "BEHAV_STRUCTURING:12"]);
    expect(r.score).toBe(33);
    expect(r.verdict).toBe("LOW");
    expect(r.confidence).toBe("high");
    const b = r.coverage.find((c) => c.source === "behaviour")!;
    expect(b.status).toBe("partial");
    expect(b.detail).toMatch(/not evaluated: BEHAV_DRAINER_APPROVAL \(approval scan not implemented for tron\)/);
    expect(b.detail).toMatch(/via trongrid, tronscan/);
    expect(behaviour?.facts.passThroughMedianSeconds).toBe(180);
    expect(behaviour?.facts.structuringHits).toEqual({ threshold: 3000, count: 10 });
    expect(r.evidence.find((e) => e.code === "BEHAV_PASS_THROUGH")?.summary).toMatch(/3 min over 6 outbound transfers/);
  });

  it("CR_BEHAVIOUR=0 switches the signals off and says so", async () => {
    const r = await mk({ ETHERSCAN_API_KEY: "test", CR_BEHAVIOUR: "0" }).screen({ address: FRESH, chain: "base", asset: "USDC" });
    expect(r.score).toBe(0);
    expect(r.coverage.find((c) => c.source === "behaviour")?.status).toBe("disabled");
  });

  it("a hard-blocked sender skips the behavioural fetches", async () => {
    const r = await engine.screen({ address: "0x0330070FD38Ec3bB94F58FA55D40368271E9e54A", chain: "ethereum", asset: "USDT" });
    expect(r.coverage.find((c) => c.source === "behaviour")?.status).toBe("not_applicable");
  });
});
