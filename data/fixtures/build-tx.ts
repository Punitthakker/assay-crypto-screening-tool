/**
 * Hand-encoded fixtures for screen-by-transaction. Regenerate with:
 *   pnpm exec tsx --tsconfig tsconfig.json data/fixtures/build-tx.ts
 * Control data only: addresses are derived from patterns, hashes are invented.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { tronHexToBase58, tronToHex } from "@cr/shared";

export const NOW_MS = Date.UTC(2026, 10, 2, 0, 0, 0);
const DAY = 86_400;
const nowS = Math.floor(NOW_MS / 1000);
const ago = (d: number) => nowS - d * DAY;

const USDT_TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ORACLE = "0x40c57923924b5c5c5455c48d93317139addac8fb";

const tronAddr = (n: number) => tronHexToBase58("41" + n.toString(16).padStart(40, "0"));
export const T = {
  sender: tronAddr(0xa1),
  receiver: tronAddr(0xb2),
  binance: "TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX",
  plain: tronAddr(0xc3),
  frozen: tronAddr(0xd4),
  hash: "9f".repeat(32),
  hashNotFound: "00".repeat(32),
};
export const E = {
  sender: "0x00000000000000000000000000000000000000a1",
  receiver: "0x00000000000000000000000000000000000000b2",
  cp: "0x00000000000000000000000000000000000000c3",
  fake: "0x00000000000000000000000000000000000000f4",
  hash: "0x" + "e1".repeat(32),
  hashFake: "0x" + "e2".repeat(32),
};

const pad = (hex20: string) => hex20.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const tronParam = (addr: string) => pad(tronToHex(addr).slice(2));
const tronKey = (addr: string) => `tron:${USDT_TRON}:isBlackListed(address):${tronParam(addr)}`;
const ZERO = "0x" + "0".repeat(64);
const ONE = "0x" + "0".repeat(63) + "1";
const hexFrom = (addr: string) => "0x" + tronToHex(addr).slice(2);

const f: Record<string, unknown> = {};

// ---- Tron: 5,000 USDT from sender to receiver ----
f[`url:https://api.trongrid.io/v1/transactions/${T.hash}/events`] = {
  data: [
    { block_number: 70_000_000, block_timestamp: ago(0.5) * 1000, caller_contract_address: USDT_TRON, contract_address: USDT_TRON, event_index: 0, event_name: "Transfer", result: { "0": hexFrom(T.sender), "1": hexFrom(T.receiver), "2": "5000000000", from: hexFrom(T.sender), to: hexFrom(T.receiver), value: "5000000000" }, result_type: { from: "address", to: "address", value: "uint256" }, event: "Transfer(address,address,uint256)", transaction_id: T.hash },
  ],
  success: true,
  meta: { at: NOW_MS, page_size: 1 },
};
f[`url:https://api.trongrid.io/v1/transactions/${T.hashNotFound}/events`] = { data: [], success: true, meta: { at: NOW_MS, page_size: 0 } };
f[tronKey(T.sender)] = ZERO;
f[tronKey(T.binance)] = ZERO;
f[tronKey(T.plain)] = ZERO;
f[tronKey(T.frozen)] = ONE;
{
  const q = new URLSearchParams({ only_to: "true", only_confirmed: "true", limit: "200", contract_address: USDT_TRON, min_timestamp: String(NOW_MS - 90 * DAY * 1000), order_by: "block_timestamp,desc" });
  const row = (id: string, d: number, from: string, value: string) => ({ transaction_id: id, token_info: { symbol: "USDT", address: USDT_TRON, decimals: 6, name: "Tether USD" }, block_timestamp: ago(d) * 1000, from, to: T.sender, type: "Transfer", value });
  f[`url:https://api.trongrid.io/v1/accounts/${T.sender}/transactions/trc20?${q.toString()}`] = {
    data: [row("s1", 1, T.binance, "6000000000"), row("s2", 3, T.plain, "1500000000"), row("s3", 9, T.frozen, "2500000000"), row("s4", 20, T.binance, "1000000000")],
    success: true,
    meta: { at: NOW_MS, page_size: 4 },
  };
}

// ---- Ethereum: 12,000 USDT from sender to receiver, plus a look-alike token in the same tx ----
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a: string) => "0x" + pad(a);
const uint = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
f[`receipt:ethereum:${E.hash}`] = {
  hash: E.hash, status: "success", blockNumber: 21_500_000, timestamp: ago(0.25), from: E.sender, to: USDT_ETH,
  logs: [
    { address: USDT_ETH, topics: [TRANSFER_TOPIC, topic(E.sender), topic(E.receiver)], data: uint(12_000_000_000n) },
    { address: E.fake, topics: [TRANSFER_TOPIC, topic(E.sender), topic(E.receiver)], data: uint(12_000_000_000n) },
  ],
};
f[`receipt:ethereum:${E.hashFake}`] = {
  hash: E.hashFake, status: "success", blockNumber: 21_500_001, timestamp: ago(0.2), from: E.sender, to: E.fake,
  logs: [{ address: E.fake, topics: [TRANSFER_TOPIC, topic(E.sender), topic(E.receiver)], data: uint(12_000_000_000n) }],
};
f[`evm:ethereum:${USDT_ETH.toLowerCase()}:0xe47d6060${pad(E.sender)}`] = ZERO;
f[`evm:ethereum:${USDT_ETH.toLowerCase()}:0xe47d6060${pad(E.cp)}`] = ZERO;
f[`evm:ethereum:${ORACLE}:0xdf592f7d${pad(E.sender)}`] = ZERO;
{
  const q = new URLSearchParams({ type: "ERC-20", filter: "to", token: USDT_ETH });
  f[`url:https://eth.blockscout.com/api/v2/addresses/${E.sender}/token-transfers?${q.toString()}`] = {
    items: [
      { transaction_hash: "0xb1", timestamp: new Date(ago(2) * 1000).toISOString(), block_number: 21_400_000, from: { hash: E.cp }, to: { hash: E.sender }, token: { address: USDT_ETH, decimals: "6" }, total: { value: "20000000000", decimals: "6" } },
    ],
    next_page_params: null,
  };
}

const out = path.resolve(import.meta.dirname, "tx.json");
writeFileSync(out, JSON.stringify(f, null, 2) + "\n");
console.log(`wrote ${Object.keys(f).length} fixtures to ${out}`);
console.log(JSON.stringify({ T, E }));
