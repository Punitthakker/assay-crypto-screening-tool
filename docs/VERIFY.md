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

## 3. Screen by transaction and explorer link (added 2026-11-02)

Everything here is on fixtures until you run it. The API must be up (Railway redeploys from main) or run it locally with `pnpm --filter @cr/api dev` and use `http://localhost:8080`.

1. Address link, the one you sent:
   ```bash
   curl -s -X POST https://assay-api-production-fc4f.up.railway.app/v1/lookup \
     -H 'content-type: application/json' -H 'x-api-key: <access code>' \
     -d '{"input":"https://tronscan.org/address/TPsMJ3BE9ixSQ7guFbVLZ4eou6SATBSqHH/transactions"}' | jq '{kind, verdict: .report.verdict, note: .sourcesNote, sources: [.sources[] | {status, share, total, count, address, label: .label.name}]}'
   ```
   Pass: `kind: "address"`, a verdict, and sources whose totals match tronscan's USDT inbound for the last 90 days (cap 200 transfers; if tronscan shows more than 200 inbound transfers, `sourcesNote` must say capped).
2. Transaction link: open any USDT transfer on tronscan, copy the URL, paste it on /check with your own receiving address in the optional field. Pass: `transfer` line matches tronscan's amount, from and to; `pays your address` shows green when the to address is yours and red when it is not.
3. Ethereum tx hash with the chain selector on Ethereum. Pass: same as 2 via etherscan. Then try the same hash with Base selected: expect `not found` (the hash does not exist there), never a report.
4. Fake token: find a tx on etherscan that moves a look-alike "USDT" (any token with that symbol outside the registry). Pass: no report, note says look-alike, `otherTokens` lists the contract.
5. Solana: paste a solscan tx link of a USDC transfer. Pass: from, to and amount match solscan. This path reads the public RPC `getTransaction`, which may refuse very old signatures; `not_found` on an old tx is a limitation, not a bug, until Helius is wired for this read.
6. Record the real responses for the fixture set: `CR_RECORD=1 pnpm --filter @cr/api dev` then repeat 1 to 3; review `data/fixtures/recorded.json` before committing.

Not yet verified live: TronGrid event payload field names (`result.from` / `result.to` as 0x-hex, handled for 41-hex and base58 too), EVM receipt decoding on L2s, Solana balance-delta sender/receiver pick on multi-hop swaps.
