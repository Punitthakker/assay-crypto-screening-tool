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

Not yet: fund-flow trace and behavioural signals (Phase 1b, explorer adapters), Telegram bot (Phase 1b), web app (Phase 2), API/SDK (Phase 3). While fund-flow is off, confidence never exceeds `medium` by design.

## Run

```bash
pnpm install
pnpm test                                   # fixtures only, no network
pnpm verify:sources                         # LIVE: checks every contract, oracle and list; writes docs/SOURCES.verified.json
pnpm screen TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t -a USDT                       # Tron inferred
pnpm screen 0x28C6c06298d514Db089934071355E5743bf21d60 -c ethereum -a USDT
pnpm screen <addr> -c base -a USDC -m 25000  # amount enables the Travel Rule check
pnpm screen <addr> -c base -a USDC --json
CR_TRANSPORT=fixture pnpm screen ...         # offline demo mode
CR_RECORD=1 pnpm screen ...                  # live, and record the responses into data/fixtures/recorded.json
```

No API keys are required. `.env.example` lists optional keys that raise rate limits or enable paid providers.

## Layout

```
apps/cli            screen + verify-sources
packages/shared     chains, tokens, address parsing, zod schemas
packages/datasources transport (live | fixture), adapters: ofac, issuer-freeze, sanctions-oracle, labels
packages/engine     scoring, orchestration, report
data/labels         seed labels (json)
data/fixtures       recorded.json (on-chain responses), ofac-snapshot.json
docs                SOURCES, REGISTRY, SCORING, DECISIONS
```

## Licences of data used

See `docs/SOURCES.md`. Nothing non-commercial is in the default path. OFAC lists are public domain; the 0xB10C extraction tool is MIT.

Screening support tool. Not legal advice and not a substitute for a regulated entity's AML/CFT programme.
