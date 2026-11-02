import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { Engine } from "./screen.js";
import { TxScreener } from "./screen-tx.js";
import { FixtureTransport, LabelStore, TronscanExplorer, TxResolver, classifyInput, defaultWindow, looksLikeTx, parseAddressInput, parseTxInput } from "@cr/datasources";
import { canonicalToken } from "@cr/shared";

// mirrors data/fixtures/build-tx.ts
const NOW_MS = Date.UTC(2026, 10, 2, 0, 0, 0);
const T = {
  sender: "T9yD14Nj9j7xAB4dbGeiX9h8unkdRAmp4K",
  receiver: "T9yD14Nj9j7xAB4dbGeiX9h8unkfM3k1fd",
  binance: "TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX",
  plain: "T9yD14Nj9j7xAB4dbGeiX9h8unkhH5vBqB",
  frozen: "T9yD14Nj9j7xAB4dbGeiX9h8unkjBq477c",
  hash: "9f".repeat(32),
  hashNotFound: "00".repeat(32),
  hashScan: "8e".repeat(32),
};
const E = {
  sender: "0x00000000000000000000000000000000000000a1",
  receiver: "0x00000000000000000000000000000000000000b2",
  cp: "0x00000000000000000000000000000000000000c3",
  fake: "0x00000000000000000000000000000000000000f4",
  hash: "0x" + "e1".repeat(32),
  hashFake: "0x" + "e2".repeat(32),
};

const root = path.resolve(import.meta.dirname, "../../..");
let screener: TxScreener;
let transport: FixtureTransport;

beforeAll(() => {
  process.chdir(root);
  transport = new FixtureTransport(path.join(root, "data/fixtures/tx.json"));
  const labels = new LabelStore(path.join(root, "data/labels"));
  const engine = new Engine({ transport, labels, env: {}, window: { nowMs: NOW_MS } });
  screener = new TxScreener(engine, transport, labels, {});
});

