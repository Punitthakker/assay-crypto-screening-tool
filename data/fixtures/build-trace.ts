/**
 * Hand-encoded fixtures for the end-to-end trace test (engine + explorer + freeze + oracle).
 * Regenerate with:  pnpm tsx data/fixtures/build-trace.ts
 * Invented control data, never a claim about a real wallet. Label addresses come from data/labels/seed.json.
 *
 * Graph (Ethereum USDT, window pinned to 2026-11-02):
 *   SENDER  <- 1000 from A (unlabelled)       A <- 120 from Tornado Cash Router (mixer), 880 from B (unlabelled)
 *   SENDER  <-  500 from Binance 15 (licensed, trace boundary)
 * Expected: mixer share (1000/1500) x (120/1000) x 0.5 = 0.04 -> 2.2 points -> dust rule floor 8 -> CLEAR, confidence high.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { encodeFunctionData, parseAbi } from "viem";

export const TRACE_NOW_MS = Date.UTC(2026, 10, 2, 0, 0, 0);
const DAY = 86_400;
const nowS = Math.floor(TRACE_NOW_MS / 1000);
const daysAgo = (d: number) => nowS - d * DAY;

export const TRACE_ADDR = {
  sender: "0x5e0d000000000000000000000000000000000001",
  a: "0xa1a1000000000000000000000000000000000002",
  b: "0xb1b1000000000000000000000000000000000003",
  mixer: "0x722122dF12D4e14e13Ac3b6895a86e84145b6967",
  binance: "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549",
};

const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ORACLE = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb";

function etherscanUrl(address: string) {
  const q = new URLSearchParams({ chainid: "1", module: "account", action: "tokentx", contractaddress: USDT_ETH, address, page: "1", offset: "200", sort: "desc" });
  q.set("apikey", "REDACTED");
  return `url:https://api.etherscan.io/v2/api?${q.toString()}`;
}
const esRow = (hash: string, ts: number, from: string, to: string, value: string) => ({
  blockNumber: String(20_000_000 + (nowS - ts)), timeStamp: String(ts), hash, nonce: "1", blockHash: "0xabc", from, contractAddress: USDT_ETH, to, value, tokenName: "Tether USD", tokenSymbol: "USDT", tokenDecimal: "6", transactionIndex: "1", gas: "1", gasPrice: "1", gasUsed: "1", cumulativeGasUsed: "1", input: "deprecated", confirmations: "100",
});

const ABI = parseAbi(["function isBlackListed(address) view returns (bool)", "function isSanctioned(address) view returns (bool)"]);
const FALSE = "0x0000000000000000000000000000000000000000000000000000000000000000";
const freezeKey = (addr: string) => `evm:ethereum:${USDT_ETH.toLowerCase()}:${encodeFunctionData({ abi: ABI, functionName: "isBlackListed", args: [addr as `0x${string}`] })}`;
const oracleKey = (addr: string) => `evm:ethereum:${ORACLE.toLowerCase()}:${encodeFunctionData({ abi: ABI, functionName: "isSanctioned", args: [addr as `0x${string}`] })}`;

const fixtures: Record<string, unknown> = {};

fixtures[etherscanUrl(TRACE_ADDR.sender)] = {
  status: "1", message: "OK",
  result: [
    esRow("0x7a01", daysAgo(3), TRACE_ADDR.a, TRACE_ADDR.sender, "1000000000"),
    esRow("0x7a02", daysAgo(9), TRACE_ADDR.binance, TRACE_ADDR.sender, "500000000"),
    esRow("0x7a03", daysAgo(12), TRACE_ADDR.sender, TRACE_ADDR.b, "50000000"), // outbound, ignored
  ],
};
fixtures[etherscanUrl(TRACE_ADDR.a)] = {
  status: "1", message: "OK",
  result: [
    esRow("0x7b01", daysAgo(5), TRACE_ADDR.mixer, TRACE_ADDR.a, "120000000"),
    esRow("0x7b02", daysAgo(6), TRACE_ADDR.b, TRACE_ADDR.a, "880000000"),
  ],
};
// Binance is a boundary and the mixer is labelled: neither is ever fetched, so no fixture exists for them on purpose.
for (const a of [TRACE_ADDR.sender, TRACE_ADDR.a, TRACE_ADDR.b]) fixtures[freezeKey(a)] = FALSE;
fixtures[oracleKey(TRACE_ADDR.sender)] = FALSE;

const out = path.resolve(import.meta.dirname, "trace.json");
writeFileSync(out, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${out}`);
