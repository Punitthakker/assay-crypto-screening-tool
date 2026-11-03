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

## 4. 2-hop trace (added 2026-11-03)

Fixture-tested only. The trace is the same explorer calls as step 2 repeated for the sender's counterparties, plus freeze reads from step 1, so nothing new touches the network, but the numbers need a real wallet.

1. Pick a wallet you know (your own OTC or exchange deposit wallet is ideal) and run `pnpm screen <addr> -c tron -a USDT --json | jq '{score, verdict, confidence, flow: [.coverage[] | select(.source=="fund-flow")], exposure: [.evidence[] | select(.code|startswith("EXPOSURE_")) | {code, points, hop, summary}]}'`. Pass: `fund-flow.status` is `ok` or `partial` with a detail line you can read, and confidence is `high` when freeze, OFAC and the trace all came back.
2. Open the same address on tronscan, take its largest inbound USDT counterparty from the last 90 days, and check the `FLOW_TRACE` summary counts: hop-1 counterparties should match tronscan's distinct senders (cap 25), and the hop-2 count should be the distinct senders of those wallets.
3. Time it. Note the wall-clock for a wallet with more than 10 unlabelled counterparties; if it passes 10 seconds on Railway, set `CR_TRACE_EXPAND_CAP=10` (question 5 in docs/QUESTIONS.md) and tell me the numbers.
4. Known tainted path: screen a wallet that you know received from a Tether-frozen address (any address tronscan shows as blacklisted works as the counterparty). Pass: an `EXPOSURE_FROZEN` line at hop 1 with that address and a tx hash, points = 60 x its share of inbound value.
5. Mixer at hop 2 on Ethereum needs `ETHERSCAN_API_KEY`: screen any wallet that was funded by a wallet that withdrew from Tornado Cash (the router `0x7221…6967` is in the seed labels). Pass: `EXPOSURE_MIXER` at hop 2, dust rule floor of 8 if the share is small.
6. Record: `CR_RECORD=1` on one of the runs above writes every explorer page and freeze read into `data/fixtures/recorded.json`; review before committing, it names real wallets.

Not yet verified live: hop-2 fetch volume against keyless Blockscout (403 seen on Base from Railway), TronGrid 15 QPS under 26 back-to-back calls, Helius credit cost per trace on Solana.

Verified live on Railway 2026-11-02 from the boot self-test: tronscan address link (TPsMJ3BE9ixSQ7guFbVLZ4eou6SATBSqHH: CLEAR, 5 inbound USDT transfers, 4 sources, freeze and OFAC checked), and a real tronscan tx link (a80ba5e7…2d96: 150 USDT, from, to and genuine-contract decoded, pays the receiver). The sender's own source list on that second lookup failed on TronGrid 429 and Tronscan 401, which is the key question in docs/QUESTIONS.md.

Not yet verified live: TronGrid event payload field names (`result.from` / `result.to` as 0x-hex, handled for 41-hex and base58 too), EVM receipt decoding on L2s, Solana balance-delta sender/receiver pick on multi-hop swaps.
