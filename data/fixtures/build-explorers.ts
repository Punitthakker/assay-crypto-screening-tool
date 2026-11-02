/**
 * Hand-encoded explorer fixtures. Regenerate with:
 *   pnpm tsx data/fixtures/build-explorers.ts
 * Shapes follow each provider's documented response; values are invented control data,
 * never a claim about a real wallet. Keys use the same URL construction as the adapters,
 * with provider keys redacted (see redactUrl in transport.ts).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

export const FIXTURE_NOW_MS = Date.UTC(2026, 10, 2, 0, 0, 0); // 2026-11-02T00:00:00Z
const DAY = 86_400;
const nowS = Math.floor(FIXTURE_NOW_MS / 1000);
const daysAgo = (d: number) => nowS - d * DAY;

export const ADDR = {
  ethA: "0xA000000000000000000000000000000000000001",
  baseB: "0xB000000000000000000000000000000000000002",
  arbC: "0xC000000000000000000000000000000000000003",
  avaxD: "0xD000000000000000000000000000000000000004",
  ethEmpty: "0xE000000000000000000000000000000000000005",
  tron: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
  sol: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  cp1: "0x1111111111111111111111111111111111111111",
  cp2: "0x2222222222222222222222222222222222222222",
  cp3: "0x3333333333333333333333333333333333333333",
};

const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDT_AVAX = "0x9702230A8Ea53601f5Cd2dc00fDbc13d4dF4A8c7";
const USDT_TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function etherscanUrl(chainid: number, contract: string, address: string, page = 1, key = true) {
  const q = new URLSearchParams({ chainid: String(chainid), module: "account", action: "tokentx", contractaddress: contract, address, page: String(page), offset: "200", sort: "desc" });
  if (key) q.set("apikey", "REDACTED");
  return `url:https://api.etherscan.io/v2/api?${q.toString()}`;
}
function routescanUrl(contract: string, address: string, page = 1) {
  const q = new URLSearchParams({ chainid: "43114", module: "account", action: "tokentx", contractaddress: contract, address, page: String(page), offset: "200", sort: "desc" });
  return `url:https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?${q.toString()}`;
}
function blockscoutUrl(host: string, address: string, token: string, next?: Record<string, unknown>) {
  const q = new URLSearchParams({ type: "ERC-20", filter: "to", token });
  if (next) for (const [k, v] of Object.entries(next)) q.set(k, String(v));
  return `url:${host}/api/v2/addresses/${address}/token-transfers?${q.toString()}`;
}
function tronUrl(address: string, contract: string, startMs: number) {
  const q = new URLSearchParams({ only_to: "true", only_confirmed: "true", limit: "200", contract_address: contract, min_timestamp: String(startMs), order_by: "block_timestamp,desc" });
  return `url:https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?${q.toString()}`;
}
function heliusUrl(address: string) {
  const q = new URLSearchParams({ "api-key": "REDACTED", limit: "100", type: "TRANSFER" });
  return `url:https://api.helius.xyz/v0/addresses/${address}/transactions?${q.toString()}`;
}

const esRow = (hash: string, ts: number, from: string, to: string, value: string, contract = USDT_ETH, dec = "6") => ({
  blockNumber: String(20_000_000 + (nowS - ts)), timeStamp: String(ts), hash, nonce: "1", blockHash: "0xabc", from, contractAddress: contract, to, value, tokenName: "Tether USD", tokenSymbol: "USDT", tokenDecimal: dec, transactionIndex: "1", gas: "1", gasPrice: "1", gasUsed: "1", cumulativeGasUsed: "1", input: "deprecated", confirmations: "100",
});
const bsItem = (hash: string, ts: number, from: string, to: string, token: string, value: string, block: number) => ({
  transaction_hash: hash, timestamp: new Date(ts * 1000).toISOString(), block_number: block, type: "token_transfer", method: "transfer",
  from: { hash: from, is_contract: false }, to: { hash: to, is_contract: false },
  token: { address: token, decimals: "6", symbol: "USDC", type: "ERC-20" }, total: { value, decimals: "6" },
});

const fixtures: Record<string, unknown> = {};

// 1. Etherscan V2, Ethereum USDT: two inbound in window, one outbound, one inbound outside the window
fixtures[etherscanUrl(1, USDT_ETH, ADDR.ethA)] = {
  status: "1", message: "OK",
  result: [
    esRow("0xf001", daysAgo(2), ADDR.cp1, ADDR.ethA, "1000000000"),
    esRow("0xf002", daysAgo(5), ADDR.ethA, ADDR.cp2, "400000000"),
    esRow("0xf003", daysAgo(30), ADDR.cp2, ADDR.ethA, "250500000"),
    esRow("0xf004", daysAgo(120), ADDR.cp3, ADDR.ethA, "99000000"),
  ],
};
// 2. Etherscan rate-limited on Base; Blockscout answers
fixtures[etherscanUrl(8453, USDC_BASE, ADDR.baseB)] = { status: "0", message: "NOTOK", result: "Max rate limit reached" };
fixtures[blockscoutUrl("https://base.blockscout.com", ADDR.baseB, USDC_BASE)] = {
  items: [bsItem("0xb001", daysAgo(1), ADDR.cp1, ADDR.baseB, USDC_BASE, "75000000", 30_000_000)],
  next_page_params: null,
};
// 3. Etherscan, no transactions
fixtures[etherscanUrl(1, USDT_ETH, ADDR.ethEmpty)] = { status: "0", message: "No transactions found", result: [] };
// 4. Blockscout pagination on Arbitrum USDC (no Etherscan key in that test)
fixtures[blockscoutUrl("https://arbitrum.blockscout.com", ADDR.arbC, USDC_ARB)] = {
  items: [
    bsItem("0xa001", daysAgo(3), ADDR.cp1, ADDR.arbC, USDC_ARB, "10000000", 300_000_100),
    bsItem("0xa002", daysAgo(10), ADDR.cp2, ADDR.arbC, USDC_ARB, "20000000", 300_000_050),
  ],
  next_page_params: { block_number: 300000050, index: 7, items_count: 50 },
};
fixtures[blockscoutUrl("https://arbitrum.blockscout.com", ADDR.arbC, USDC_ARB, { block_number: 300000050, index: 7, items_count: 50 })] = {
  items: [bsItem("0xa003", daysAgo(40), ADDR.cp3, ADDR.arbC, USDC_ARB, "30000000", 299_000_000)],
  next_page_params: null,
};
// 5. Routescan for Avalanche (no Etherscan key, no Blockscout host)
fixtures[routescanUrl(USDT_AVAX, ADDR.avaxD)] = {
  status: "1", message: "OK",
  result: [esRow("0xd001", daysAgo(7), ADDR.cp1, ADDR.avaxD, "5000000", USDT_AVAX)],
};
// 6. TronGrid TRC-20: one Approval row to skip, two transfers
fixtures[tronUrl(ADDR.tron, USDT_TRON, FIXTURE_NOW_MS - 90 * DAY * 1000)] = {
  data: [
    { transaction_id: "t001", token_info: { symbol: "USDT", address: USDT_TRON, decimals: 6, name: "Tether USD" }, block_timestamp: daysAgo(1) * 1000, from: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9", to: ADDR.tron, type: "Transfer", value: "5000000000" },
    { transaction_id: "t002", token_info: { symbol: "USDT", address: USDT_TRON, decimals: 6, name: "Tether USD" }, block_timestamp: daysAgo(2) * 1000, from: ADDR.tron, to: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9", type: "Approval", value: "1" },
    { transaction_id: "t003", token_info: { symbol: "USDT", address: USDT_TRON, decimals: 6, name: "Tether USD" }, block_timestamp: daysAgo(20) * 1000, from: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", to: ADDR.tron, type: "Transfer", value: "12345678" },
  ],
  success: true,
  meta: { at: FIXTURE_NOW_MS, page_size: 3 },
};
// 7. Helius enhanced transactions for Solana USDC
fixtures[heliusUrl(ADDR.sol)] = [
  { signature: "sig001", timestamp: daysAgo(1), slot: 300_000_001, type: "TRANSFER", tokenTransfers: [{ fromUserAccount: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", toUserAccount: ADDR.sol, fromTokenAccount: "x", toTokenAccount: "y", tokenAmount: 100.5, mint: USDC_SOL, tokenStandard: "Fungible" }] },
  { signature: "sig002", timestamp: daysAgo(2), slot: 300_000_000, type: "TRANSFER", tokenTransfers: [{ fromUserAccount: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", toUserAccount: ADDR.sol, fromTokenAccount: "x", toTokenAccount: "y", tokenAmount: 3, mint: "So11111111111111111111111111111111111111112", tokenStandard: "Fungible" }] },
  { signature: "sig003", timestamp: daysAgo(3), slot: 299_999_999, type: "TRANSFER", tokenTransfers: [{ fromUserAccount: ADDR.sol, toUserAccount: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", fromTokenAccount: "y", toTokenAccount: "x", tokenAmount: 40, mint: USDC_SOL, tokenStandard: "Fungible" }] },
];

const out = path.resolve(import.meta.dirname, "explorers.json");
writeFileSync(out, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${out}`);
