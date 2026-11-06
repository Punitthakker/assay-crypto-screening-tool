import { describe, expect, it } from "vitest";
import { canonicalToken, tronToHex } from "@cr/shared";
import type { Transport } from "../transport.js";
import { FreezeIndex, FreezeIndexer, emptyIndex, freezeEventsFor, indexFileName, topicFor, tronAddress, type FreezeIndexFile } from "./freeze-events.js";

/**
 * Hand-encoded provider responses, no network: shapes follow the Etherscan V2 getLogs,
 * Blockscout /api and TronGrid /v1/contracts/{c}/events documentation. Addresses and
 * hashes are invented control data.
 */

const USDT = canonicalToken("ethereum", "USDT")!;
const USDC = canonicalToken("ethereum", "USDC")!;
const USDT_TRON = canonicalToken("tron", "USDT")!;
const USDC_SOL = canonicalToken("solana", "USDC")!;

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";
const C = "0xcccc000000000000000000000000000000000003";
const T1 = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

const pad = (addr: string) => `0x${addr.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
const hex = (n: number) => `0x${n.toString(16)}`;
const log = (topic0: string, block: number, ts: number, tx: string, addrIn: "topic1" | "data", addr: string, amount?: bigint) => ({
  address: USDT.address.toLowerCase(),
  topics: addrIn === "topic1" ? [topic0, pad(addr)] : [topic0],
  data: addrIn === "data" ? `${pad(addr)}${amount !== undefined ? amount.toString(16).padStart(64, "0") : ""}` : "0x",
  blockNumber: hex(block),
  timeStamp: hex(ts),
  transactionHash: tx,
  logIndex: "0x1",
});

/** Transport stub answering fetchJson by URL; every other method throws so a stray call fails the test. */
function stub(routes: Record<string, unknown | ((url: string) => unknown)>): Transport & { calls: string[] } {
  const calls: string[] = [];
  const nope = () => Promise.reject(new Error("not expected"));
  return {
    mode: "fixture",
    calls,
    evmCall: nope,
    evmGetCode: nope,
    evmGetTransactionCount: nope,
    evmGetTransactionReceipt: nope,
    tronConstantCall: nope,
    solanaTokenAccounts: nope,
    fetchText: nope,
    fetchJson: async <T>(url: string) => {
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) throw new Error(`no route for ${url}`);
      const r = routes[key];
      return (typeof r === "function" ? (r as (u: string) => unknown)(url) : r) as T;
    },
  };
}

const [ADDED, REMOVED, DESTROYED] = freezeEventsFor(USDT)!;
const [BLACKLISTED, UNBLACKLISTED] = freezeEventsFor(USDC)!;
const empty = { status: "0", message: "No records found", result: "No records found" };

describe("event sets and selectors", () => {
  it("Tether logs the address in data, Circle in topic1; Solana and bridged tokens have no log", () => {
    expect(freezeEventsFor(USDT)!.map((d) => `${d.name}:${d.addressIn}`)).toEqual(["AddedBlackList:data", "RemovedBlackList:data", "DestroyedBlackFunds:data"]);
    expect(freezeEventsFor(USDC)!.map((d) => `${d.name}:${d.addressIn}`)).toEqual(["Blacklisted:topic1", "UnBlacklisted:topic1"]);
    expect(freezeEventsFor(USDT_TRON)!.map((d) => d.name)).toEqual(["AddedBlackList", "RemovedBlackList", "DestroyedBlackFunds"]);
    expect(freezeEventsFor(USDC_SOL)).toBeUndefined();
    expect(freezeEventsFor(canonicalToken("bnb", "USDT") ?? { ...USDT, freeze: { kind: "none" } })).toBeUndefined();
  });

  it("topic0 values are the keccak selectors of the published signatures", () => {
    expect(topicFor(ADDED!)).toBe("0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc");
    expect(topicFor(REMOVED!)).toBe("0xd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c");
    expect(topicFor(DESTROYED!)).toBe("0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6");
    expect(topicFor(BLACKLISTED!)).toBe("0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855");
    expect(topicFor(UNBLACKLISTED!)).toBe("0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e");
  });

  it("tron event addresses are accepted as base58, 41-hex or 0x-hex", () => {
    const h41 = tronToHex(T1);
    expect(tronAddress(T1)).toBe(T1);
    expect(tronAddress(h41)).toBe(T1);
    expect(tronAddress(`0x${h41.slice(2)}`)).toBe(T1);
    expect(tronAddress("garbage")).toBeUndefined();
  });
});

describe("FreezeIndexer on Etherscan V2 (Tether, non-indexed address)", () => {
  const routes = {
    [`topic0=${topicFor(ADDED!)}`]: { status: "1", result: [log(topicFor(ADDED!), 100, 1_700_000_000, "0xadd1", "data", A), log(topicFor(ADDED!), 200, 1_700_100_000, "0xadd2", "data", B)] },
    [`topic0=${topicFor(REMOVED!)}`]: { status: "1", result: [log(topicFor(REMOVED!), 300, 1_700_200_000, "0xrem1", "data", A)] },
    [`topic0=${topicFor(DESTROYED!)}`]: { status: "1", result: [log(topicFor(DESTROYED!), 250, 1_700_150_000, "0xdes1", "data", B, 12_500_000n)] },
  };

  it("builds the table from genesis, sorted by block, with amounts decoded and the cursor at the highest block", async () => {
    const t = stub(routes);
    const ix = new FreezeIndexer(t, { ETHERSCAN_API_KEY: "k" });
    expect(ix.providerFor(USDT)).toEqual({ provider: "etherscan-v2" });
    const r = await ix.update(USDT);
    expect(r.added).toBe(4);
    expect(r.pages).toBe(3);
    expect(r.file.events.map((e) => `${e.block}:${e.type}:${e.address}`)).toEqual([`100:added:${A}`, `200:added:${B}`, `250:destroyed:${B}`, `300:removed:${A}`]);
    expect(r.file.events[2]!.amountBase).toBe("12500000");
    expect(r.file.cursor.block).toBe(300);
    expect(r.file.provider).toBe("etherscan-v2");
    expect(t.calls[0]).toContain("chainid=1");
    expect(t.calls[0]).toContain("module=logs&action=getLogs");
    expect(t.calls[0]).toContain("fromBlock=0");
    expect(t.calls[0]).toContain(`address=${USDT.address}`);
  });

  it("resumes from the stored cursor and dedupes an overlapping read", async () => {
    const t = stub({
      [`topic0=${topicFor(ADDED!)}`]: (url: string) => (url.includes("fromBlock=301") ? { status: "1", result: [log(topicFor(ADDED!), 400, 1_700_300_000, "0xadd3", "data", C)] } : { status: "1", result: [] }),
      [`topic0=${topicFor(REMOVED!)}`]: empty,
      [`topic0=${topicFor(DESTROYED!)}`]: empty,
    });
    const ix = new FreezeIndexer(t, { ETHERSCAN_API_KEY: "k" });
    const first = await new FreezeIndexer(stub(routes), { ETHERSCAN_API_KEY: "k" }).update(USDT);
    const r = await ix.update(USDT, first.file);
    expect(t.calls.every((u) => u.includes("fromBlock=301"))).toBe(true);
    expect(r.added).toBe(1);
    expect(r.file.events).toHaveLength(5);
    expect(r.file.cursor.block).toBe(400);
    // same page again: nothing new
    const again = await ix.update(USDT, r.file);
    expect(again.added).toBe(0);
    expect(again.file.events).toHaveLength(5);
  });

  it("walks full pages by resuming at the last block seen, without duplicating the boundary log", async () => {
    const calls: string[] = [];
    const t = stub({
      [`topic0=${topicFor(ADDED!)}`]: (url: string) => {
        calls.push(url);
        if (url.includes("fromBlock=0")) return { status: "1", result: [log(topicFor(ADDED!), 10, 1, "0xa", "data", A), log(topicFor(ADDED!), 20, 2, "0xb", "data", B)] };
        if (url.includes("fromBlock=20")) return { status: "1", result: [log(topicFor(ADDED!), 20, 2, "0xb", "data", B), log(topicFor(ADDED!), 30, 3, "0xc", "data", C)] };
        return { status: "1", result: [log(topicFor(ADDED!), 30, 3, "0xc", "data", C)] };
      },
      [`topic0=${topicFor(REMOVED!)}`]: empty,
      [`topic0=${topicFor(DESTROYED!)}`]: empty,
    });
    const r = await new FreezeIndexer(t, { ETHERSCAN_API_KEY: "k" }, { pageSize: 2 }).update(USDT);
    expect(calls.map((u) => u.match(/fromBlock=(\d+)/)![1])).toEqual(["0", "20", "30"]);
    expect(r.file.events.map((e) => e.txHash)).toEqual(["0xa", "0xb", "0xc"]);
    expect(r.file.cursor.block).toBe(30);
  });

  it("throws on a provider error so no cursor is written", async () => {
    const t = stub({ "module=logs": { status: "0", message: "NOTOK", result: "Max rate limit reached" } });
    await expect(new FreezeIndexer(t, { ETHERSCAN_API_KEY: "k" }).update(USDT)).rejects.toThrow(/Max rate limit/);
  });
});

describe("FreezeIndexer on Blockscout and Circle (indexed address)", () => {
  it("falls back to the hosted Blockscout /api without a key and reads the address from topic1", async () => {
    const t = stub({
      [`topic0=${topicFor(BLACKLISTED!)}`]: { status: "1", result: [log(topicFor(BLACKLISTED!), 500, 1_700_000_000, "0xbl1", "topic1", A)] },
      [`topic0=${topicFor(UNBLACKLISTED!)}`]: { status: "0", message: "No logs found", result: null },
    });
    const ix = new FreezeIndexer(t, {});
    expect(ix.providerFor(USDC)).toEqual({ provider: "blockscout" });
    const r = await ix.update(USDC);
    expect(t.calls[0]!.startsWith("https://eth.blockscout.com/api?module=logs")).toBe(true);
    expect(t.calls[0]).not.toContain("apikey");
    expect(r.file.events).toEqual([{ type: "added", address: A, block: 500, timestamp: 1_700_000_000, txHash: "0xbl1" }]);
  });

  it("names the missing provider for a chain with neither key nor Blockscout host, and the reason for Solana", () => {
    const ix = new FreezeIndexer(stub({}), {});
    expect(ix.providerFor(canonicalToken("avalanche", "USDT")!)).toEqual({ reason: "no log provider for avalanche: set ETHERSCAN_API_KEY or BLOCKSCOUT_AVALANCHE" });
    expect(ix.providerFor(USDC_SOL)).toEqual({ reason: "Solana freezes are per token account, no event log to index" });
  });
});

describe("FreezeIndexer on TronGrid", () => {
  const h41 = tronToHex(T1);
  it("pages with the fingerprint, decodes addresses and resumes from the stored timestamp", async () => {
    const t = stub({
      "event_name=AddedBlackList": (url: string) =>
        url.includes("fingerprint=fp1")
          ? { success: true, data: [{ block_number: 61_000_000, block_timestamp: 1_700_000_200_000, transaction_id: "t2", event_name: "AddedBlackList", result: { _user: `0x${h41.slice(2)}` } }], meta: {} }
          : { success: true, data: [{ block_number: 60_000_000, block_timestamp: 1_700_000_100_000, transaction_id: "t1", event_name: "AddedBlackList", result: { _user: h41 } }], meta: { fingerprint: "fp1" } },
      "event_name=RemovedBlackList": { success: true, data: [], meta: {} },
      "event_name=DestroyedBlackFunds": { success: true, data: [{ block_number: 62_000_000, block_timestamp: 1_700_000_300_000, transaction_id: "t3", event_name: "DestroyedBlackFunds", result: { _blackListedUser: T1, _balance: "5000000" } }], meta: {} },
    });
    const ix = new FreezeIndexer(t, { TRONGRID_API_KEY: "k" });
    const r = await ix.update(USDT_TRON);
    expect(r.file.provider).toBe("trongrid");
    expect(r.file.events.map((e) => `${e.type}:${e.address}:${e.txHash}`)).toEqual([`added:${T1}:t1`, `added:${T1}:t2`, `destroyed:${T1}:t3`]);
    expect(r.file.events[2]!.amountBase).toBe("5000000");
    expect(r.file.cursor).toEqual({ block: 62_000_000, timestampMs: 1_700_000_300_000 });
    expect(t.calls[0]).toContain(`/v1/contracts/${USDT_TRON.address}/events?`);
    expect(t.calls[0]).not.toContain("min_block_timestamp");
    // incremental run asks for everything after the cursor
    const t2 = stub({ "event_name=": { success: true, data: [], meta: {} } });
    await new FreezeIndexer(t2, {}).update(USDT_TRON, r.file);
    expect(t2.calls.every((u) => u.includes("min_block_timestamp=1700000300001"))).toBe(true);
  });
});

describe("FreezeIndex (read side)", () => {
  const file: FreezeIndexFile = {
    ...emptyIndex(USDT, "test"),
    updatedAt: "2026-11-05T00:00:00.000Z",
    cursor: { block: 300 },
    events: [
      { type: "added", address: A, block: 100, timestamp: 1_700_000_000, txHash: "0xadd1" },
      { type: "added", address: B, block: 200, timestamp: 1_700_100_000, txHash: "0xadd2" },
      { type: "destroyed", address: B, block: 250, timestamp: 1_700_150_000, txHash: "0xdes1", amountBase: "12500000" },
      { type: "removed", address: A, block: 300, timestamp: 1_700_200_000, txHash: "0xrem1" },
    ],
  };
  const index = new FreezeIndex({ files: [file], nowMs: Date.parse("2026-11-06T12:00:00Z") });

  it("tells a released address from one still listed, and never-frozen from not-indexed", () => {
    const a = index.history(A, USDT)!;
    expect(a.everFrozen).toBe(true);
    expect(a.listedPerIndex).toBe(false);
    expect(a.releasedAt).toBe(1_700_200_000);
    expect(a.firstFrozenAt).toBe(1_700_000_000);
    const b = index.history(B.toUpperCase().replace("0X", "0x"), USDT)!;
    expect(b.listedPerIndex).toBe(true);
    expect(b.releasedAt).toBeUndefined();
    expect(b.destroyed).toBe(1);
    expect(b.destroyedBase).toBe("12500000");
    const c = index.history(C, USDT)!;
    expect(c.everFrozen).toBe(false);
    expect(index.history(A, USDC)).toBeNull();
  });

  it("coverage says indexed with age, or why not", () => {
    expect(index.coverage(USDT)).toEqual({ indexed: true, provider: "test", updatedAt: "2026-11-05T00:00:00.000Z", ageHours: 36, events: 4, cursor: 300 });
    expect(index.coverage(USDC).reason).toBe("no freeze index for USDC on ethereum; run pnpm index:freeze");
    expect(index.coverage(USDC_SOL).reason).toBe("Solana freezes are per token account, no event log");
    expect(index.tokens).toEqual([{ chain: "ethereum", token: USDT.address, symbol: "USDT", events: 4, addresses: 2, updatedAt: "2026-11-05T00:00:00.000Z" }]);
  });

  it("an empty directory means nothing is indexed", () => {
    const ix = new FreezeIndex("/nonexistent/freeze-index");
    expect(ix.tokens).toEqual([]);
    expect(ix.history(A, USDT)).toBeNull();
    expect(indexFileName(USDT_TRON)).toBe("tron-usdt.json");
  });
});
