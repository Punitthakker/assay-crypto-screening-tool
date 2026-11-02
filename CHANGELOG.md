# Changelog

## 0.2.0 - 2026-11-02
- Explorer adapters behind Transport: Etherscan V2 (one key, all EVM chains), Blockscout (keyless, hosted instances for Ethereum, Base, Arbitrum, Polygon), Routescan (Avalanche, keyless), TronGrid TRC-20, Helius (Solana, key required). `ExplorerRouter` picks per chain and falls through on error. Window 90 days or 200 inbound transfers, newest first, deduped, zero-value and outbound dropped.
- Engine: `explorer` coverage line and one `FLOW_INBOUND_WINDOW` info line (0 points) per report. Fund-flow stays `disabled` until the trace lands; confidence cap unchanged. `explorer: false` switches the fetch off.
- Fixture transport redacts `apikey` / `api-key` from fixture keys so recordings never carry a secret.
- `pnpm verify:explorers` live check, writes `docs/EXPLORERS.verified.json`. Steps in `docs/VERIFY.md`.
- 21 new fixture tests (36 total). Scoring version unchanged (1.0.0).

## 0.1.0 - 2026-11-01
- Phase 1a: chain and token registry (8 chains), issuer freeze adapter (EVM, Tron, Solana), OFAC SDN list adapter, Chainalysis oracle adapter, label store, asset authenticity, Travel Rule floor, scoring v1.0.0, CLI, verify:sources, 14 fixture tests
- Brand: Assay, logo SVGs, PRODUCT.md and DESIGN.md for impeccable, product page apps/web/index.html
