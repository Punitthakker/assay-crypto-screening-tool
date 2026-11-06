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

## 7. Historic freeze event index (added 2026-11-06)

Fixture-tested only. The index reads the issuer contracts' own events through Etherscan V2 `getLogs` (key), Blockscout `/api?module=logs` (keyless, hosted instances) or TronGrid `/v1/contracts/{contract}/events`. Topic hashes are computed from the Solidity signatures; what is unverified is that each provider returns the shape the adapter expects and that the counts match the explorer UI.

1. `pnpm index:freeze -- ethereum` with `ETHERSCAN_API_KEY` set. Pass: two lines, `ethereum/USDT` and `ethereum/USDC`, each `etherscan-v2`, with totals in the low thousands for USDT and low hundreds for USDC, no `FAILED`, and `data/freeze-index/ethereum-usdt.json` written. Then `pnpm index:freeze -- --status`.
2. Spot check: open the Tether contract on etherscan.io, Events tab, filter `AddedBlackList`; the newest event's address and tx hash must be the last `added` row in `data/freeze-index/ethereum-usdt.json`. Same for `Blacklisted` on the Circle proxy. If an address is missing, the `data` decoding or the topic is wrong; send me the raw log.
3. Keyless: unset `ETHERSCAN_API_KEY` and run `pnpm index:freeze -- ethereum --rebuild` to a scratch directory (`CR_FREEZE_INDEX_DIR=/tmp/fi`). Pass: provider `blockscout`, same counts within a few events. A 403 from Railway means the Blockscout path is laptop-only, as seen for Base; note it.
4. `pnpm index:freeze -- tron` with `TRONGRID_API_KEY`. Pass: `tron/USDT` via `trongrid`, totals in the thousands, addresses in base58 (`T...`). Verify the newest `added` row against tronscan's USDT contract events. If every address is undefined, TronGrid changed the `result` key names (`_user`, `_blackListedUser`); send me one raw row.
5. Base, Arbitrum, Polygon, Avalanche: `pnpm index:freeze -- base arbitrum polygon avalanche`. USDC indexes on all four. Avalanche USDt is assumed to emit the Tether event set; if it returns zero rows while the explorer shows blacklist events, the contract uses different names and I need the ABI. USDT0 on Arbitrum and Polygon is skipped (`tbd` freeze method), as is BNB Chain (bridged).
6. Run it again: every line must show `+0 new` and one request per event type. This is the daily cost.
7. End to end: `pnpm screen <addr> -c ethereum -a USDT --json | jq '{score, verdict, fi: [.coverage[] | select(.source=="freeze-index")], prev: [.evidence[] | select(.code|test("PREVIOUSLY_FROZEN"))]}'` on a wallet that the index lists as `removed` (pick any address from the file with both an add and a remove). Pass: `freeze-index.status` is `ok`, `EXPOSURE_DIRECT_PREVIOUSLY_FROZEN` at 20 points with the add and release dates, no `HB_FROZEN`. Then screen a wallet that received from such an address: `EXPOSURE_PREVIOUSLY_FROZEN` at hop 1, points = 20 x share.
8. Decide question 12 (commit the index or not); until then the Railway deploy reports `freeze-index: unavailable` and scores nothing from it.

Not yet verified live: Etherscan `getLogs` paging past 1,000 logs on the USDT contract (the adapter resumes at the last block seen), Blockscout `/api` log shape on the hosted instances (hex versus decimal `blockNumber`, both parsed), TronGrid event `result` key names and address encoding, Avalanche USDt event names, the `DestroyedBlackFunds` `_balance` decode.

Not yet verified live: hop-2 fetch volume against keyless Blockscout (403 seen on Base from Railway), TronGrid 15 QPS under 26 back-to-back calls, Helius credit cost per trace on Solana.

Verified live on Railway 2026-11-02 from the boot self-test: tronscan address link (TPsMJ3BE9ixSQ7guFbVLZ4eou6SATBSqHH: CLEAR, 5 inbound USDT transfers, 4 sources, freeze and OFAC checked), and a real tronscan tx link (a80ba5e7…2d96: 150 USDT, from, to and genuine-contract decoded, pays the receiver). The sender's own source list on that second lookup failed on TronGrid 429 and Tronscan 401, which is the key question in docs/QUESTIONS.md.

Not yet verified live: TronGrid event payload field names (`result.from` / `result.to` as 0x-hex, handled for 41-hex and base58 too), EVM receipt decoding on L2s, Solana balance-delta sender/receiver pick on multi-hop swaps.

## 5. Behavioural signals (added 2026-11-04)

Fixture-tested only. New network reads: the outbound side of the explorer adapters, Etherscan `txlist`, `getsourcecode` and `getLogs`, Blockscout `/addresses/{a}`, `/counters` and `/transactions`, `eth_getTransactionCount` on the public RPC, TronGrid `/v1/accounts/{a}`, Tronscan `/api/accountv2`, Helius `/v0/addresses/{a}/transactions`.

