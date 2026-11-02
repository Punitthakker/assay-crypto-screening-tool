/**
 * Live check of the explorer adapters. Run from a machine with internet access:
 *   pnpm verify:explorers                       # every enabled chain, default probe addresses
 *   pnpm verify:explorers -- <chain> <address>  # one chain, your address
 *   CR_RECORD=1 pnpm verify:explorers           # also record the responses into data/fixtures/recorded.json
 * Prints one line per chain: provider used, inbound count, oldest and newest timestamp, or the error chain.
 * Exit 1 if any enabled chain with a configured provider returned nothing usable.
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { ENABLED_CHAINS, canonicalToken, tokensFor, type AssetSymbol, type ChainId } from "@cr/shared";
import { ExplorerRouter, defaultWindow, transportFromEnv } from "@cr/datasources";

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);

/** Probe addresses: a Tether treasury and a Binance hot wallet reused across EVM chains. They exist only to prove each adapter returns rows; pass your own address as the second argument if one goes quiet. */
const PROBES: Partial<Record<ChainId, { address: string; asset: AssetSymbol }>> = {
  ethereum: { address: "0x5754284f345afc66a98fbB0a0Afe71e0F007B949", asset: "USDT" },
  base: { address: "0xF977814e90dA44bFA03b6295A0616a897441aceC", asset: "USDC" },
  arbitrum: { address: "0xF977814e90dA44bFA03b6295A0616a897441aceC", asset: "USDC" },
  polygon: { address: "0xF977814e90dA44bFA03b6295A0616a897441aceC", asset: "USDC" },
  avalanche: { address: "0xF977814e90dA44bFA03b6295A0616a897441aceC", asset: "USDT" },
  bnb: { address: "0xF977814e90dA44bFA03b6295A0616a897441aceC", asset: "USDT" },
  tron: { address: "TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX", asset: "USDT" },
  solana: { address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", asset: "USDC" },
};

const [argChain, argAddress] = process.argv.slice(2);
const transport = transportFromEnv();
const router = new ExplorerRouter(transport, process.env);
const window = defaultWindow();
const out: Record<string, unknown> = { verifiedAt: new Date().toISOString(), mode: transport.mode, window: { windowDays: window.windowDays, maxTransfers: window.maxTransfers }, chains: {} };
const chains = out.chains as Record<string, unknown>;
let failures = 0;

const targets: ChainId[] = argChain ? [argChain as ChainId] : ENABLED_CHAINS;
for (const chain of targets) {
  const probe = argAddress ? { address: argAddress, asset: (PROBES[chain]?.asset ?? "USDT") as AssetSymbol } : PROBES[chain];
  if (!probe) continue;
  const token = canonicalToken(chain, probe.asset) ?? tokensFor(chain, probe.asset)[0];
  if (!token) continue;
  const candidates = router.candidates(chain).map((a) => a.provider);
  const started = Date.now();
  const r = await router.inboundTransfers(probe.address, token, window);
  const ms = Date.now() - started;
  const row: Record<string, unknown> = { candidates, status: r.status, provider: r.provider, inbound: r.transfers.length, truncated: r.truncated, ms, detail: r.detail };
  if (r.transfers.length) {
    row.newest = new Date(r.transfers[0]!.timestamp * 1000).toISOString();
    row.oldest = new Date(r.transfers[r.transfers.length - 1]!.timestamp * 1000).toISOString();
    row.sample = r.transfers[0];
  }
  if (candidates.length === 0) row.note = "no provider configured; see docs/VERIFY.md";
  else if (r.status !== "ok" || r.transfers.length === 0) failures++;
  chains[chain] = row;
  console.log(`${chain.padEnd(10)} ${String(r.provider ?? "-").padEnd(13)} ${r.status.padEnd(12)} inbound=${String(r.transfers.length).padStart(3)} ${ms}ms  ${r.detail}`);
}

writeFileSync("docs/EXPLORERS.verified.json", JSON.stringify(out, null, 2));
console.log(failures === 0 ? "\nAll configured explorers returned inbound transfers." : `\n${failures} chain(s) returned nothing usable - see docs/EXPLORERS.verified.json.`);
process.exit(failures === 0 ? 0 : 1);
