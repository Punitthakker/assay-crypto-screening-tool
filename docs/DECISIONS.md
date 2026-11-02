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
