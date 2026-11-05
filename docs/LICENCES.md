# Data licences

Every dataset that reaches a report is listed here with its licence and whether it is in the default path. Rule from the brief: nothing paid and nothing non-commercial in the default path. Copyleft (GPL) data is treated the same way until Punit decides otherwise, because shipping it inside a proprietary product is a legal question, not an engineering one.

Checked 2026-11-05 by reading each repository's LICENSE file over raw.githubusercontent.com. Re-check before the first paid customer.

## In the default path

| Dataset | Where it lands | Licence | Attribution kept | Note |
|---|---|---|---|---|
| OFAC SDN digital-currency addresses via 0xB10C mirror | `data/fixtures/ofac-snapshot.json`, `.cache/` | Public domain (US Government work); mirror tool MIT | `docs/SOURCES.md` | Nightly mirror of `sdn_advanced.xml` |
| Chainalysis sanctions oracle | on-chain read | Free public contract, no licence terms attached to reads | `docs/SOURCES.md` | Second source only |
| ImMike/crypto-wallet-address-labels, forta-network `phishing_scams.csv` | `data/labels/imported-immike-forta-phishing.json` | MIT (aggregator, 2026); MIT (Forta Foundation, 2022) | `source: import:immike-forta-phishing` on every label | Etherscan "phish-hack" tags as of 2022. 6,205 addresses after dedupe |
| ImMike/crypto-wallet-address-labels, forta-network `malicious_smart_contracts.csv` | `data/labels/imported-immike-forta-malicious.json` | MIT / MIT | `source: import:immike-forta-malicious` | Exploit and heist contracts plus their named deployers. 756 addresses |
| ImMike/crypto-wallet-address-labels, blockchain-unit `exchange.csv` | `data/labels/imported-immike-exchanges.json` | MIT (aggregator). Upstream blockchain-unit repository has no LICENSE file; the content is Etherscan public name tags | `source: import:immike-exchanges` | Only addresses whose entity is in `data/vasps.json` with a decided status (44 of 218). The rest is skipped, not guessed |
| ImMike/crypto-wallet-address-labels, etherclust `exchanges.csv` | `data/labels/imported-immike-etherclust.json` | MIT (aggregator). Upstream etherclust LICENSE not located at the expected path | `source: import:immike-etherclust` | Same `vasps.json` gate (42 of 243) |
| Tornado Cash pool and router addresses | `data/labels/mixers.json`, `seed.json` | Facts from the 2022 OFAC designation (public domain) | `source` field | Delisted March 2025, still mixers. Addresses to be confirmed against Etherscan tags, VERIFY.md step 6 |
| Bridge contract addresses | `data/labels/bridges.json` | Facts (contract addresses published by the bridge operators) | `source` field | Same confirmation step |
| `data/vasps.json` | runtime, importer | Own work (Punit Thakker) | - | Licence statuses are from public regulator registers as remembered on 2026-11-05 and are unverified; question 10 |
| Explorer and RPC responses (Etherscan, Blockscout, Routescan, TronGrid, Tronscan, Helius, public RPCs) | transient, fixtures when recorded | Provider terms of service, free tiers | `docs/SOURCES.md` | Not redistributed; fixtures hold our own probe responses only |

## Opt-in only (never in the default path)

| Dataset | Licence | Why it is off | How to enable |
|---|---|---|---|
| scamsniffer/scam-database `blacklist/address.json` | GPL-3.0 | Copyleft. Also frozen by upstream since February 2024 (2,530 addresses); the live list is domains only | `pnpm import:labels -- scamsniffer` writes `data/labels-optional/imported-scamsniffer.json` (git-ignored); `CR_LABELS_EXTRA_DIR=data/labels-optional` loads it. Question 9 |
| Scorechain free sanctions API | Non-commercial terms | Commercial product | `SCORECHAIN_API_KEY`, and a commercial agreement first |
| TRM, Chainalysis KYT, Elliptic | Paid | Phase 4, with Punit | adapter stubs only |

## Looked at and not used

| Dataset | Licence | Reason |
|---|---|---|
| MetaMask/eth-phishing-detect | "Don't Be A Dick Public Licence" 1.2 | It is a domain list (`src/config.json`: `blacklist`, `fuzzylist`, `whitelist` of hostnames), not an address list. Nothing to import for address screening. May serve the bot's link checks later; the licence is permissive but unusual, flag to counsel before use |
| scamsniffer `blacklist/domains.json` | GPL-3.0 | Domains, same copyleft question |
| ImMike `bitcoin-transaction-classification` (Elliptic) | Kaggle terms, research | Bitcoin, Phase 4 |
| ImMike `bsc-ethereum-address-tags` (stream-spider) | MIT aggregator, scraped Etherscan label directory | Category index and dated snapshots, not per-address rows in a usable shape; Etherscan terms restrict bulk scraping, so not redistributed |
| ImMike `multi-chain-crypto-address-labels` (Jasontth) | not checked | Bitcoin and Bitcoin Cash heavy; revisit in Phase 4 |

## How the importer records this

`pnpm import:labels` writes `data/label-imports.json` with the URL, licence string, fetch time, row counts and skip reasons per source. Every imported label carries `source: import:<id>` so a report line can be traced back to the dataset and this table.
