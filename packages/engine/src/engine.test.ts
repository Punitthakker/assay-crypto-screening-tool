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
