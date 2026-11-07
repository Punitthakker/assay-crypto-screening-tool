# Assay (formerly Clean Receive)

Pre-receipt screening for USDT and USDC: is this sender, this asset, on this chain, clean enough to accept right now?

Private repo. Source is Punit Thakker's IP. Only the compiled SDK and the hosted site are public-facing.

## Status - Phase 1a (engine + CLI)

Working today, offline against recorded fixtures and online against public RPCs:

- Chain and token registry for Ethereum, Tron, Solana, Base, Arbitrum, Polygon, Avalanche, BNB Chain (`docs/REGISTRY.md`)
- Issuer freeze read: Tether `isBlackListed`, Circle `isBlacklisted`, Tron constant call, Solana SPL frozen state
- Sanctions: OFAC SDN crypto addresses (nightly mirror) plus the Chainalysis on-chain oracle, with discrepancy flagging
- Asset authenticity: fake-token hard block, bridged (Binance-Peg, USDC.e, USDbC) handling, USDT0 caveat
- Local label store (licensed VASPs, mixers) with seed data
- Travel Rule identity floor (AED 3,500 default)
- Scoring v1 with hard blocks, caps, bands, confidence, SHA-256 report hash (`docs/SCORING.md`)
- CLI with human and JSON output, exit code 3 on BLOCK
- Screen by transaction (2026-11-02): paste a tx hash or a tronscan / etherscan link on /check or `POST /v1/lookup`; the sender of that transfer is screened and its inbound sources are listed with label, OFAC and freeze checks
- Explorer adapters (Phase 1b, 2026-11-02): inbound transfers of the screened token over 90 days or 200 transfers via Etherscan V2, Blockscout, Routescan, TronGrid, Helius; keyless fallback on Ethereum, Base, Arbitrum, Polygon, Avalanche, Tron
- Behavioural signals (Phase 1b, 2026-11-04): wallet age, transaction count, dormancy then reactivation, pass-through speed, structuring under reporting thresholds, counterparty concentration, unverified contract with an admin, approvals to labelled drainers; `BEHAV_*` evidence capped at 35, a `behaviour` coverage line that names every signal it could not evaluate
- 2-hop backward trace (Phase 1b, 2026-11-03): every counterparty of the sender, and of their unlabelled counterparties, is checked against labels, OFAC and the issuer freeze list; exposure is value-weighted and hop-decayed into `EXPOSURE_*` evidence per category; licensed exchange wallets end the trace; fan-out cap 25, dust floor, `fund-flow` coverage line, so confidence can now reach `high`

- Historic freeze event index (Phase 1b, 2026-11-06): `pnpm index:freeze` reads every `AddedBlackList` / `RemovedBlackList` / `DestroyedBlackFunds` (Tether) and `Blacklisted` / `UnBlacklisted` (Circle) event from the issuer contracts into `data/freeze-index/<chain>-<symbol>.json`, incrementally from a stored cursor, via Etherscan V2, Blockscout or TronGrid; the engine and the trace read it for "previously frozen" (`EXPOSURE_PREVIOUSLY_FROZEN` for counterparties, `EXPOSURE_DIRECT_PREVIOUSLY_FROZEN` at 20 for the sender) and a `freeze-index` coverage line; scoring 1.1.0
- Label imports (Phase 1b, 2026-11-05): `pnpm import:labels` pulls MIT-licensed phishing, exploit and exchange labels (ImMike aggregator, Forta, etherclust) into `data/labels/imported-*.json`, 6,479 addresses in the store; `data/vasps.json` decides licensed vs unlicensed exchange wallets; Tornado Cash pools and major bridges seeded; `docs/LICENCES.md` lists every dataset and its licence, GPL ScamSniffer is opt-in only

- Identity layer (Phase 1b, 2026-11-07): originator name screening through a self-hosted moov-io/watchman (`docker compose up -d watchman`, `WATCHMAN_URL`), OFAC, US CSL, EU, UK and UN lists; `HB_ORIGINATOR_SANCTIONED` at or above the 0.80 match line, `IDENTITY_PEP` on PEP lists, a stated near-miss review band, `watchman` coverage line; `pnpm screen ... -o "<name>" --dob <date>`, `originator` on `POST /v1/screen`, `pnpm verify:watchman`

