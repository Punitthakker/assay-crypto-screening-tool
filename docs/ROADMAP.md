# Roadmap

One item per daily build. The scheduled task "Assay daily build" picks the first unchecked item, ships it with tests, marks it done here, and reports.

## Phase 1a - shipped 2026-11-01
- [x] Registry, issuer freeze, OFAC + oracle sanctions, asset authenticity, labels seed, Travel Rule floor, scoring v1, CLI, fixtures, brand, product page

## Out of band - requested by Punit
- [x] Screen by transaction hash or explorer link on /check and `POST /v1/lookup`, with sender sources listed - shipped 2026-11-02, live check pending (docs/VERIFY.md step 3)

## Phase 1b
- [x] Explorer adapters: Etherscan V2, TronGrid, Helius, Blockscout fallback (inbound transfers of the screened token, 90 days or 200 transfers) - shipped 2026-11-02, live check pending (docs/VERIFY.md step 2)
- [x] 2-hop backward trace, value-weighted and hop-decayed exposure, fan-out cap 25, licensed exchange boundary, dust floor, fund-flow coverage line - shipped 2026-11-03, live check pending (docs/VERIFY.md step 4)
- [x] Behavioural signals (BEHAV_*): wallet age, tx count, dormancy, pass-through, structuring, concentration, contract-with-admin, drainer approvals - shipped 2026-11-04, live check pending (docs/VERIFY.md step 5)
- [x] Label import scripts (ImMike, eth-phishing-detect, ScamSniffer), mixers, bridges, data/vasps.json, docs/LICENCES.md - shipped 2026-11-05; eth-phishing-detect has no address list (domains only), ScamSniffer is GPL and opt-in (question 9); mixer, bridge and VASP rows need Punit's confirmation (docs/VERIFY.md step 6, question 10)
- [x] Historic freeze event index ("previously frozen") - shipped 2026-11-06, index must be built live (docs/VERIFY.md step 7), scoring 1.1.0
- [x] Watchman identity-layer integration via docker-compose (submodule modules/moneybee-risk-datasources) - shipped 2026-11-07 on fixtures, live check pending (docs/VERIFY.md step 8), minMatch policy is question 13
- [ ] Telegram bot (grammY) in apps/bot

## Phase 2
- [ ] Web console on the published design (apps/web), report page, trace graph, PDF export, demo mode, methodology
- [ ] Postgres + Redis, docker-compose

## Phase 3
- [ ] REST API (apps/api), keys, rate limits, OpenAPI
- [ ] npm SDK, useScreen hook, ReceiveGuard widget
- [ ] Example Solidity ReceiveGuard
- [ ] Nightly re-screen + webhooks
- [ ] Railway + Netlify configs, docs/PITCH.md, demo script

## Phase 4 - only with Punit's go-ahead
- [ ] WhatsApp transport, Bitcoin tracing, paid vendor adapters, IVMS101 ingestion, signed attestations, white-label theming
