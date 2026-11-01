import type { ChainId } from "./chains.js";

export type AssetSymbol = "USDT" | "USDC";

export type TokenKind =
  /** issued by Tether or Circle on this chain, issuer freeze applies */
  | "native"
  /** Tether USDT0 (LayerZero OFT) - issuer control exists, read method confirmed live */
  | "native-oft"
  /** bridge or exchange-pegged copy; issuer freeze NOT applicable */
  | "bridged";

export type FreezeMethod =
  | { kind: "evm"; fn: "isBlackListed" | "isBlacklisted" }
  | { kind: "tron"; fn: "isBlackListed" }
  | { kind: "spl" }
  | { kind: "tbd" } // ABI must be confirmed on-chain first (USDT0)
  | { kind: "none" };

export interface TokenDef {
  chain: ChainId;
  symbol: AssetSymbol;
  /** what the token actually is on-chain (may differ from the symbol users type) */
  onChainSymbol: string;
  issuer: "Tether" | "Circle" | "Binance" | "Bridge";
  kind: TokenKind;
  address: string;
  decimals: number;
  freeze: FreezeMethod;
  note?: string;
}

export const TOKENS: TokenDef[] = [
  // Ethereum
  { chain: "ethereum", symbol: "USDT", onChainSymbol: "USDT", issuer: "Tether", kind: "native", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, freeze: { kind: "evm", fn: "isBlackListed" } },
  { chain: "ethereum", symbol: "USDC", onChainSymbol: "USDC", issuer: "Circle", kind: "native", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, freeze: { kind: "evm", fn: "isBlacklisted" } },
  // Tron
  { chain: "tron", symbol: "USDT", onChainSymbol: "USDT", issuer: "Tether", kind: "native", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, freeze: { kind: "tron", fn: "isBlackListed" } },
  // Solana
  { chain: "solana", symbol: "USDT", onChainSymbol: "USDT", issuer: "Tether", kind: "native", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, freeze: { kind: "spl" } },
  { chain: "solana", symbol: "USDC", onChainSymbol: "USDC", issuer: "Circle", kind: "native", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, freeze: { kind: "spl" } },
  // Base
  { chain: "base", symbol: "USDC", onChainSymbol: "USDC", issuer: "Circle", kind: "native", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, freeze: { kind: "evm", fn: "isBlacklisted" } },
  { chain: "base", symbol: "USDC", onChainSymbol: "USDbC", issuer: "Bridge", kind: "bridged", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6, freeze: { kind: "none" }, note: "Coinbase-bridged USDbC, not Circle-issued" },
  // Arbitrum
  { chain: "arbitrum", symbol: "USDC", onChainSymbol: "USDC", issuer: "Circle", kind: "native", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, freeze: { kind: "evm", fn: "isBlacklisted" } },
  { chain: "arbitrum", symbol: "USDC", onChainSymbol: "USDC.e", issuer: "Bridge", kind: "bridged", address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", decimals: 6, freeze: { kind: "none" }, note: "Arbitrum-bridged USDC.e" },
  { chain: "arbitrum", symbol: "USDT", onChainSymbol: "USDT0", issuer: "Tether", kind: "native-oft", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, freeze: { kind: "tbd" }, note: "USDT0 since Jan 2025; blacklist view function to be confirmed from live ABI" },
  // Polygon
  { chain: "polygon", symbol: "USDC", onChainSymbol: "USDC", issuer: "Circle", kind: "native", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, freeze: { kind: "evm", fn: "isBlacklisted" } },
  { chain: "polygon", symbol: "USDC", onChainSymbol: "USDC.e", issuer: "Bridge", kind: "bridged", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6, freeze: { kind: "none" }, note: "Polygon-bridged USDC.e" },
  { chain: "polygon", symbol: "USDT", onChainSymbol: "USDT0", issuer: "Tether", kind: "native-oft", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, freeze: { kind: "tbd" }, note: "USDT0 since Aug 2025; blacklist view function to be confirmed from live ABI" },
  // Avalanche
  { chain: "avalanche", symbol: "USDT", onChainSymbol: "USDt", issuer: "Tether", kind: "native", address: "0x9702230A8Ea53601f5Cd2dc00fDbc13d4dF4A8c7", decimals: 6, freeze: { kind: "evm", fn: "isBlackListed" } },
  { chain: "avalanche", symbol: "USDC", onChainSymbol: "USDC", issuer: "Circle", kind: "native", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, freeze: { kind: "evm", fn: "isBlacklisted" } },
  // BNB Chain (Binance-Peg only)
  { chain: "bnb", symbol: "USDT", onChainSymbol: "BSC-USD", issuer: "Binance", kind: "bridged", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, freeze: { kind: "none" }, note: "Binance-Peg BSC-USD; Tether has no freeze control on BNB Chain" },
  { chain: "bnb", symbol: "USDC", onChainSymbol: "USDC", issuer: "Binance", kind: "bridged", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, freeze: { kind: "none" }, note: "Binance-Peg USDC; Circle does not issue on BNB Chain" },
  // Optimism (registry-ready, chain disabled)
  { chain: "optimism", symbol: "USDC", onChainSymbol: "USDC", issuer: "Circle", kind: "native", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, freeze: { kind: "evm", fn: "isBlacklisted" } },
];

/** Canonical (issuer-controlled) token for a symbol on a chain, or undefined if only bridged copies exist. */
export function canonicalToken(chain: ChainId, symbol: AssetSymbol): TokenDef | undefined {
  return TOKENS.find((t) => t.chain === chain && t.symbol === symbol && t.kind !== "bridged");
}

/** All registry entries for a symbol on a chain (native + bridged). */
export function tokensFor(chain: ChainId, symbol: AssetSymbol): TokenDef[] {
  return TOKENS.filter((t) => t.chain === chain && t.symbol === symbol);
}

/** Look a token up by its contract/mint, case-insensitive for EVM. */
export function tokenByAddress(chain: ChainId, address: string): TokenDef | undefined {
  const a = address.toLowerCase();
  return TOKENS.find((t) => t.chain === chain && t.address.toLowerCase() === a);
}
