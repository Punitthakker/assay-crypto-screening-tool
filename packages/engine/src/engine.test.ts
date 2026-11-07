import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { Engine } from "./screen.js";
import { FixtureTransport, FreezeIndex, LabelStore, WatchmanAdapter, emptyIndex } from "@cr/datasources";
import { canonicalToken } from "@cr/shared";

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

describe("freeze event index end to end (data/fixtures/freeze-index)", () => {
  const NOW = Date.UTC(2026, 10, 2);
  const SENDER = "0x5e0d000000000000000000000000000000000001";
  const B = "0xb1b1000000000000000000000000000000000003";
  const mk = (over: Partial<ConstructorParameters<typeof Engine>[0]> = {}) =>
    new Engine({
      transport: new FixtureTransport(path.join(root, "data/fixtures/trace.json")),
      labels: new LabelStore(path.join(root, "data/labels")),
      env: { ETHERSCAN_API_KEY: "test" },
      window: { nowMs: NOW },
      freezeIndex: new FreezeIndex({ dir: path.join(root, "data/fixtures/freeze-index"), nowMs: NOW }),
      ...over,
    });

  it("a released hop-2 wallet adds EXPOSURE_PREVIOUSLY_FROZEN at 20 x its decayed share on top of example 3", async () => {
    const { report: r, trace } = await mk().screenWithFlow({ address: SENDER, chain: "ethereum", asset: "USDT" });
    const ev = r.evidence.find((e) => e.code === "EXPOSURE_PREVIOUSLY_FROZEN")!;
    expect(ev.hop).toBe(2);
    expect(ev.points).toBe(5.9); // (1000/1500) x (880/1000) x 0.5 = 0.2933 x 20
    expect(ev.summary).toContain("previously frozen by the issuer");
    expect(r.score).toBe(14); // mixer floor 8 + 5.9
    expect(r.verdict).toBe("CLEAR");
    expect(r.confidence).toBe("high");
    const node = trace?.nodes.find((n) => n.address.toLowerCase() === B)!;
    expect(node.status).toBe("previously_frozen");
    expect(node.frozen).toBe(false);
    expect(node.freezeHistory?.releasedAt).toBe(1_739_145_600);
    const cov = r.coverage.find((c) => c.source === "freeze-index")!;
    expect(cov.status).toBe("ok");
    expect(cov.detail).toContain("2 events via fixture");
    expect(cov.ageHours).toBe(24);
  });

  it("a sender the issuer once froze and released gets EXPOSURE_DIRECT_PREVIOUSLY_FROZEN, 20 points at hop 0", async () => {
    const USDT = canonicalToken("ethereum", "USDT")!;
    const index = new FreezeIndex({
      files: [{ ...emptyIndex(USDT, "test"), updatedAt: "2026-11-01T00:00:00.000Z", cursor: { block: 1 }, events: [
        { type: "added", address: SENDER, block: 1, timestamp: 1_735_689_600, txHash: "0xs1" },
        { type: "destroyed", address: SENDER, block: 2, timestamp: 1_735_776_000, txHash: "0xs2", amountBase: "250000000" },
        { type: "removed", address: SENDER, block: 3, timestamp: 1_739_145_600, txHash: "0xs3" },
      ] }],
      nowMs: NOW,
    });
    const r = await mk({ freezeIndex: index }).screen({ address: SENDER, chain: "ethereum", asset: "USDT" });
    const ev = r.evidence.find((e) => e.code === "EXPOSURE_DIRECT_PREVIOUSLY_FROZEN")!;
    expect(ev.points).toBe(20);
    expect(ev.hop).toBe(0);
    expect(ev.ref).toBe("0xs3");
    expect(ev.summary).toBe("Sender was blacklisted by Tether for USDT on ethereum on 2025-01-01 and released on 2025-02-10 (1 add, 1 remove; 1 DestroyedBlackFunds event (250 USDT burned)). Not frozen now.");
    expect(r.score).toBe(28); // 20 + mixer floor 8
    expect(r.verdict).toBe("LOW");
    expect(r.hardBlock).toBeUndefined();
  });

  it("a currently frozen sender is still a hard block and gets no history line", async () => {
    const r = await mk({ transport: new FixtureTransport(path.join(root, "data/fixtures/recorded.json")) }).screen({ address: "0x28C6c06298d514Db089934071355E5743bf21d60", chain: "ethereum", asset: "USDT" });
    expect(r.hardBlock).toBe("HB_FROZEN");
    expect(r.evidence.find((e) => e.code.includes("PREVIOUSLY_FROZEN"))).toBeUndefined();
  });

  it("without an index the coverage line says so and nothing is scored; Solana is not applicable", async () => {
    const r = await mk({ freezeIndex: new FreezeIndex("/nonexistent") }).screen({ address: SENDER, chain: "ethereum", asset: "USDT" });
    expect(r.coverage.find((c) => c.source === "freeze-index")).toEqual({ source: "freeze-index", status: "unavailable", detail: "no freeze index for USDT on ethereum; run pnpm index:freeze" });
    expect(r.score).toBe(8);
    expect(r.confidence).toBe("high"); // the index is a bonus signal, not a confidence requirement
    const sol = await engine.screen({ address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", chain: "solana", asset: "USDC" });
    expect(sol.coverage.find((c) => c.source === "freeze-index")?.status).toBe("not_applicable");
    const off = await mk({ freezeIndex: false }).screen({ address: SENDER, chain: "ethereum", asset: "USDT" });
    expect(off.coverage.find((c) => c.source === "freeze-index")?.status).toBe("disabled");
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

describe("identity layer end to end (data/fixtures/watchman.json)", () => {
  const BASE = { address: "0x1111111111111111111111111111111111111111", chain: "base", asset: "USDC", amount: 25000 } as const;
  const mk = (env: NodeJS.ProcessEnv = { WATCHMAN_URL: "http://watchman:8084" }) =>
    new Engine({
      transport: new FixtureTransport(path.join(root, "data/fixtures/recorded.json")),
      labels: new LabelStore(path.join(root, "data/labels")),
      env: {},
      watchman: new WatchmanAdapter(new FixtureTransport(path.join(root, "data/fixtures/watchman.json")), env),
    });

  it("a clean originator lifts the Travel Rule floor, is attested, and leaves one IDENTITY_NAME_CLEAR info line", async () => {
    const r = await mk().screen({ ...BASE, originator: { name: "Amina Haddad", dateOfBirth: "1988-02-11" } });
    expect(r.identity).toBe("attested");
    expect(r.flags).not.toContain("TRAVEL_RULE_DATA_REQUIRED");
    expect(r.verdict).toBe("CLEAR");
    expect(r.coverage.find((c) => c.source === "watchman")?.status).toBe("ok");
    expect(r.evidence.map((e) => e.code)).toContain("IDENTITY_NAME_CLEAR");
    expect(r.hardBlock).toBeUndefined();
  });

  it("a sanctioned originator is HB_ORIGINATOR_SANCTIONED, BLOCK, and the trace is skipped", async () => {
    const r = await mk().screen({ ...BASE, originator: { name: "Dmitry Khoroshev", dateOfBirth: "1993-04-17", nationality: "RU" } });
    expect(r.hardBlock).toBe("HB_ORIGINATOR_SANCTIONED");
    expect(r.verdict).toBe("BLOCK");
    expect(r.score).toBe(100);
    expect(r.coverage.find((c) => c.source === "fund-flow")?.status).toBe("not_applicable");
    expect(r.evidence[0]?.ref).toBe("us_ofac:48603");
  });

  it("a near miss is a flag and an info line, never a block or points", async () => {
    const r = await mk().screen({ ...BASE, originator: { name: "Dmitry Khoroshev" } });
    expect(r.hardBlock).toBeUndefined();
    expect(r.flags).toContain("ORIGINATOR_NAME_REVIEW");
    expect(r.evidence.find((e) => e.code === "IDENTITY_NAME_REVIEW")?.points).toBe(0);
    expect(r.verdict).toBe("CLEAR");
  });

  it("a PEP originator adds 15 points in the identity bucket", async () => {
    const r = await mk().screen({ ...BASE, originator: { name: "Northbridge Holdings FZE", isLegalPerson: true } });
    expect(r.evidence.find((e) => e.code === "IDENTITY_PEP")?.points).toBe(15);
    expect(r.score).toBe(15);
    expect(r.verdict).toBe("CLEAR");
  });

  it("without WATCHMAN_URL the screen is stated as disabled and confidence is not downgraded for it", async () => {
    const r = await mk({}).screen({ ...BASE, originator: { name: "Amina Haddad" } });
    expect(r.identity).toBe("attested");
    expect(r.coverage.find((c) => c.source === "watchman")).toMatchObject({ status: "disabled" });
    expect(r.flags.join()).not.toContain("originator name screening");
    expect(r.evidence.some((e) => e.source === "watchman")).toBe(false);
  });

  it("an unreachable Watchman caps confidence at medium and names it", async () => {
    const r = await mk({ WATCHMAN_URL: "http://nowhere:1" }).screen({ ...BASE, originator: { name: "Amina Haddad" } });
    expect(r.coverage.find((c) => c.source === "watchman")?.status).toBe("unavailable");
    expect(r.confidence).not.toBe("high");
    expect(r.flags.join()).toContain("originator name screening unavailable");
  });

  it("no originator: no watchman coverage line at all", async () => {
    const r = await mk().screen({ ...BASE });
    expect(r.coverage.find((c) => c.source === "watchman")).toBeUndefined();
    expect(r.flags).toContain("TRAVEL_RULE_DATA_REQUIRED");
  });
});
