# Changelog

## 0.3.1 - 2026-11-02
- Tron made live-grade: Tronscan public API as the keyless fallback for TRC-20 inbound transfers and transaction lookup after the first Railway boot showed keyless TronGrid returning 429 on `/v1/` calls. Live transport retries 429 and 5xx twice with backoff. Boot self-test runs the hard-check controls with the explorer off and one real lookup on a tronscan address link so the deploy log shows the live path.
- Found live, not yet fixed: Blockscout on Base answers 403 from Railway (bot protection); EVM sources need `ETHERSCAN_API_KEY`.

## 0.3.0 - 2026-11-02
- Screen by transaction or explorer link (requested by Punit). One search box on /check accepts an address, a tx hash, a tronscan / etherscan-family / blockscout / solscan address link, or a tx link. `POST /v1/lookup` resolves it, screens the sender of that exact transfer (amount and token contract taken from the tx, so the fake-token hard block and the Travel Rule floor apply), confirms the tx pays the stated receiver, and lists the sender's sources: inbound counterparties over the 90-day window, aggregated by value, each checked against labels, OFAC and the issuer freeze list (top 10). Sources are informational; nothing moves the score until the 2-hop trace lands.
- Tx resolution: EVM via the public RPC receipt (Transfer logs, no key), Tron via TronGrid events, Solana via RPC getTransaction token balance deltas. `Transport.evmGetTransactionReceipt` added with a fixture key.
- `tronHexToBase58` in shared. `CR_FIXTURE_FILE` env to point fixture mode at another recording.
- 18 new fixture tests (55 total). Scoring version unchanged (1.0.0).

## 0.2.0 - 2026-11-02
- Explorer adapters behind Transport: Etherscan V2 (one key, all EVM chains), Blockscout (keyless, hosted instances for Ethereum, Base, Arbitrum, Polygon), Routescan (Avalanche, keyless), TronGrid TRC-20, Helius (Solana, key required). `ExplorerRouter` picks per chain and falls through on error. Window 90 days or 200 inbound transfers, newest first, deduped, zero-value and outbound dropped.
- Engine: `explorer` coverage line and one `FLOW_INBOUND_WINDOW` info line (0 points) per report. Fund-flow stays `disabled` until the trace lands; confidence cap unchanged. `explorer: false` switches the fetch off.
- Fixture transport redacts `apikey` / `api-key` from fixture keys so recordings never carry a secret.
- `pnpm verify:explorers` live check, writes `docs/EXPLORERS.verified.json`. Steps in `docs/VERIFY.md`.
- 21 new fixture tests (36 total). Scoring version unchanged (1.0.0).

## 0.1.0 - 2026-11-01
- Phase 1a: chain and token registry (8 chains), issuer freeze adapter (EVM, Tron, Solana), OFAC SDN list adapter, Chainalysis oracle adapter, label store, asset authenticity, Travel Rule floor, scoring v1.0.0, CLI, verify:sources, 14 fixture tests
- Brand: Assay, logo SVGs, PRODUCT.md and DESIGN.md for impeccable, product page apps/web/index.html
