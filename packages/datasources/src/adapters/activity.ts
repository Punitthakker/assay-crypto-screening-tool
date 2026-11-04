import { z } from "zod";
import { getChain, type ChainId, type TokenDef } from "@cr/shared";
import type { Transport } from "../transport.js";

/**
 * Account activity: how old a wallet is, how busy, whether it is a contract, and
 * which spenders it has approved. Feeds the behavioural signals (SCORING.md 2b).
 * Every field is best effort and independently nullable; the engine states which
 * signals it could not evaluate instead of guessing. All reads go through Transport.
 *
 *   EVM, Etherscan key set   txlist (first and last 25 txs), getsourcecode, getLogs Approval
 *   EVM, keyless             Blockscout address, counters, transactions (hosted instances)
 *   EVM, always              eth_getTransactionCount (nonce), eth_getCode, owner() probe on contracts
 *   Tron                     TronGrid /v1/accounts (create_time, latest_opration_time), Tronscan accountv2 (tx count)
 *   Solana                   Helius enhanced transactions (recent timestamps), token-account delegates
 */

export interface Activity {
  /** unix seconds of the first transaction seen, null when no source could tell */
  firstSeen: number | null;
  /** unix seconds of the latest transaction seen */
  lastSeen: number | null;
  /** outbound transaction count (EVM nonce) or total transactions where the explorer counts them */
  txCount: number | null;
  /** what txCount counts, for the report */
  txCountBasis: "nonce" | "transactions" | null;
  /** latest transaction timestamps, newest first, up to 25 */
  recentTimestamps: number[];
  isContract: boolean | null;
  contract?: {
    verified: boolean | null;
    /** proxy, or an owner() that answers with a non-zero address */
    upgradeable: boolean | null;
    admin?: string;
    implementation?: string;
  };
  providers: string[];
  /** sources that failed, for the coverage line */
  errors: string[];
}

export interface Approval {
  spender: string;
  txHash?: string;
  /** unix seconds when known */
  timestamp?: number;
}

export interface ApprovalsResult {
  status: "ok" | "unavailable" | "not_applicable";
  approvals: Approval[];
  detail: string;
}

const EtherscanTx = z.object({ timeStamp: z.string(), hash: z.string() }).passthrough();
const EtherscanTxList = z.object({ status: z.string(), message: z.string().optional(), result: z.union([z.array(EtherscanTx), z.string()]) });
const EtherscanSource = z.object({
  status: z.string(),
  result: z.union([z.array(z.object({ SourceCode: z.string(), Proxy: z.string().optional(), Implementation: z.string().optional() }).passthrough()), z.string()]),
});
const EtherscanLogs = z.object({
  status: z.string(),
  message: z.string().optional(),
  result: z.union([z.array(z.object({ topics: z.array(z.string()), transactionHash: z.string(), timeStamp: z.string().optional() }).passthrough()), z.string()]),
});
const BlockscoutAddress = z
  .object({
    is_contract: z.boolean().nullable().optional(),
    is_verified: z.boolean().nullable().optional(),
    proxy_type: z.string().nullable().optional(),
    implementations: z.array(z.object({ address: z.string().nullable().optional() }).passthrough()).nullable().optional(),
  })
  .passthrough();
const BlockscoutCounters = z.object({ transactions_count: z.union([z.string(), z.number()]).nullable().optional() }).passthrough();
const BlockscoutTxs = z.object({ items: z.array(z.object({ timestamp: z.string() }).passthrough()) }).passthrough();
const TronAccount = z.object({
  success: z.boolean().optional(),
  data: z.array(z.object({ create_time: z.number().optional(), latest_opration_time: z.number().optional() }).passthrough()).default([]),
});
const TronscanAccount = z
  .object({
    date_created: z.number().optional(),
    latest_operation_time: z.number().optional(),
    transactions: z.number().optional(),
    accountType: z.number().optional(),
  })
  .passthrough();
const HeliusTxs = z.array(z.object({ timestamp: z.number() }).passthrough());

/** ERC-20 Approval(address indexed owner, address indexed spender, uint256 value) */
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
/** owner() selector, OpenZeppelin Ownable */
const OWNER_SELECTOR = "0x8da5cb5b";
const ZERO = "0x0000000000000000000000000000000000000000";

