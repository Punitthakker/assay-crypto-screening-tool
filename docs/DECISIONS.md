# Decisions log

Format: date - decision - reason - status (default | confirmed by Punit)

- 2026-11-01 - Product name stays a placeholder ("Clean Receive"); neutral brand with "Powered by MoneyBee" in the footer - exchanges should not see a PSP competitor's logo on their compliance screen - default
- 2026-11-01 - v1 chains: Ethereum, Tron, Solana, Base, Arbitrum One, Polygon PoS, Avalanche C-Chain, BNB Chain. Optimism registry-ready but off. Bitcoin deferred to Phase 4 - default, with one change from the brief: Avalanche added because both issuers are native there, BNB Chain kept but flagged bridged-only
- 2026-11-01 - BNB Chain USDT/USDC are Binance-Peg, not issuer contracts: freeze read is N/A, report states it plainly, asset authenticity module marks them `bridged` - verified during source check
- 2026-11-01 - Arbitrum and Polygon USDT are USDT0 (OFT). Freeze adapter for those two is gated behind a live ABI check in `verify:sources`; until confirmed the report shows `coverage: partial` for USDT on those chains rather than a false "clear" - verified during source check
- 2026-11-01 - Bot transport: Telegram (grammY) first, WhatsApp Cloud API in Phase 4 - default
- 2026-11-01 - Hosting: Railway (api, bot, postgres, redis), Netlify (web) - default, matches existing stack
- 2026-11-01 - Trace depth default 2 hops, hard cap 3, fan-out cap 25 counterparties per hop, known exchange hot wallets terminate the trace - default
- 2026-11-01 - Build sandbox has no RPC egress. All adapters have a `fixture` transport; CI runs on fixtures only; live verification runs via `pnpm verify:sources` on Punit's machine or Railway - constraint
- 2026-11-01 - EVM reads via `viem` (multicall where available), Tron via TronGrid HTTP, Solana via JSON-RPC `getAccountInfo` on the ATA - sensible defaults, swap-able
- 2026-11-01 - Monorepo: pnpm workspaces, TypeScript strict, tsup for packages, Vitest - per brief
- 2026-11-01 - Risk score 0-100 higher is worse; bands CLEAR/LOW/CAUTION/HIGH/BLOCK - per brief
- 2026-11-02 - Explorer order per EVM chain: Etherscan V2 when a key is set, then Blockscout hosted instance, then Routescan (Avalanche only). First provider that answers wins; errors from earlier providers are kept in the coverage detail - default
- 2026-11-02 - Fixture keys redact `apikey`, `api-key`, `api_key` query values so `CR_RECORD=1` can never commit a provider key - constraint
- 2026-11-02 - Solana transfers need a Helius key; a keyless path via `getSignaturesForAddress` + `getTransaction` was rejected for v1 (hundreds of RPC calls per screen on the public endpoint) - default, revisit if Helius free tier is withdrawn
- 2026-11-02 - Explorer data is fetched on every screen but scores nothing yet: one `FLOW_INBOUND_WINDOW` info line and an `explorer` coverage line. Fund-flow stays `disabled` so confidence cannot reach high before the trace exists - constraint
- 2026-11-02 - Screen by transaction: the sender of the pasted transfer is screened with amount and token contract taken from the tx; the receiver is confirmed when supplied. Sources (inbound counterparties of the sender) get label, OFAC and freeze checks on the top 10 by value and are informational until the scored trace exists - confirmed by Punit (feature request, surface: /check page; API endpoint added because the page needs one)
- 2026-11-02 - EVM tx resolution reads the receipt from the public RPC rather than an explorer API, so it needs no key and works on every registry chain - default
- 2026-11-03 - Trace fan-out is 25 per hop and the hop-2 expansion cap defaults to the same 25, so one screen can cost up to 26 explorer calls plus up to 50 freeze reads. Keyed Etherscan and TronGrid absorb that; keyless Blockscout may not. `CR_TRACE_EXPAND_CAP` lowers it per deployment - default, question 5 in QUESTIONS.md
- 2026-11-03 - Two different dust rules, on purpose: a counterparty whose transfers total under `CR_TRACE_DUST` (1 token unit) is dropped from the trace entirely (a sanctioned address dusting 0.1 USDT must not create exposure), while any kept counterparty in sanctioned, mixer or frozen floors at 8 points as SCORING.md says - default
- 2026-11-03 - A hard-blocked sender is not traced. The verdict is settled, the calls would be wasted, and `fund-flow` reads `not_applicable` so the BLOCK keeps `high` confidence - default
- 2026-11-03 - Only the OFAC list and labels mark a counterparty as sanctioned; the Chainalysis oracle is not called per counterparty (one eth_call each, same list upstream). Revisit if the lists ever disagree on a counterparty - default
- 2026-11-03 - "previously frozen", "fresh wallet" and "bridge-in" exposure categories exist in the tracer but only "bridge_in" can fire today (from a `bridge` label); the first two wait for the freeze event index and behavioural signals - constraint
- 2026-11-02 - TronGrid key is set on the Railway assay-api service (free tier). Tron lookups run keyed; Tronscan fallback stays in the code but needs its own key to be useful - confirmed by Punit
