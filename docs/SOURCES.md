# Data sources - verification log

Verified: 2026-11-01 (Dubai). Method: issuer developer docs, public explorers via search, the 0xB10C list mirror pulled directly. On-chain reads could not be executed from the build sandbox (no RPC egress); `pnpm verify:sources` re-checks every entry against live RPC and must be run from a machine with internet access before the first demo.

Status key: VERIFIED (confirmed against issuer source today), LIVE-CHECK (address confirmed, ABI or behaviour must be confirmed on-chain by `verify:sources`), N/A (no issuer control on that chain), OPEN (not yet sourced).

## Issuer freeze reads

| Chain | Asset | Contract | Freeze read | Status | Note |
|---|---|---|---|---|---|
| Ethereum | USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | `isBlackListed(address)` | VERIFIED | Tether-issued ERC-20, 6 decimals. Events `AddedBlackList`, `RemovedBlackList`, `DestroyedBlackFunds`. |
| Ethereum | USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `isBlacklisted(address)` | VERIFIED | Circle FiatTokenProxy; read through proxy. Events `Blacklisted`, `UnBlacklisted`. |
| Tron | USDT | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | `isBlackListed(address)` via TronGrid `triggerconstantcontract` | VERIFIED | Largest USDT deployment. No Circle-native USDC on Tron (Circle discontinued Tron support Feb 2024). |
| Solana | USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | SPL token account `state == frozen` on the holder's associated token account | LIVE-CHECK | Freeze authority held by Tether; freeze is per token account, not per wallet. |
| Solana | USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL token account `state == frozen` | VERIFIED (mint) / LIVE-CHECK (read) | Circle developer docs list this mint. |
| Base | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `isBlacklisted(address)` | VERIFIED | Native Circle USDC. USDbC on Base is bridged, not Circle-issued. |
| Arbitrum One | USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `isBlacklisted(address)` | VERIFIED | Native. `0xFF97...` USDC.e is bridged. |
| Arbitrum One | USDT | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | **USDT0 (LayerZero OFT)** - method to be read from ABI | LIVE-CHECK | Migrated to USDT0 in Jan 2025, same address. OpenZeppelin audit confirms an owner "block accounts" capability; exact view function name must be confirmed on Arbiscan before use. Do not assume `isBlackListed`. |
| Polygon PoS | USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | `isBlacklisted(address)` | VERIFIED | Native. `0x2791...` USDC.e is bridged. |
| Polygon PoS | USDT | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | **USDT0** - method to be read from ABI | LIVE-CHECK | Migrated to USDT0 in Aug 2025, same address. Same caveat as Arbitrum. |
| Avalanche C-Chain | USDT | `0x9702230A8Ea53601f5Cd2dc00fDbc13d4dF4A8c7` | `isBlackListed(address)` | LIVE-CHECK | Tether-issued native. |
| Avalanche C-Chain | USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | `isBlacklisted(address)` | VERIFIED | Native Circle. |
| OP Mainnet | USDC | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `isBlacklisted(address)` | VERIFIED | Native Circle. Not in v1 chain list but registry-ready. |
| BNB Chain | USDT | `0x55d398326f99059fF775485246999027B3197955` | none | N/A | Binance-Peg BSC-USD, 18 decimals, issued by Binance, not Tether. Report must say "bridged asset, issuer freeze not applicable, Binance custody risk applies". |
| BNB Chain | USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | none | N/A | Binance-Peg USDC. Circle does not list BNB Chain. Same treatment. |

## Live findings (Railway, 2026-11-01)

- Tether blacklists the sink addresses `0x0`, `0x1` and the USDT contract itself. `0x…0001` is used as the permanent positive control for the freeze read.
- `0x28C6c06298d514Db089934071355E5743bf21d60` (Binance 14) is blacklisted by both Tether and Circle following the 2026 Binance hot-wallet hack. Public label databases still tag it as a Binance hot wallet. The engine returns BLOCK; the label is kept for context only.
- `eth.llamarpc.com` returned HTML and `cloudflare-eth.com` returned internal errors; both removed from the rotation. `publicnode` and `1rpc` agree on every control.