- Bot (2026-11-07): `apps/bot`, one process with a WhatsApp Business Cloud API webhook and a Telegram long-polling transport on grammY, the engine in-process. Send an address, tx hash or explorer link (with "on base", "usdt", an amount); ask what Assay is, which chains, how it scores, what frozen means, pricing. Under 12 lines, 3 free checks a day per salted-hashed user id, `/dev/message` for local testing. Number for the launch: +971 56 462 7605. Go-live steps that only Punit can do (Meta Business, tokens, Railway Deploy): `docs/LAUNCH.md`

Daily build paused 2026-11-07; `docs/HANDOVER.md` has the live state and how to resume, web app (Phase 2), API/SDK (Phase 3). Explorer adapters, the trace and the behavioural signals are tested on fixtures only until `pnpm verify:explorers` and VERIFY.md steps 4 and 5 have been run live (`docs/VERIFY.md`).

## Run

```bash
pnpm install
pnpm test                                   # fixtures only, no network
pnpm verify:sources                         # LIVE: checks every contract, oracle and list; writes docs/SOURCES.verified.json
pnpm verify:explorers                       # LIVE: one inbound-transfer fetch per chain; writes docs/EXPLORERS.verified.json
pnpm import:labels                          # refresh data/labels/imported-*.json from the public datasets in docs/LICENCES.md (GitHub only, no keys)
pnpm index:freeze                           # LIVE: build or refresh data/freeze-index/ from the issuer blacklist events (Etherscan key or Blockscout, TronGrid for Tron)
docker compose up -d watchman               # identity layer: self-hosted Watchman on 127.0.0.1:8084, then WATCHMAN_URL=http://localhost:8084
pnpm verify:watchman                        # LIVE: lists loaded plus four originator controls; writes docs/WATCHMAN.verified.json
pnpm screen TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -a USDT                       # Tron inferred
pnpm screen 0x28C6c06298d514Db089934071355E5743bf21d60 -c ethereum -a USDT
pnpm screen <addr> -c base -a USDC -m 25000  # amount enables the Travel Rule check
pnpm screen <addr> -c tron -a USDT -m 25000 -o "Full Name" --dob 1990-01-01 --nationality AE   # originator screened through Watchman
pnpm screen <addr> -c base -a USDC --json
CR_TRANSPORT=fixture pnpm screen ...         # offline demo mode
CR_RECORD=1 pnpm screen ...                  # live, and record the responses into data/fixtures/recorded.json
```

No API keys are required. `.env.example` lists optional keys that raise rate limits or enable paid providers.

## Layout

```
apps/bot            WhatsApp Cloud API webhook + Telegram (grammY) bot, conversation core, daily quota
apps/cli            screen + verify-sources
packages/shared     chains, tokens, address parsing, zod schemas
packages/datasources transport (live | fixture), adapters: ofac, issuer-freeze, freeze-events (index builder + reader), sanctions-oracle, labels, explorer (etherscan-v2, blockscout, routescan, trongrid, tronscan, helius), activity, watchman (identity layer)
packages/engine     scoring, orchestration, 2-hop trace (trace.ts), behavioural signals (behaviour.ts), report
data/labels         seed.json, mixers.json, bridges.json, imported-*.json (pnpm import:labels); data/vasps.json VASP register; data/label-imports.json manifest
data/fixtures       recorded.json (on-chain responses), ofac-snapshot.json, explorers.json, trace.json, behaviour.json, watchman.json and freeze-index/ (hand-encoded, build-*.ts)
docker-compose.yml  watchman (identity layer), api profile; modules/moneybee-risk-datasources holds the Watchman fork as a nested submodule
data/freeze-index   <chain>-<symbol>.json freeze event tables from pnpm index:freeze (git-ignored until question 12 is decided)
docs                SOURCES, LICENCES, REGISTRY, SCORING, DECISIONS, VERIFY, QUESTIONS
```

## Licences of data used

See `docs/LICENCES.md` (every dataset, licence, default or opt-in) and `docs/SOURCES.md`. Nothing non-commercial or copyleft is in the default path. OFAC lists are public domain; the 0xB10C extraction tool is MIT.

Screening support tool. Not legal advice and not a substitute for a regulated entity's AML/CFT programme.
