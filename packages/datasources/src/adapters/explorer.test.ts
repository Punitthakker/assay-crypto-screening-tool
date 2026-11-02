import { describe, expect, it } from "vitest";
import path from "node:path";
import { canonicalToken } from "@cr/shared";
import { FixtureTransport, redactUrl } from "../transport.js";
import { BlockscoutExplorer, EtherscanV2Explorer, ExplorerRouter, HeliusExplorer, TronGridExplorer, defaultWindow, routescanAvalanche } from "./explorer.js";

// mirrors data/fixtures/build-explorers.ts
const NOW_MS = Date.UTC(2026, 10, 2, 0, 0, 0);
const ADDR = {
  ethA: "0xA000000000000000000000000000000000000001",
  baseB: "0xB000000000000000000000000000000000000002",
  arbC: "0xC000000000000000000000000000000000000003",
  avaxD: "0xD000000000000000000000000000000000000004",
  ethEmpty: "0xE000000000000000000000000000000000000005",
  tron: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
  sol: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
};

const root = path.resolve(import.meta.dirname, "../../../..");
const transport = new FixtureTransport(path.join(root, "data/fixtures/explorers.json"));
const win = (over: Partial<ReturnType<typeof defaultWindow>> = {}) => defaultWindow({ nowMs: NOW_MS, ...over });
const tok = (chain: Parameters<typeof canonicalToken>[0], sym: "USDT" | "USDC") => canonicalToken(chain, sym)!;

describe("redactUrl", () => {
  it("blanks provider keys in fixture keys and leaves other params alone", () => {
    expect(redactUrl("https://x.io/api?chainid=1&apikey=SECRET&token=0xabc")).toBe("https://x.io/api?chainid=1&apikey=REDACTED&token=0xabc");
    expect(redactUrl("https://api.helius.xyz/v0/a?api-key=SECRET")).toBe("https://api.helius.xyz/v0/a?api-key=REDACTED");
    expect(redactUrl("https://x.io/api?chainid=1")).toBe("https://x.io/api?chainid=1");
  });
});

describe("EtherscanV2Explorer", () => {
  const es = new EtherscanV2Explorer(transport, { apiKey: "SECRET" });

  it("keeps inbound transfers of the token inside the window, newest first, with parsed units", async () => {
    const page = await es.inboundTransfers(ADDR.ethA, tok("ethereum", "USDT"), win());
    expect(page.provider).toBe("etherscan-v2");
    expect(page.transfers.map((t) => t.txHash)).toEqual(["0xf001", "0xf003"]);
    expect(page.transfers[0]!.value).toBe(1000);
    expect(page.transfers[1]!.value).toBe(250.5);
    expect(page.transfers[1]!.valueBase).toBe("250500000");
    expect(page.truncated).toBe(false);
  });

  it("treats 'No transactions found' as an empty page, not an error", async () => {
    const page = await es.inboundTransfers(ADDR.ethEmpty, tok("ethereum", "USDT"), win());
    expect(page.transfers).toHaveLength(0);
  });

  it("throws on a provider error so the router can fall through", async () => {
    await expect(es.inboundTransfers(ADDR.baseB, tok("base", "USDC"), win())).rejects.toThrow(/rate limit/);
  });

  it("never fetches from the live network in fixture mode: missing fixture is a miss, not a call", async () => {
    await expect(es.inboundTransfers("0x9999999999999999999999999999999999999999", tok("ethereum", "USDT"), win())).rejects.toThrow(/fixture miss/);
  });
});