export const BLOCKSCOUT_ACTIVITY_HOSTS: Partial<Record<ChainId, string>> = {
  ethereum: "https://eth.blockscout.com",
  base: "https://base.blockscout.com",
  arbitrum: "https://arbitrum.blockscout.com",
  polygon: "https://polygon.blockscout.com",
  optimism: "https://optimism.blockscout.com",
};

export class ActivityAdapter {
  private etherscanKey: string | undefined;
  private etherscanBase: string;
  private tronBase: string;
  private tronKey: string | undefined;
  private tronscanBase: string;
  private tronscanKey: string | undefined;
  private heliusKey: string | undefined;
  private blockscout: Partial<Record<ChainId, string>>;

  constructor(
    private transport: Transport,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.etherscanKey = env.ETHERSCAN_API_KEY?.trim() || undefined;
    this.etherscanBase = "https://api.etherscan.io/v2/api";
    const tron = env.RPC_TRON?.split(",")[0]?.trim();
    this.tronBase = (tron && tron.length ? tron : "https://api.trongrid.io").replace(/\/$/, "");
    this.tronKey = env.TRONGRID_API_KEY;
    this.tronscanBase = (env.TRONSCAN_API ?? "https://apilist.tronscanapi.com").replace(/\/$/, "");
    this.tronscanKey = env.TRONSCAN_API_KEY;
    this.heliusKey = env.HELIUS_API_KEY;
    this.blockscout = { ...BLOCKSCOUT_ACTIVITY_HOSTS };
    for (const id of Object.keys(this.blockscout).concat(["avalanche", "bnb"]) as ChainId[]) {
      const o = env[`BLOCKSCOUT_${id.toUpperCase()}`];
      if (o && o.trim()) this.blockscout[id] = o.trim().replace(/\/$/, "");
    }
  }

  async activity(address: string, chain: ChainId): Promise<Activity> {
    const fam = getChain(chain).family;
    const a: Activity = { firstSeen: null, lastSeen: null, txCount: null, txCountBasis: null, recentTimestamps: [], isContract: null, providers: [], errors: [] };
    if (fam === "evm") await this.evm(address, chain, a);
    else if (fam === "tron") await this.tron(address, a);
    else if (fam === "solana") await this.solana(address, a);
    else a.errors.push(`${fam}: activity not supported`);
    if (a.lastSeen === null && a.recentTimestamps.length) a.lastSeen = a.recentTimestamps[0]!;
    return a;
  }

