/**
 * Hand-encoded fixtures for the end-to-end behavioural-signal tests (engine + explorer + activity + trace).
 * Regenerate with:  pnpm exec tsx --tsconfig tsconfig.json data/fixtures/build-behaviour.ts
 * Invented control data, never a claim about a real wallet.
 *
 * Case A (SCORING.md worked example 1): fresh benign EOA receiving USDC on Base, Etherscan key set.
 *   2 days old, nonce 3, two unlabelled counterparties (60/40), nothing else. Expect 16, CLEAR, confidence high.
 * Case B (mule on Tron, keyless): 5 x 2,900 USDT in from W then 2,899 out within 3 minutes each time, one small
 *   transfer from V. Expect pass-through 15 + structuring 12 + concentration 6 = 33, LOW; approvals are not
 *   evaluated on Tron so the behaviour line reads partial, confidence still high.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { encodeFunctionData, parseAbi } from "viem";
import { tronHexToBase58, tronToHex } from "@cr/shared";

export const BEHAV_NOW_MS = Date.UTC(2026, 10, 3, 0, 0, 0);
const DAY = 86_400;
const nowS = Math.floor(BEHAV_NOW_MS / 1000);
const ago = (d: number) => nowS - d * DAY;

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ORACLE_BASE = "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B";
const USDT_TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const tronAddr = (n: number) => tronHexToBase58("41" + n.toString(16).padStart(40, "0"));

export const BEHAV_ADDR = {
  fresh: "0xf5e5000000000000000000000000000000000001",
  x1: "0xf5e5000000000000000000000000000000000002",
  x2: "0xf5e5000000000000000000000000000000000003",
  mule: tronAddr(0xe1),
  w: tronAddr(0xe2),
  v: tronAddr(0xe3),
  z: tronAddr(0xe4),
};

const ABI = parseAbi(["function isBlacklisted(address) view returns (bool)", "function isSanctioned(address) view returns (bool)"]);
const FALSE = "0x" + "0".repeat(64);
const f: Record<string, unknown> = {};

/* ---------------- Case A: Base USDC, Etherscan V2 ---------------- */

const es = (params: Record<string, string>) => {
  const q = new URLSearchParams({ chainid: "8453", ...params });
  q.set("apikey", "REDACTED");
  return `url:https://api.etherscan.io/v2/api?${q.toString()}`;
};
const tokentx = (address: string) => es({ module: "account", action: "tokentx", contractaddress: USDC_BASE, address, page: "1", offset: "200", sort: "desc" });
const esRow = (hash: string, ts: number, from: string, to: string, value: string) => ({
  blockNumber: String(30_000_000 + (nowS - ts)), timeStamp: String(ts), hash, nonce: "1", blockHash: "0xabc", from, contractAddress: USDC_BASE.toLowerCase(), to, value, tokenName: "USD Coin", tokenSymbol: "USDC", tokenDecimal: "6", transactionIndex: "1", gas: "1", gasPrice: "1", gasUsed: "1", cumulativeGasUsed: "1", input: "deprecated", confirmations: "100",
});
const NONE = { status: "0", message: "No transactions found", result: "No transactions found" };