## Issuer freeze events (historic index, added 2026-11-06)

| Issuer | Events | Address field | Provider | Status |
|---|---|---|---|---|
| Tether (TetherToken, Ethereum, Avalanche, Tron) | `AddedBlackList(address)`, `RemovedBlackList(address)`, `DestroyedBlackFunds(address,uint256)` | not indexed, first word of `data` | Etherscan V2 `getLogs`, Blockscout `/api`, TronGrid `/v1/contracts/{c}/events` | FIXTURE-TESTED, live check VERIFY.md step 7. Topic hashes computed from the signatures with viem |
| Circle (FiatToken, Ethereum, Base, Arbitrum, Polygon, Avalanche, Optimism) | `Blacklisted(address indexed)`, `UnBlacklisted(address indexed)` | `topics[1]` | same | FIXTURE-TESTED, live check VERIFY.md step 7 |
| Solana (SPL) | none; `FreezeAccount` / `ThawAccount` are instructions on the token account | - | - | N/A, live read only |
| USDT0 (Arbitrum, Polygon), Binance-Peg (BNB) | unknown / none | - | - | skipped until the freeze method is confirmed |

## Sanctions

| Source | Endpoint / contract | Status | Note |
|---|---|---|---|
| OFAC SDN crypto addresses (0xB10C mirror) | `https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_<TICKER>.json` | VERIFIED (pulled today) | Counts today: XBT 532, TRX 266, ETH 123, USDT 94, SOL 4, ARB 1, BSC 1. Nightly GitHub Action from `sdn_advanced.xml`. MIT licence. |
| OFAC raw | `https://www.treasury.gov/ofac/downloads/sanctions/1.0/sdn_advanced.xml` | VERIFIED (URL from tool README) | Fallback parser if the mirror is stale > 48h. |
| Chainalysis Sanctions Oracle | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` on Ethereum, Polygon, BNB Chain, Avalanche, Arbitrum, Optimism, Fantom, Celo, Blast. Base: `0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B`. `isSanctioned(address) view returns (bool)` | VERIFIED (addresses from Chainalysis-published docs mirrored in a public issue; official page not fetchable from sandbox) | Free, no customer relationship. Chainalysis disclaims timeliness. Treat as second source, never sole source. |
| Scorechain free sanctions API | `https://www.scorechain.com/developers/free-sanction-api` | VERIFIED (terms) | Non-commercial, 100 req/hr. Adapter default OFF. Must not be in production path. |
| TRM free sanctions API | on request | OPEN | Stub only. |
| UN consolidated list | `https://scsanctions.un.org/resources/xml/en/consolidated.xml` | VERIFIED (from moneybee-risk-datasources LIVE_DATA.md) | Name list, Identity layer via Watchman. |
| UAE Local Terrorist List (EOCN) | via OpenSanctions dataset `ae_local_terrorists` or EOCN source | VERIFIED (reference) | Name list, Identity layer. |

## Attribution and labels

| Source | Location | Licence | Status |
|---|---|---|---|
| ImMike/crypto-wallet-address-labels | GitHub, raw files over raw.githubusercontent.com | MIT (aggregator); forta subsets MIT; blockchain-unit and etherclust upstreams carry no licence file | VERIFIED 2026-11-05 (LICENSE read). Imported by `pnpm import:labels` into `data/labels/imported-immike-*.json`: 6,205 phishing, 756 malicious contracts, 86 exchange wallets gated by `data/vasps.json`. Full table in `docs/LICENCES.md` |
| MetaMask/eth-phishing-detect | GitHub | DBAD 1.2 (not MIT) | VERIFIED 2026-11-05: domain list only (`src/config.json`), no addresses. Not imported |
| ScamSniffer blacklist | GitHub `scamsniffer/scam-database` `blacklist/address.json` | GPL-3.0 | VERIFIED 2026-11-05. Opt-in only (`pnpm import:labels -- scamsniffer`, `CR_LABELS_EXTRA_DIR`); upstream froze the address list in 2024-02. Question 9 |
| Mixers (Tornado Cash pools and routers) | `data/labels/mixers.json` (18 pools) plus the two routers in `seed.json` | Facts from the 2022 OFAC designation, delisted 2025-03 | LIVE-CHECK: confirm each address shows the Tornado.Cash tag on etherscan (VERIFY.md step 6) |
| Bridges | `data/labels/bridges.json` (9 contracts: Wormhole, Polygon PoS, Arbitrum, Optimism, Base, Avalanche, Multichain, OP Stack predeploy) | Facts | LIVE-CHECK: confirm tags on etherscan (VERIFY.md step 6) |
| VASP register | `data/vasps.json` (33 entities: status licensed / unlicensed / unknown, jurisdiction, licence) | own | OPEN: statuses remembered from public registers, unverified; question 10 |