  /** Spenders approved by `address` on the screened token. EVM needs an Etherscan key; Solana reads token-account delegates; Tron is not evaluated yet. */
  async approvals(address: string, token: TokenDef): Promise<ApprovalsResult> {
    const fam = getChain(token.chain).family;
    try {
      if (fam === "evm") {
        if (!this.etherscanKey) return { status: "unavailable", approvals: [], detail: "approval log scan needs ETHERSCAN_API_KEY" };
        const c = getChain(token.chain);
        const q = new URLSearchParams({
          chainid: String(c.etherscanChainId),
          module: "logs",
          action: "getLogs",
          address: token.address,
          fromBlock: "0",
          toBlock: "latest",
          topic0: APPROVAL_TOPIC,
          topic0_1_opr: "and",
          topic1: pad32(address),
          page: "1",
          offset: "1000",
          apikey: this.etherscanKey,
        });
        const res = EtherscanLogs.parse(await this.transport.fetchJson(`${this.etherscanBase}?${q.toString()}`));
        if (typeof res.result === "string") {
          if (/no records found/i.test(res.result) || /no records found/i.test(res.message ?? "")) return { status: "ok", approvals: [], detail: "no Approval events via etherscan-v2" };
          throw new Error(`etherscan-v2: ${res.message ?? "error"}: ${res.result}`);
        }
        const approvals: Approval[] = res.result
          .filter((l) => l.topics.length >= 3)
          .map((l) => ({
            spender: `0x${l.topics[2]!.slice(-40)}`,
            txHash: l.transactionHash,
            ...(l.timeStamp ? { timestamp: Number(l.timeStamp) } : {}),
          }));
        return { status: "ok", approvals, detail: `${approvals.length} Approval event${approvals.length === 1 ? "" : "s"} via etherscan-v2` };
      }
      if (fam === "solana") {
        const accounts = await this.transport.solanaTokenAccounts(address, token.address);
        const approvals = accounts.filter((t) => t.delegate).map((t) => ({ spender: t.delegate! }));
        return { status: "ok", approvals, detail: `${approvals.length} delegate${approvals.length === 1 ? "" : "s"} on ${accounts.length} token account${accounts.length === 1 ? "" : "s"}` };
      }
      return { status: "not_applicable", approvals: [], detail: `approval scan not implemented for ${fam}` };
    } catch (e) {
      return { status: "unavailable", approvals: [], detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private async evm(address: string, chain: ChainId, a: Activity) {
    const c = getChain(chain);
    const addr = address as `0x${string}`;
    const tasks: Promise<unknown>[] = [];
    tasks.push(
      this.transport
        .evmGetTransactionCount(chain, addr)
        .then((n) => {
          a.txCount = n;
          a.txCountBasis = "nonce";
          a.providers.push("rpc:nonce");
        })
        .catch((e) => a.errors.push(`nonce: ${msg(e)}`)),
    );
    tasks.push(
      this.transport
        .evmGetCode(chain, addr)
        .then(async (code) => {
          a.isContract = code !== undefined && code !== "0x" && code.length > 2;
          a.providers.push("rpc:code");
          if (a.isContract) {
            a.contract ??= { verified: null, upgradeable: null };
            try {
              const out = await this.transport.evmCall(chain, addr, OWNER_SELECTOR);
              if (out && out.length >= 66) {
                const owner = `0x${out.slice(-40)}`;
                if (owner !== ZERO) {
                  a.contract.upgradeable = true;
                  a.contract.admin = owner;
                }
              }
            } catch {
              /* no owner(): not an Ownable contract, nothing to say */
            }
          }
        })
        .catch((e) => a.errors.push(`code: ${msg(e)}`)),
    );
    if (this.etherscanKey && c.etherscanChainId) {
      const base = (action: string, extra: Record<string, string>) => {
        const q = new URLSearchParams({ chainid: String(c.etherscanChainId), module: "account", action, address, ...extra, apikey: this.etherscanKey! });
        return `${this.etherscanBase}?${q.toString()}`;
      };
      tasks.push(
        this.transport
          .fetchJson(base("txlist", { page: "1", offset: "1", sort: "asc" }))
          .then((raw) => {
            const r = EtherscanTxList.parse(raw);
            if (typeof r.result === "string") {
              if (!/no transactions found/i.test(r.result) && !/no transactions found/i.test(r.message ?? "")) throw new Error(r.result);
              return;
            }
            const first = r.result[0];
            if (first) a.firstSeen = Number(first.timeStamp);
            a.providers.push("etherscan-v2");
          })
          .catch((e) => a.errors.push(`etherscan first tx: ${msg(e)}`)),
      );
      tasks.push(
        this.transport
          .fetchJson(base("txlist", { page: "1", offset: "25", sort: "desc" }))
          .then((raw) => {
            const r = EtherscanTxList.parse(raw);
            if (typeof r.result === "string") return;
            a.recentTimestamps = r.result.map((t) => Number(t.timeStamp)).sort((x, y) => y - x);
          })
          .catch((e) => a.errors.push(`etherscan recent txs: ${msg(e)}`)),
      );
    } else if (this.blockscout[chain]) {
      const host = this.blockscout[chain]!;
      tasks.push(
        this.transport
          .fetchJson(`${host}/api/v2/addresses/${address}/counters`)
          .then((raw) => {
            const r = BlockscoutCounters.parse(raw);
            if (r.transactions_count !== null && r.transactions_count !== undefined && a.txCount === null) {
              a.txCount = Number(r.transactions_count);
              a.txCountBasis = "transactions";
            }
            a.providers.push("blockscout");
          })
          .catch((e) => a.errors.push(`blockscout counters: ${msg(e)}`)),
      );
      tasks.push(
        this.transport
          .fetchJson(`${host}/api/v2/addresses/${address}/transactions`)
          .then((raw) => {
            const r = BlockscoutTxs.parse(raw);
            a.recentTimestamps = r.items
              .map((t) => Math.floor(Date.parse(t.timestamp) / 1000))
              .filter((t) => Number.isFinite(t))
              .sort((x, y) => y - x)
              .slice(0, 25);
          })
          .catch((e) => a.errors.push(`blockscout transactions: ${msg(e)}`)),
      );
    } else {
      a.errors.push(`no explorer for ${chain}: first-seen and recent activity not available (set ETHERSCAN_API_KEY)`);
    }
    await Promise.all(tasks);
    // contract verification status, only once we know it is a contract
    if (a.isContract) {
      a.contract ??= { verified: null, upgradeable: null };
      try {
        if (this.etherscanKey && c.etherscanChainId) {
          const q = new URLSearchParams({ chainid: String(c.etherscanChainId), module: "contract", action: "getsourcecode", address, apikey: this.etherscanKey });
          const r = EtherscanSource.parse(await this.transport.fetchJson(`${this.etherscanBase}?${q.toString()}`));
          const row = typeof r.result === "string" ? undefined : r.result[0];
          if (row) {
            a.contract.verified = row.SourceCode.trim().length > 0;
            if (row.Proxy === "1" || (row.Implementation && row.Implementation !== "")) {
              a.contract.upgradeable = true;
              if (row.Implementation) a.contract.implementation = row.Implementation;
            } else if (a.contract.upgradeable === null) a.contract.upgradeable = false;
          }
        } else if (this.blockscout[chain]) {
          const r = BlockscoutAddress.parse(await this.transport.fetchJson(`${this.blockscout[chain]}/api/v2/addresses/${address}`));
          if (typeof r.is_verified === "boolean") a.contract.verified = r.is_verified;
          const impl = r.implementations?.find((i) => i.address)?.address;
          if (r.proxy_type || impl) {
            a.contract.upgradeable = true;
            if (impl) a.contract.implementation = impl;
          } else if (a.contract.upgradeable === null) a.contract.upgradeable = false;
        }
      } catch (e) {
        a.errors.push(`contract source: ${msg(e)}`);
      }
    }
  }

  private async tron(address: string, a: Activity) {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.tronKey) headers["TRON-PRO-API-KEY"] = this.tronKey;
    try {
      const r = TronAccount.parse(await this.transport.fetchJson(`${this.tronBase}/v1/accounts/${address}`, { headers }));
      const row = r.data[0];
      if (row) {
        if (row.create_time) a.firstSeen = Math.floor(row.create_time / 1000);
        if (row.latest_opration_time) a.lastSeen = Math.floor(row.latest_opration_time / 1000);
      }
      a.providers.push("trongrid");
    } catch (e) {
      a.errors.push(`trongrid account: ${msg(e)}`);
    }
    try {
      const h2: Record<string, string> = { accept: "application/json" };
      if (this.tronscanKey) h2["TRON-PRO-API-KEY"] = this.tronscanKey;
      const r = TronscanAccount.parse(await this.transport.fetchJson(`${this.tronscanBase}/api/accountv2?address=${address}`, { headers: h2 }));
      if (typeof r.transactions === "number") {
        a.txCount = r.transactions;
        a.txCountBasis = "transactions";
      }
      if (a.firstSeen === null && r.date_created) a.firstSeen = Math.floor(r.date_created / 1000);
      if (a.lastSeen === null && r.latest_operation_time) a.lastSeen = Math.floor(r.latest_operation_time / 1000);
      if (typeof r.accountType === "number") a.isContract = r.accountType === 2;
      a.providers.push("tronscan");
    } catch (e) {
      a.errors.push(`tronscan account: ${msg(e)}`);
    }
    if (a.lastSeen !== null) a.recentTimestamps = [a.lastSeen];
  }

  private async solana(address: string, a: Activity) {
    if (!this.heliusKey) {
      a.errors.push("solana activity needs HELIUS_API_KEY");
      return;
    }
    try {
      const q = new URLSearchParams({ "api-key": this.heliusKey, limit: "25" });
      const r = HeliusTxs.parse(await this.transport.fetchJson(`https://api.helius.xyz/v0/addresses/${address}/transactions?${q.toString()}`));
      a.recentTimestamps = r.map((t) => t.timestamp).sort((x, y) => y - x);
      if (r.length < 25 && r.length > 0) {
        // the whole history fitted in one page: the oldest entry is the first transaction
        a.firstSeen = a.recentTimestamps[a.recentTimestamps.length - 1]!;
        a.txCount = r.length;
        a.txCountBasis = "transactions";
      }
      a.providers.push("helius");
    } catch (e) {
      a.errors.push(`helius transactions: ${msg(e)}`);
    }
  }
}

function pad32(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