describe("BlockscoutExplorer", () => {
  const bs = new BlockscoutExplorer(transport, {});

  it("follows next_page_params until exhausted", async () => {
    const page = await bs.inboundTransfers(ADDR.arbC, tok("arbitrum", "USDC"), win());
    expect(page.transfers.map((t) => t.txHash)).toEqual(["0xa001", "0xa002", "0xa003"]);
    expect(page.transfers.map((t) => t.value)).toEqual([10, 20, 30]);
    expect(page.truncated).toBe(false);
  });

  it("caps at maxTransfers and reports truncation", async () => {
    const page = await bs.inboundTransfers(ADDR.arbC, tok("arbitrum", "USDC"), win({ maxTransfers: 2 }));
    expect(page.transfers).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  it("drops transfers older than the window", async () => {
    const page = await bs.inboundTransfers(ADDR.arbC, tok("arbitrum", "USDC"), win({ windowDays: 7 }));
    expect(page.transfers.map((t) => t.txHash)).toEqual(["0xa001"]);
  });

  it("supports only chains with a hosted instance unless BLOCKSCOUT_<CHAIN> is set", () => {
    expect(bs.supports("ethereum")).toBe(true);
    expect(bs.supports("bnb")).toBe(false);
    expect(new BlockscoutExplorer(transport, { BLOCKSCOUT_BNB: "https://bnb.example" }).supports("bnb")).toBe(true);
    expect(bs.supports("tron")).toBe(false);
  });
});

describe("TronGridExplorer", () => {
  it("parses TRC-20 inbound transfers and skips approvals", async () => {
    const tg = new TronGridExplorer(transport, {});
    const page = await tg.inboundTransfers(ADDR.tron, tok("tron", "USDT"), win());
    expect(page.transfers.map((t) => t.txHash)).toEqual(["t001", "t003"]);
    expect(page.transfers[0]!.value).toBe(5000);
    expect(page.transfers[1]!.value).toBe(12.345678);
    expect(page.transfers[1]!.chain).toBe("tron");
  });
});

describe("HeliusExplorer", () => {
  it("needs a key", () => {
    expect(new HeliusExplorer(transport, {}).supports("solana")).toBe(false);
    expect(new HeliusExplorer(transport, { HELIUS_API_KEY: "SECRET" }).supports("solana")).toBe(true);
  });

  it("keeps only inbound transfers of the screened mint and rebuilds base units", async () => {
    const h = new HeliusExplorer(transport, { HELIUS_API_KEY: "SECRET" });
    const page = await h.inboundTransfers(ADDR.sol, tok("solana", "USDC"), win());
    expect(page.transfers.map((t) => t.txHash)).toEqual(["sig001"]);
    expect(page.transfers[0]!.valueBase).toBe("100500000");
    expect(page.transfers[0]!.value).toBe(100.5);
  });
});

describe("ExplorerRouter", () => {
  it("prefers Etherscan when a key is set", async () => {
    const r = new ExplorerRouter(transport, { ETHERSCAN_API_KEY: "SECRET" });
    expect(r.candidates("ethereum").map((a) => a.provider)).toEqual(["etherscan-v2", "blockscout"]);
    const res = await r.inboundTransfers(ADDR.ethA, tok("ethereum", "USDT"), win());
    expect(res.status).toBe("ok");
    expect(res.provider).toBe("etherscan-v2");
    expect(res.transfers).toHaveLength(2);
  });

  it("falls through to Blockscout when Etherscan errors, and says so", async () => {
    const r = new ExplorerRouter(transport, { ETHERSCAN_API_KEY: "SECRET" });
    const res = await r.inboundTransfers(ADDR.baseB, tok("base", "USDC"), win());
    expect(res.status).toBe("ok");
    expect(res.provider).toBe("blockscout");
    expect(res.transfers[0]!.value).toBe(75);
    expect(res.detail).toMatch(/etherscan-v2: .*rate limit/);
  });

  it("uses Blockscout alone without a key", () => {
    const r = new ExplorerRouter(transport, {});
    expect(r.candidates("arbitrum").map((a) => a.provider)).toEqual(["blockscout"]);
  });

  it("uses Routescan for Avalanche when nothing else is configured", async () => {
    const r = new ExplorerRouter(transport, {});
    expect(r.candidates("avalanche").map((a) => a.provider)).toEqual(["routescan"]);
    const res = await r.inboundTransfers(ADDR.avaxD, tok("avalanche", "USDT"), win());
    expect(res.status).toBe("ok");
    expect(res.transfers[0]!.value).toBe(5);
  });

  it("is honest when no provider is configured for a chain", async () => {
    const r = new ExplorerRouter(transport, {});
    const res = await r.inboundTransfers(ADDR.sol, tok("solana", "USDC"), win());
    expect(res.status).toBe("unavailable");
    expect(res.detail).toContain("HELIUS_API_KEY");
    const bnb = await r.inboundTransfers(ADDR.ethA, canonicalToken("bnb", "USDT") ?? { chain: "bnb", symbol: "USDT", onChainSymbol: "BSC-USD", issuer: "Binance", kind: "bridged", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, freeze: { kind: "none" } }, win());
    expect(bnb.status).toBe("unavailable");
    expect(bnb.detail).toContain("BLOCKSCOUT_BNB");
  });

  it("screen() yields a coverage line and one informational evidence line, never throws", async () => {
    const r = new ExplorerRouter(transport, { ETHERSCAN_API_KEY: "SECRET" });
    const ok = await r.screen(ADDR.ethA, tok("ethereum", "USDT"), win());
    expect(ok.coverage).toMatchObject({ source: "explorer", status: "ok" });
    expect(ok.evidence).toHaveLength(1);
    expect(ok.evidence[0]!.code).toBe("FLOW_INBOUND_WINDOW");
    expect(ok.evidence[0]!.points).toBe(0);
    expect(ok.evidence[0]!.summary).toContain("2 inbound USDT transfers from 2 counterparties totalling 1,250.5 USDT");
    expect(ok.facts).toMatchObject({ inboundCount: 2, counterparties: 2, provider: "etherscan-v2" });

    const miss = await r.screen("0x9999999999999999999999999999999999999999", tok("ethereum", "USDT"), win());
    expect(miss.coverage.status).toBe("unavailable");
    expect(miss.evidence).toHaveLength(0);
    expect(miss.transfers).toHaveLength(0);
  });

  it("routescanAvalanche only claims avalanche", () => {
    const rs = routescanAvalanche(transport);
    expect(rs.supports("avalanche")).toBe(true);
    expect(rs.supports("ethereum")).toBe(false);
  });
});