f[tokentx(BEHAV_ADDR.fresh)] = {
  status: "1", message: "OK",
  result: [
    esRow("0xf001", ago(1), BEHAV_ADDR.x1, BEHAV_ADDR.fresh, "600000000"),
    esRow("0xf002", ago(1.5), BEHAV_ADDR.x2, BEHAV_ADDR.fresh, "400000000"),
  ],
};
f[tokentx(BEHAV_ADDR.x1)] = NONE;
f[tokentx(BEHAV_ADDR.x2)] = NONE;
// account activity: first tx 2 days ago, three txs in all, nonce 3, plain EOA
const txRow = (ts: number, hash: string) => ({ blockNumber: String(30_000_000 + (nowS - ts)), timeStamp: String(ts), hash, nonce: "0", from: BEHAV_ADDR.fresh, to: BEHAV_ADDR.x1, value: "0", isError: "0" });
f[es({ module: "account", action: "txlist", address: BEHAV_ADDR.fresh, page: "1", offset: "1", sort: "asc" })] = { status: "1", message: "OK", result: [txRow(ago(2), "0xa001")] };
f[es({ module: "account", action: "txlist", address: BEHAV_ADDR.fresh, page: "1", offset: "25", sort: "desc" })] = { status: "1", message: "OK", result: [txRow(ago(0.5), "0xa003"), txRow(ago(1), "0xa002"), txRow(ago(2), "0xa001")] };
f[`nonce:base:${BEHAV_ADDR.fresh}`] = 3;
f[`code:base:${BEHAV_ADDR.fresh}`] = "0x";
f[es({ module: "logs", action: "getLogs", address: USDC_BASE, fromBlock: "0", toBlock: "latest", topic0: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", topic0_1_opr: "and", topic1: "0x" + BEHAV_ADDR.fresh.slice(2).padStart(64, "0"), page: "1", offset: "1000" })] = { status: "0", message: "No records found", result: "No records found" };
// hard checks
const freezeBase = (addr: string) => `evm:base:${USDC_BASE.toLowerCase()}:${encodeFunctionData({ abi: ABI, functionName: "isBlacklisted", args: [addr as `0x${string}`] })}`;
for (const a of [BEHAV_ADDR.fresh, BEHAV_ADDR.x1, BEHAV_ADDR.x2]) f[freezeBase(a)] = FALSE;
f[`evm:base:${ORACLE_BASE.toLowerCase()}:${encodeFunctionData({ abi: ABI, functionName: "isSanctioned", args: [BEHAV_ADDR.fresh as `0x${string}`] })}`] = FALSE;

/* ---------------- Case B: Tron USDT, TronGrid keyless ---------------- */

const tg = (address: string, dir: "only_to" | "only_from") => {
  const q = new URLSearchParams({ [dir]: "true", only_confirmed: "true", limit: "200", contract_address: USDT_TRON, min_timestamp: String(BEHAV_NOW_MS - 90 * DAY * 1000), order_by: "block_timestamp,desc" });
  return `url:https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?${q.toString()}`;
};
const tgRow = (id: string, ts: number, from: string, to: string, value: string) => ({ transaction_id: id, token_info: { symbol: "USDT", address: USDT_TRON, decimals: 6, name: "Tether USD" }, block_timestamp: ts * 1000, from, to, type: "Transfer", value });
const inRows = [2, 4, 6, 8, 10].map((d, i) => tgRow(`b1${i}`, ago(d), BEHAV_ADDR.w, BEHAV_ADDR.mule, "2900000000"));
inRows.push(tgRow("b1v", ago(12), BEHAV_ADDR.v, BEHAV_ADDR.mule, "100000000"));
const outRows = [2, 4, 6, 8, 10].map((d, i) => tgRow(`b2${i}`, ago(d) + 180, BEHAV_ADDR.mule, BEHAV_ADDR.z, "2899000000"));
outRows.push(tgRow("b2v", ago(12) + 180, BEHAV_ADDR.mule, BEHAV_ADDR.z, "99000000"));
f[tg(BEHAV_ADDR.mule, "only_to")] = { data: inRows, success: true, meta: { at: BEHAV_NOW_MS, page_size: inRows.length } };
f[tg(BEHAV_ADDR.mule, "only_from")] = { data: outRows, success: true, meta: { at: BEHAV_NOW_MS, page_size: outRows.length } };
f[tg(BEHAV_ADDR.w, "only_to")] = { data: [], success: true, meta: { at: BEHAV_NOW_MS, page_size: 0 } };
f[tg(BEHAV_ADDR.v, "only_to")] = { data: [], success: true, meta: { at: BEHAV_NOW_MS, page_size: 0 } };
// account: 400 days old, busy, latest op 2 days ago
f[`url:https://api.trongrid.io/v1/accounts/${BEHAV_ADDR.mule}`] = { data: [{ address: tronToHex(BEHAV_ADDR.mule), balance: 1_000_000, create_time: ago(400) * 1000, latest_opration_time: ago(2) * 1000 }], success: true, meta: { at: BEHAV_NOW_MS, page_size: 1 } };
f[`url:https://apilist.tronscanapi.com/api/accountv2?address=${BEHAV_ADDR.mule}`] = { address: BEHAV_ADDR.mule, date_created: ago(400) * 1000, latest_operation_time: ago(2) * 1000, transactions: 14, transactions_in: 6, transactions_out: 8, accountType: 0 };
// freeze reads
const pad = (hex20: string) => hex20.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const tronKey = (addr: string) => `tron:${USDT_TRON}:isBlackListed(address):${pad(tronToHex(addr).slice(2))}`;
for (const a of [BEHAV_ADDR.mule, BEHAV_ADDR.w, BEHAV_ADDR.v]) f[tronKey(a)] = FALSE;

const out = path.resolve(import.meta.dirname, "behaviour.json");
writeFileSync(out, JSON.stringify(f, null, 2) + "\n");
console.log(`wrote ${Object.keys(f).length} fixtures to ${out}`);
