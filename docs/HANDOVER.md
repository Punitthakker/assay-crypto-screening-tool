# Handover - Assay daily build, concluded 2026-11-07

The scheduled daily build ("Assay daily build", 06:40 Dubai) ran from 2026-11-01 to 2026-11-07 and is now stopped at Punit's request. This page is the state of the product on the day it stopped: what exists, what is live, what was only ever tested on fixtures, and what to do next.

## What exists (repo `Punitthakker/assay-crypto-screening-tool`, main at `a8e4939` plus this commit)

Phase 1a and all of Phase 1b except the Telegram bot. 156 Vitest tests on fixtures, TypeScript strict, typecheck clean.

| Layer | What it does | Where |
|---|---|---|
| Registry | USDT and USDC on Ethereum, Tron, Solana, Base, Arbitrum, Polygon, Avalanche, BNB Chain; bridged and USDT0 handling | `packages/shared` |
| Hard blocks | Issuer freeze read (Tether, Circle, Tron, SPL), OFAC SDN crypto list, Chainalysis oracle, fake-token check, originator name hit | `packages/datasources/src/adapters/{issuer-freeze,ofac,sanctions-oracle,watchman}.ts` |
| Fund flow | Inbound and outbound transfers via Etherscan V2, Blockscout, Routescan, TronGrid, Tronscan, Helius; 2-hop backward trace, value-weighted and hop-decayed exposure per category, licensed VASP boundary, dust floor | `adapters/explorer.ts`, `packages/engine/src/trace.ts` |
| Behaviour | Wallet age, tx count, dormancy, pass-through, structuring, concentration, contract-with-admin, drainer approvals | `adapters/activity.ts`, `engine/src/behaviour.ts` |
| Labels | 6,479 imported addresses (MIT sources), Tornado pools, bridges, VASP register with licence status | `adapters/label-import.ts`, `data/labels/`, `data/vasps.json` |
| Freeze history | Issuer blacklist events indexed into a local table, "previously frozen" for sender and counterparties | `adapters/freeze-events.ts`, `pnpm index:freeze` |
| Identity | Originator name screening through self-hosted Watchman (OFAC, US CSL, EU, UK, UN), match line 0.80, review band from 0.59 | `adapters/watchman.ts`, `docker-compose.yml` |
| Scoring | v1.1.0: hard blocks, weighted buckets with caps, bands, confidence from coverage, SHA-256 report hash | `engine/src/score.ts`, `docs/SCORING.md` |
| Surfaces | CLI (`pnpm screen`), API (`POST /v1/screen`, `POST /v1/lookup`), static web `/check` page | `apps/cli`, `apps/api`, `apps/web` |

## What is live today

- Web: `https://assay-screening.netlify.app` (site `assay-screening`). Redeployed 2026-11-07 07:47 UTC from this repo's `apps/web` by upload; `check.html` now carries the tx-link screening, sender sources and the amber `previously_frozen` state. The site is NOT linked to GitHub: every later change to `apps/web` needs another upload (`npx netlify deploy --prod --dir apps/web` or the Netlify MCP deploy) until you connect the repo in Netlify (Project settings, Build and deploy, Link repository; publish directory `apps/web`, no build command, `netlify.toml` is already in place).
- API: `https://assay-api-production-fc4f.up.railway.app` (Railway project `assay`, service `assay-api`). As of this commit it still runs `af0f8e3` from 2026-11-02. The reason: the service had a repo attached but no branch, so pushes to `main` never triggered a build. A staged change set (7 changes, non-destructive) is waiting in the Railway dashboard for the production environment:
  1. `assay-api` source branch set to `main` (future pushes deploy automatically).
  2. New service `watchman` from image `moov/watchman:latest`, variables `INCLUDED_LISTS=us_ofac,us_csl,eu_csl,uk_csl,un_csl`, `LOG_FORMAT=json`, `HTTP_BIND_ADDRESS=:8084`.
  3. `WATCHMAN_URL=http://watchman.railway.internal:8084` on `assay-api`.
  Open the project, review the staged changes, press Deploy. The first `assay-api` build picks up everything since 2026-11-02. Watchman needs about a minute to download and index the lists before `/v2/listinfo` answers; the API reports `watchman=unavailable` on originator screens until then. The automated session was not permitted to press Deploy itself.

## What has never run live

Everything in `docs/VERIFY.md` steps 2, 4, 5, 6, 7 and 8. The sandbox the builds ran in had no RPC, explorer or Docker access, so the explorer adapters, the trace, the behavioural signals, the freeze index and Watchman are tested on recorded or hand-encoded fixtures only. Steps 1 and 3 were run on Railway on 2026-11-01 and 2026-11-02 (freeze reads, OFAC, oracle, tronscan links). Run the steps in order after the Railway deploy; each says what pass looks like and what to send back when it does not.

Keys that unlock coverage: `ETHERSCAN_API_KEY` (every EVM chain, BNB has no other explorer), `HELIUS_API_KEY` (Solana fund flow). `TRONGRID_API_KEY` is already set on Railway.

## Open questions (`docs/QUESTIONS.md`)

14 questions, 1 answered. The ones that change behaviour: 5 (trace cost cap on Railway), 6 (indirect exposure can reach BLOCK by arithmetic), 9 (GPL ScamSniffer stays off), 10 (VASP licence statuses are from memory and gate the trace boundary), 11 and 12 (freeze index policy and whether to commit it), 13 (Watchman match line 0.80 or 0.59 for the pilot), 14 (pin the Watchman image tag).

## Not built

- Telegram bot (Phase 1b, next item on `docs/ROADMAP.md`).
- Phase 2: web console as an app, report page, trace graph, PDF export; Postgres and Redis.
- Phase 3: full REST API with keys and OpenAPI, npm SDK, Solidity ReceiveGuard, nightly re-screen, pitch and demo script.
- Phase 4 (needs a go-ahead): WhatsApp, Bitcoin, paid vendors, IVMS101, signed attestations, white label.

## Restarting the build

The scheduled task is disabled, not deleted. Re-enable it in the Claude app to resume from the first unchecked roadmap item (the Telegram bot), or run the same prompt by hand in a session with the repo attached. Everything the next session needs is in `README.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`, `docs/QUESTIONS.md` and the last commits.