1. Your own Tron wallet: `pnpm screen <addr> -c tron -a USDT --json | jq '{score, verdict, confidence, behaviour: [.coverage[] | select(.source=="behaviour")], signals: [.evidence[] | select(.code|startswith("BEHAV_")) | {code, points, summary}]}'`. Pass: `behaviour.status` is `partial` with `not evaluated: BEHAV_DRAINER_APPROVAL (approval scan not implemented for tron)` and nothing else listed, and no signal fires that tronscan contradicts (wallet age against "Date Created", transaction count against the "Transactions" counter).
2. Fresh wallet: create a new Tron or Base wallet, fund it once, screen it. Pass: `BEHAV_FRESH_WALLET` (10) and `BEHAV_LOW_TX_COUNT` (6), score 16, CLEAR, matching SCORING.md example 1.
3. Ethereum with `ETHERSCAN_API_KEY`: screen a busy EOA. Pass: `behaviour.status` is `ok` (every signal evaluated) and the detail ends with `via etherscan-v2, rpc:nonce, rpc:code`. Then unset the key and screen again: expect `partial` with `BEHAV_FRESH_WALLET` and `BEHAV_DRAINER_APPROVAL` listed as not evaluated and Blockscout in the detail; if Blockscout answers 403 from Railway (seen on Base) the detail says so and nothing fires.
4. Contract sender with a key: screen a known proxy contract that sends USDT (any exchange custody proxy on etherscan with a verified source). Pass: no `BEHAV_CONTRACT_ADMIN` (verified), and `/v1/lookup` `behaviour.notEvaluated` is empty for that signal. Then an unverified Ownable contract if you have one: expect the line with the owner address in `ref`.
5. Drainer approval with a key: add one known drainer address to `data/labels/seed.json` as `scam`, then screen a victim wallet that approved it (etherscan "Token Approvals" view on any reported drainer victim). Pass: `BEHAV_DRAINER_APPROVAL` (12) with the approval tx hash in `ref`.
6. Pass-through and structuring need a real mule; if the pilot sees one, send me the report JSON and I will encode it as a fixture (addresses redacted).
7. Record: `CR_RECORD=1` on any run above writes the new reads into `data/fixtures/recorded.json` (keys are redacted from Etherscan and Helius URLs); review before committing.

Not yet verified live: Etherscan `getLogs` topic filter shape (`topic0_1_opr=and`, padded owner in `topic1`), Blockscout `counters.transactions_count` type (string or number, both parsed), TronGrid `latest_opration_time` field name (sic, as documented), Tronscan `accountv2.accountType` meaning (2 assumed to be contract), Helius `limit=25` first page as whole history for small wallets.

## 6. Label imports, mixers, bridges, VASP register (added 2026-11-05)

The importer only needs raw.githubusercontent.com and ran from the build sandbox, so the imported files are real data, not fixtures. What is NOT verified is the hand-kept address lists: every row in `data/labels/mixers.json`, `data/labels/bridges.json` and `data/vasps.json` was written from memory of public explorer tags and regulator registers.

1. `pnpm import:labels` from your machine. Pass: the four default sources print `kept` counts close to 6205 / 756 / 44 / 42 and `data/label-imports.json` updates. A higher count means upstream grew; commit the refreshed files after a glance at the diff.
2. Mixers: open each address in `data/labels/mixers.json` on etherscan.io and confirm the name tag reads `Tornado.Cash: <denomination>`. Delete any row that does not. These carry 55 points at full share, so one wrong address would mislabel a legitimate contract as a mixer.
3. Bridges: same for `data/labels/bridges.json` (tags `Wormhole: Token Bridge`, `Polygon (Matic): Bridge`, `Arbitrum: L1 ERC20 Gateway`, `Optimism: Gateway`, `Base: L1 Standard Bridge`, `Avalanche: Bridge`, `Multichain: Router V4`). Bridges only carry 10 points, but the trace treats them as a boundary of unknown origin, so a false tag hides a counterparty.
4. VASP register: for each `status: licensed` row in `data/vasps.json`, open the regulator register named in `source` (VARA public register, NYDFS virtual currency list, KoFIU, CSSF, CBB, Bappebti) and confirm the entity is listed today. Downgrade anything you cannot find to `unknown` and rerun step 1; the importer then drops those wallets from the licensed boundary. The four `unlicensed` rows (YoBit, Hotbit, Liqui, ZB.com) score 20 points at full share; confirm you want that.
5. Spot check: `pnpm screen 0x000000000532b45f47779fce440748893b257865 -c ethereum -a USDT` (an Etherscan phish-hack tag from the Forta set). Pass: `EXPOSURE_DIRECT_SCAM` +50 with `labels:import:immike-forta-phishing` as the source. Then screen a wallet that received from it: expect `EXPOSURE_SCAM` at hop 1.
6. Optional, GPL list: `pnpm import:labels -- scamsniffer` then `CR_LABELS_EXTRA_DIR=data/labels-optional pnpm screen ...`. Do not commit `data/labels-optional/` (git-ignored) and do not set the variable on Railway until question 9 is answered.