describe("parseTxInput", () => {
  it("reads tronscan, etherscan-family, blockscout and solscan links", () => {
    expect(parseTxInput(`https://tronscan.org/#/transaction/${T.hash}`)).toEqual({ hash: T.hash, chain: "tron", inferredFrom: "url" });
    expect(parseTxInput(`https://etherscan.io/tx/${E.hash}`)).toMatchObject({ chain: "ethereum", inferredFrom: "url" });
    expect(parseTxInput(`https://basescan.org/tx/${E.hash}?x=1`)).toMatchObject({ chain: "base" });
    expect(parseTxInput(`https://arbiscan.io/tx/${E.hash}`)).toMatchObject({ chain: "arbitrum" });
    expect(parseTxInput(`https://polygonscan.com/tx/${E.hash}`)).toMatchObject({ chain: "polygon" });
    expect(parseTxInput(`https://snowscan.xyz/tx/${E.hash}`)).toMatchObject({ chain: "avalanche" });
    expect(parseTxInput(`https://bscscan.com/tx/${E.hash}`)).toMatchObject({ chain: "bnb" });
    expect(parseTxInput(`https://eth.blockscout.com/tx/${E.hash}`)).toMatchObject({ chain: "ethereum" });
    const sig = "5".repeat(87);
    expect(parseTxInput(`https://solscan.io/tx/${sig}`)).toEqual({ hash: sig, chain: "solana", inferredFrom: "url" });
  });

  it("infers Tron and Solana from the hash shape, and needs a chain for EVM hashes", () => {
    expect(parseTxInput(T.hash.toUpperCase())).toEqual({ hash: T.hash, chain: "tron", inferredFrom: "hash-format" });
    expect(parseTxInput("5".repeat(88))).toMatchObject({ chain: "solana" });
    expect(parseTxInput(E.hash)).toEqual({ hash: E.hash, inferredFrom: "hash-format" });
    expect(parseTxInput(E.hash, "base")).toEqual({ hash: E.hash, chain: "base", inferredFrom: "none" });
    expect(() => parseTxInput("hello world this is not a hash")).toThrow(/not a transaction hash/);
  });

  it("looksLikeTx separates tx input from addresses", () => {
    expect(looksLikeTx(T.hash)).toBe(true);
    expect(looksLikeTx(E.hash)).toBe(true);
    expect(looksLikeTx(`https://tronscan.org/#/transaction/${T.hash}`)).toBe(true);
    expect(looksLikeTx(T.sender)).toBe(false);
    expect(looksLikeTx(E.sender)).toBe(false);
    expect(looksLikeTx("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false);
  });
});

describe("TxResolver", () => {
  it("decodes TronGrid Transfer events into base58 addresses and token units", async () => {
    const r = await new TxResolver(transport, {}).resolve(parseTxInput(T.hash));
    expect(r.status).toBe("confirmed");
    expect(r.transfers).toHaveLength(1);
    expect(r.transfers[0]).toMatchObject({ from: T.sender, to: T.receiver, value: 5000, token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" });
    expect(r.explorerUrl).toBe(`https://tronscan.org/#/transaction/${T.hash}`);
  });

  it("decodes ERC-20 Transfer logs from the receipt, including unknown tokens", async () => {
    const r = await new TxResolver(transport, {}).resolve(parseTxInput(E.hash, "ethereum"));
    expect(r.status).toBe("confirmed");
    expect(r.transfers.map((t) => t.token.toLowerCase())).toEqual(["0xdac17f958d2ee523a2206206994597c13d831ec7", E.fake]);
    expect(r.transfers[0]).toMatchObject({ from: E.sender, to: E.receiver, value: 12000 });
  });

  it("reports not_found when the chain has no events for the hash", async () => {
    const r = await new TxResolver(transport, {}).resolve(parseTxInput(T.hashNotFound));
    expect(r.status).toBe("not_found");
  });

  it("refuses an EVM hash without a chain", async () => {
    await expect(new TxResolver(transport, {}).resolve(parseTxInput(E.hash))).rejects.toThrow(/chain is needed/);
  });
});

describe("TxScreener", () => {
  it("screens the sender of a Tron USDT transfer and lists its sources with hard checks", async () => {
    const r = await screener.screen({ tx: `https://tronscan.org/#/transaction/${T.hash}`, receiver: T.receiver });
    expect(r.tx.inferredFrom).toBe("url");
    expect(r.screened).toMatchObject({ from: T.sender, to: T.receiver, value: 5000, onChainSymbol: "USDT", genuine: true, paysReceiver: true });
    expect(r.report?.request.address).toBe(T.sender);
    expect(r.report?.request.amount).toBe(5000);
    expect(r.report?.verdict).toBe("CAUTION"); // 5,000 USDT with no originator trips the Travel Rule floor
    expect(r.report?.flags).toContain("TRAVEL_RULE_DATA_REQUIRED");
    expect(r.report?.hardBlock).toBeUndefined();

    expect(r.sources.map((s) => s.address)).toEqual([T.binance, T.frozen, T.plain]);
    expect(r.sources[0]).toMatchObject({ status: "licensed", share: 0.6364, count: 2, total: 7000, frozen: false, sanctioned: false });
    expect(r.sources[0]!.label?.name).toContain("Binance");
    expect(r.sources[1]).toMatchObject({ status: "frozen", frozen: true, total: 2500 });
    expect(r.sources[2]).toMatchObject({ status: "unlabelled", frozen: false, total: 1500 });
    expect(r.sourcesNote).toMatch(/3 sources over 4 inbound transfers/);
    expect(r.report?.score).toBeLessThan(20); // sources are informational: a frozen source does not move the score yet
  });

  it("flags when the tx does not pay the stated receiver", async () => {
    const r = await screener.screen({ tx: T.hash, receiver: T.plain });
    expect(r.screened?.paysReceiver).toBe(false);
  });

  it("screens an Ethereum USDT transfer, keeps the look-alike token aside, and falls back to Blockscout for sources", async () => {
    const r = await screener.screen({ tx: E.hash, chain: "ethereum" });
    expect(r.screened).toMatchObject({ from: E.sender, value: 12000, genuine: true, paysReceiver: null });
    expect(r.otherTokens).toHaveLength(1);
    expect(r.otherTokens[0]).toMatchObject({ token: E.fake, from: E.sender, to: E.receiver }); // decimals unknown for a look-alike, value is best effort
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]).toMatchObject({ address: E.cp, share: 1, total: 20000, frozen: false, status: "unlabelled" });
  });

  it("does not screen anyone when the tx moved only a look-alike token", async () => {
    const r = await screener.screen({ tx: E.hashFake, chain: "ethereum" });
    expect(r.screened).toBeUndefined();
    expect(r.report).toBeUndefined();
    expect(r.sourcesNote).toMatch(/look-alike/);
    expect(r.otherTokens[0]?.token).toBe(E.fake);
  });

  it("says not found instead of guessing", async () => {
    const r = await screener.screen({ tx: T.hashNotFound });
    expect(r.tx.status).toBe("not_found");
    expect(r.sourcesNote).toMatch(/not found/);
  });

  it("rejects a link whose chain contradicts the selected chain", async () => {
    await expect(screener.screen({ tx: `https://tronscan.org/#/transaction/${T.hash}`, chain: "ethereum" })).rejects.toThrow(/Tron transaction but Ethereum/);
  });
});

describe("address links and the unified lookup", () => {
  it("reads explorer address links", () => {
    expect(parseAddressInput("https://tronscan.org/address/TPsMJ3BE9ixSQ7guFbVLZ4eou6SATBSqHH/transactions")).toEqual({ address: "TPsMJ3BE9ixSQ7guFbVLZ4eou6SATBSqHH", chain: "tron", inferredFrom: "url" });
    expect(parseAddressInput("https://tronscan.org/#/address/TPsMJ3BE9ixSQ7guFbVLZ4eou6SATBSqHH")).toMatchObject({ chain: "tron" });
    expect(parseAddressInput(`https://etherscan.io/address/${E.sender}`)).toMatchObject({ chain: "ethereum", address: E.sender });
    expect(parseAddressInput(`https://basescan.org/address/${E.sender}#tokentxns`)).toMatchObject({ chain: "base" });
    expect(parseAddressInput(E.sender)).toEqual({ address: E.sender, inferredFrom: "address-format" });
    expect(parseAddressInput(E.sender, "polygon")).toMatchObject({ chain: "polygon", inferredFrom: "none" });
    expect(() => parseAddressInput("https://tronscan.org/#/blocks")).toThrow(/no address/);
  });

  it("classifies the four input shapes", () => {
    expect(classifyInput(`https://tronscan.org/#/transaction/${T.hash}`).kind).toBe("tx");
    expect(classifyInput("https://tronscan.org/address/TPsMJ3BE9ixSQ7guFbVLZ4eou6SATBSqHH/transactions").kind).toBe("address");
    expect(classifyInput(T.hash).kind).toBe("tx");
    expect(classifyInput(T.sender).kind).toBe("address");
  });

  it("lookup on a Tron address link screens it and lists its sources", async () => {
    const r = await screener.lookup({ input: `https://tronscan.org/address/${T.sender}/transactions` });
    expect(r.kind).toBe("address");
    if (r.kind !== "address") return;
    expect(r.chain).toBe("tron");
    expect(r.report.request).toMatchObject({ address: T.sender, chain: "tron", asset: "USDT" });
    expect(r.report.verdict).toBe("CLEAR");
    expect(r.sources.map((s) => s.status)).toEqual(["licensed", "frozen", "unlabelled"]);
    expect(r.explorerUrl).toContain(T.sender);
  });

  it("lookup on a tx link routes to the tx screen", async () => {
    const r = await screener.lookup({ input: `https://tronscan.org/#/transaction/${T.hash}`, receiver: T.receiver });
    expect(r.kind).toBe("tx");
    if (r.kind !== "tx") return;
    expect(r.screened?.paysReceiver).toBe(true);
  });

  it("lookup refuses a bare EVM address without a chain", async () => {
    await expect(screener.lookup({ input: E.sender })).rejects.toThrow(/pick the chain/);
  });
});

describe("Tronscan fallback", () => {
  it("resolves a tx from transaction-info when TronGrid cannot serve it", async () => {
    const r = await new TxResolver(transport, {}).resolve(parseTxInput(T.hashScan));
    expect(r.source).toBe("tronscan");
    expect(r.status).toBe("confirmed");
    expect(r.transfers[0]).toMatchObject({ from: T.sender, to: T.receiver, value: 750 });
  });

  it("reports not_found when tronscan has no hash either", async () => {
    const r = await new TxResolver(transport, {}).resolve(parseTxInput("11".repeat(32)));
    expect(r.status).toBe("not_found");
    expect(r.source).toBe("tronscan");
  });

  it("reads inbound TRC-20 transfers from tronscan's public API", async () => {
    const ts = new TronscanExplorer(transport, {});
    const page = await ts.inboundTransfers(T.sender, canonicalToken("tron", "USDT")!, defaultWindow({ nowMs: NOW_MS }));
    expect(page.provider).toBe("tronscan");
    expect(page.transfers.map((t) => [t.from, t.value])).toEqual([[T.binance, 3000], [T.plain, 250]]);
    expect(page.truncated).toBe(false);
  });
});
