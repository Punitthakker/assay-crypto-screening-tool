# Live verification steps

The build sandbox has no RPC or explorer egress. Everything below needs a machine with internet access (your laptop or a Railway shell). Each step says what it proves and what "pass" looks like. Fixture tests never substitute for these.

## 1. Registry, freeze reads, sanctions

```bash
pnpm verify:sources
```
Pass: "All sources verified." and `docs/SOURCES.verified.json` updated. Run before every demo.

## 2. Explorer adapters (added 2026-11-02)

1. Copy `.env.example` to `.env`. Set `ETHERSCAN_API_KEY` (free key, one for every EVM chain) and `HELIUS_API_KEY` (free tier). `TRONGRID_API_KEY` is optional.
2. Run `pnpm verify:explorers`. One line per enabled chain. Pass: every line reads `ok` with `inbound` above 0 and a provider name. Solana without a Helius key and BNB Chain without an Etherscan key print `no explorer configured`; that is expected, not a failure.
3. Run it again with `ETHERSCAN_API_KEY` unset. Ethereum, Base, Arbitrum and Polygon must now answer via `blockscout`, Avalanche via `routescan`. This proves the keyless fallback path. If a Blockscout host has moved, set `BLOCKSCOUT_<CHAIN>=https://host` and tell me the new host so it goes into `BLOCKSCOUT_HOSTS`.
4. Spot-check one row against the explorer UI: open `docs/EXPLORERS.verified.json`, take `chains.ethereum.sample.txHash`, confirm on etherscan.io that the transfer is inbound to the probe address with the same value. Repeat for `tron` on tronscan.org and `solana` on solscan.io.
5. Run `pnpm verify:explorers -- tron <one of your own Tron addresses>` and confirm the count matches what tronscan shows for USDT inbound in the last 90 days (cap 200).
6. Optional, to refresh fixtures from real data: `CR_RECORD=1 pnpm verify:explorers`. Keys are redacted from fixture keys automatically. Review `data/fixtures/recorded.json` before committing; it will contain real addresses and tx hashes.

Not yet verified live, in order of risk: Routescan's Etherscan-compatible endpoint shape for Avalanche; Blockscout `next_page_params` pagination on the hosted instances; Helius `type=TRANSFER` filtering (token transfers inside swaps are excluded on purpose, confirm that is what you want).