## Chain data

| Provider | Scope | Free tier (as published, re-check) | Status |
|---|---|---|---|
| Etherscan API V2 | 60+ EVM chains, one key | ~3-5 calls/s, 100K/day | VERIFIED (docs) - key required even for free. Adapter: `EtherscanV2Explorer`, `tokentx` sorted desc, 200 per page, up to 5 pages |
| Tronscan API | Tron | key required: keyless calls answered HTTP 401 from Railway on 2026-11-02; free key from tronscan.org account settings, set `TRONSCAN_API_KEY` | LIVE-CHECK (shape), VERIFIED (needs key). Adapter: `TronscanExplorer` (`/api/token_trc20/transfers`, pages of 50) and `TxResolver.tronscan` (`/api/transaction-info`). Fallback after TronGrid |
| TronGrid | Tron | 100K req/day, 15 QPS with key; keyless 429s after a few `/v1/` calls (seen on Railway 2026-11-02) | VERIFIED (docs). Adapter: `TronGridExplorer`, `/v1/accounts/{addr}/transactions/trc20?only_to=true`, fingerprint pagination |
| Helius | Solana | 1M credits/mo, 10 RPS | VERIFIED (docs). Adapter: `HeliusExplorer`, enhanced `/v0/addresses/{addr}/transactions?type=TRANSFER`, key required; no keyless Solana path yet |
| Blockscout | Ethereum, Base, Arbitrum, Polygon, OP hosted instances | hosted free, soft limit | VERIFIED (docs), hosts LIVE-CHECK. Adapter: `BlockscoutExplorer`, `/api/v2/addresses/{addr}/token-transfers?filter=to&token=`, `next_page_params` pagination. Override hosts with `BLOCKSCOUT_<CHAIN>` |
| Routescan (Avalanche) | Etherscan-compatible API for chain 43114 | free, no key | LIVE-CHECK. Adapter: `EtherscanV2Explorer` with the Routescan base URL, fallback only |
| BNB Chain explorer | none keyless | - | OPEN - needs `ETHERSCAN_API_KEY` or a `BLOCKSCOUT_BNB` host |
| Public RPC rotation | all EVM | varies | configured in `packages/shared/src/chains.ts`. Also `eth_getTransactionCount` and `eth_getCode` for the behavioural signals (2026-11-04) |
| Account activity (2026-11-04) | EVM: Etherscan `txlist`, `getsourcecode`, `logs/getLogs`; Blockscout `/api/v2/addresses/{a}`, `/counters`, `/transactions`. Tron: TronGrid `/v1/accounts/{a}`, Tronscan `/api/accountv2`. Solana: Helius `/v0/addresses/{a}/transactions` | same tiers as above | LIVE-CHECK (VERIFY.md step 5). Adapter: `ActivityAdapter` |

## Regulatory references used in the pitch

- VARA Travel Rule circular, 24 Feb 2026; threshold AED 3,500; privacy tokens prohibited; EDD on self-hosted wallets.
- UAE Federal Decree-Law No. 20 of 2018 (AML/CFT) and EOCN local list screening obligation.

Prices, limits and addresses change. `pnpm verify:sources` regenerates `docs/SOURCES.verified.json` with live results and a timestamp; run it before every demo.
