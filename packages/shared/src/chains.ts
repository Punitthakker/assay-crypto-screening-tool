export type ChainFamily = "evm" | "tron" | "solana" | "bitcoin";

export type ChainId =
  | "ethereum"
  | "tron"
  | "solana"
  | "base"
  | "arbitrum"
  | "polygon"
  | "avalanche"
  | "bnb"
  | "optimism";

export interface ChainDef {
  id: ChainId;
  name: string;
  family: ChainFamily;
  /** EVM numeric chain id; undefined for non-EVM */
  evmChainId?: number;
  nativeSymbol: string;
  /** public RPC rotation (overridable by env RPC_<ID>) */
  rpcs: string[];
  /** Chainalysis sanctions oracle address on this chain, if deployed */
  sanctionsOracle?: `0x${string}`;
  /** Etherscan V2 chainid, when covered */
  etherscanChainId?: number;
  /** OFAC list tickers whose addresses live in this chain's address space */
  ofacTickers: string[];
  enabled: boolean;
}

const ORACLE_DEFAULT = "0x40C57923924B5c5c5455c48D93317139ADDaC8fb" as const;

export const CHAINS: Record<ChainId, ChainDef> = {
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    family: "evm",
    evmChainId: 1,
    nativeSymbol: "ETH",
    rpcs: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com",
      "https://cloudflare-eth.com",
      "https://1rpc.io/eth",
    ],
    sanctionsOracle: ORACLE_DEFAULT,
    etherscanChainId: 1,
    ofacTickers: ["ETH", "USDT", "ARB", "BSC"],
    enabled: true,
  },
  tron: {
    id: "tron",
    name: "Tron",
    family: "tron",
    nativeSymbol: "TRX",
    rpcs: ["https://api.trongrid.io"],
    ofacTickers: ["TRX", "USDT"],
    enabled: true,
  },
  solana: {
    id: "solana",
    name: "Solana",
    family: "solana",
    nativeSymbol: "SOL",
    rpcs: ["https://api.mainnet-beta.solana.com"],
    ofacTickers: ["SOL"],
    enabled: true,
  },
  base: {
    id: "base",
    name: "Base",
    family: "evm",
    evmChainId: 8453,
    nativeSymbol: "ETH",
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    sanctionsOracle: "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B",
    etherscanChainId: 8453,
    ofacTickers: ["ETH", "USDT", "ARB", "BSC"],
    enabled: true,
  },
  arbitrum: {
    id: "arbitrum",
    name: "Arbitrum One",
    family: "evm",
    evmChainId: 42161,
    nativeSymbol: "ETH",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
    sanctionsOracle: ORACLE_DEFAULT,
    etherscanChainId: 42161,
    ofacTickers: ["ETH", "USDT", "ARB", "BSC"],
    enabled: true,
  },
  polygon: {
    id: "polygon",
    name: "Polygon PoS",
    family: "evm",
    evmChainId: 137,
    nativeSymbol: "POL",
    rpcs: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com"],
    sanctionsOracle: ORACLE_DEFAULT,
    etherscanChainId: 137,
    ofacTickers: ["ETH", "USDT", "ARB", "BSC"],
    enabled: true,
  },
  avalanche: {
    id: "avalanche",
    name: "Avalanche C-Chain",
    family: "evm",
    evmChainId: 43114,
    nativeSymbol: "AVAX",
    rpcs: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
    sanctionsOracle: ORACLE_DEFAULT,
    etherscanChainId: 43114,
    ofacTickers: ["ETH", "USDT", "ARB", "BSC"],
    enabled: true,
  },
  bnb: {
    id: "bnb",
    name: "BNB Chain",
    family: "evm",
    evmChainId: 56,
    nativeSymbol: "BNB",
    rpcs: ["https://bsc-dataseed.binance.org", "https://bsc-rpc.publicnode.com"],
    sanctionsOracle: ORACLE_DEFAULT,
    etherscanChainId: 56,
    ofacTickers: ["ETH", "USDT", "ARB", "BSC"],
    enabled: true,
  },
  optimism: {
    id: "optimism",
    name: "OP Mainnet",
    family: "evm",
    evmChainId: 10,
    nativeSymbol: "ETH",
    rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    sanctionsOracle: ORACLE_DEFAULT,
    etherscanChainId: 10,
    ofacTickers: ["ETH", "USDT", "ARB", "BSC"],
    enabled: false,
  },
};

export const CHAIN_IDS = Object.keys(CHAINS) as ChainId[];
export const ENABLED_CHAINS = CHAIN_IDS.filter((c) => CHAINS[c].enabled);

export function getChain(id: string): ChainDef {
  const c = (CHAINS as Record<string, ChainDef | undefined>)[id];
  if (!c) throw new Error(`Unknown chain "${id}". Known: ${CHAIN_IDS.join(", ")}`);
  return c;
}

/** RPC list honouring env override RPC_<CHAINID> (comma separated). */
export function rpcsFor(chain: ChainDef, env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env[`RPC_${chain.id.toUpperCase()}`];
  if (override && override.trim()) return override.split(",").map((s) => s.trim()).filter(Boolean);
  return chain.rpcs;
}
