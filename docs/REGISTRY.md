# Chain and token registry - v1 proposal

Source of truth in code: `packages/shared/src/chains.ts` and `packages/shared/src/tokens.ts`. This page is the human-readable mirror. Addresses verified per `SOURCES.md`.

## Chains

| id | Name | Family | Chain ID | Native | Explorer API | RPC (rotated, public) | Oracle (Chainalysis) |
|---|---|---|---|---|---|---|---|
| `ethereum` | Ethereum | evm | 1 | ETH | Etherscan V2 `chainid=1` | publicnode, llamarpc, cloudflare, 1rpc | `0x40C5...C8fb` |
| `tron` | Tron | tron | - | TRX | TronGrid `/v1/accounts/{addr}/transactions/trc20` | api.trongrid.io | none (name-list only) |
| `solana` | Solana | solana | - | SOL | Helius enhanced tx API | api.mainnet-beta.solana.com, Helius | none |
| `base` | Base | evm | 8453 | ETH | Etherscan V2 `chainid=8453` | mainnet.base.org, publicnode | `0x3A91...739B` |
| `arbitrum` | Arbitrum One | evm | 42161 | ETH | Etherscan V2 `chainid=42161` | arb1.arbitrum.io/rpc, publicnode | `0x40C5...C8fb` |
| `polygon` | Polygon PoS | evm | 137 | POL | Etherscan V2 `chainid=137` | polygon-rpc.com, publicnode | `0x40C5...C8fb` |
| `avalanche` | Avalanche C-Chain | evm | 43114 | AVAX | Etherscan V2 `chainid=43114` (Routescan fallback) | api.avax.network, publicnode | `0x40C5...C8fb` |
| `bnb` | BNB Chain | evm | 56 | BNB | Etherscan V2 `chainid=56` | bsc-dataseed.binance.org, publicnode | `0x40C5...C8fb` |
| `optimism` | OP Mainnet | evm | 10 | ETH | Etherscan V2 `chainid=10` | mainnet.optimism.io | `0x40C5...C8fb` | (registry-ready, disabled in v1)

## Tokens

| Chain | Symbol | Issuer | Kind | Contract / mint | Decimals | Freeze read | OFAC list ticker |
|---|---|---|---|---|---|---|---|
| ethereum | USDT | Tether | native | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 | `isBlackListed` | ETH, USDT |
| ethereum | USDC | Circle | native | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 | `isBlacklisted` | ETH |
| tron | USDT | Tether | native | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | 6 | `isBlackListed` (TronGrid constant call) | TRX |
| solana | USDT | Tether | native | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 | SPL ATA `state == frozen` | SOL |
| solana | USDC | Circle | native | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 | SPL ATA `state == frozen` | SOL |
| base | USDC | Circle | native | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | `isBlacklisted` | ETH (shared address space) |
| base | USDbC | Coinbase bridge | bridged | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` | 6 | none | - |
| arbitrum | USDC | Circle | native | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | 6 | `isBlacklisted` | ARB, ETH |
| arbitrum | USDC.e | Arbitrum bridge | bridged | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` | 6 | none | - |
| arbitrum | USDT0 | Tether (OFT) | native-oft | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | 6 | TBD from live ABI | ARB |
| polygon | USDC | Circle | native | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | 6 | `isBlacklisted` | ETH |
| polygon | USDC.e | Polygon bridge | bridged | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | 6 | none | - |
| polygon | USDT0 | Tether (OFT) | native-oft | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | 6 | TBD from live ABI | - |
| avalanche | USDT | Tether | native | `0x9702230A8Ea53601f5Cd2dc00fDbc13d4dF4A8c7` | 6 | `isBlackListed` (confirm live) | - |
| avalanche | USDC | Circle | native | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 6 | `isBlacklisted` | - |
| bnb | USDT (BSC-USD) | Binance | bridged | `0x55d398326f99059fF775485246999027B3197955` | 18 | none (N/A) | BSC |
| bnb | USDC | Binance | bridged | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 | none (N/A) | BSC |

Rules encoded in the registry:
- `kind: bridged` tokens never produce a "clear" freeze result; they produce `freeze: not_applicable` with a note, and the asset-authenticity module adds a fixed risk increment (see SCORING.md).
- Any token contract not in this registry but carrying a USDT/USDC-like symbol is `kind: unknown` and triggers the fake-token hard block.
- EVM addresses are shared across chains, so the OFAC ETH list is applied to every EVM chain; the per-chain tickers (ARB, BSC) are merged in.
