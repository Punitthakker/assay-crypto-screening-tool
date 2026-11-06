/**
 * Hand-encoded freeze event index for the end-to-end test (engine + trace + freeze index).
 * Regenerate with:  pnpm tsx data/fixtures/build-freeze-index.ts
 * Invented control data, never a claim about a real wallet. Addresses come from build-trace.ts:
 *   B (hop-2 wallet behind A) was blacklisted by Tether and released 40 days later -> "previously frozen"
 * Written to data/fixtures/freeze-index/ethereum-usdt.json; the real table lives in data/freeze-index/
 * and is produced by `pnpm index:freeze` on a machine with explorer access.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const B = "0xb1b1000000000000000000000000000000000003";
const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const file = {
  chain: "ethereum",
  token: USDT_ETH,
  symbol: "USDT",
  issuer: "Tether",
  provider: "fixture",
  cursor: { block: 21_500_000 },
  updatedAt: "2026-11-01T00:00:00.000Z",
  events: [
    { type: "added", address: B, block: 21_000_000, timestamp: 1_735_689_600, txHash: "0xf2ee5e01" }, // 2025-01-01
    { type: "removed", address: B, block: 21_300_000, timestamp: 1_739_145_600, txHash: "0xf2ee5e02" }, // 2025-02-10
  ],
};

const dir = path.resolve(import.meta.dirname, "freeze-index");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "ethereum-usdt.json"), JSON.stringify(file, null, 1));
console.log(`wrote ${path.join(dir, "ethereum-usdt.json")}`);
