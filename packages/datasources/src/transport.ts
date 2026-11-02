import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, fallback, type Hex } from "viem";
import { getChain, rpcsFor, type ChainId } from "@cr/shared";

export type TransportMode = "live" | "fixture";

export interface SolanaTokenAccount {
  pubkey: string;
  state: "initialized" | "frozen" | "uninitialized";
  amount: string;
}

/**
 * Everything that touches the network goes through here, so the whole engine
 * can run from recorded fixtures (CI, demos, the build sandbox) or live.
 */
export interface Transport {
  readonly mode: TransportMode;
  evmCall(chain: ChainId, to: Hex, data: Hex): Promise<Hex>;
  evmGetCode(chain: ChainId, address: Hex): Promise<Hex>;
  tronConstantCall(contractBase58: string, selector: string, paramHex: string): Promise<Hex>;
  solanaTokenAccounts(owner: string, mint: string): Promise<SolanaTokenAccount[]>;
  fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T>;
  fetchText(url: string, init?: RequestInit): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 8000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export class LiveTransport implements Transport {
  readonly mode = "live" as const;
  private clients = new Map<ChainId, ReturnType<typeof createPublicClient>>();
  constructor(private env: NodeJS.ProcessEnv = process.env, private timeoutMs = DEFAULT_TIMEOUT_MS) {}

  private client(chainId: ChainId) {
    let c = this.clients.get(chainId);
    if (!c) {
      const chain = getChain(chainId);
      if (chain.family !== "evm") throw new Error(`${chainId} is not an EVM chain`);
      const transports = rpcsFor(chain, this.env).map((u) => http(u, { timeout: this.timeoutMs, retryCount: 1 }));
      c = createPublicClient({ transport: fallback(transports, { rank: false }) });
      this.clients.set(chainId, c);
    }
    return c;
  }

  async evmCall(chain: ChainId, to: Hex, data: Hex): Promise<Hex> {
    const res = await withTimeout(this.client(chain).call({ to, data }), this.timeoutMs * 2, `eth_call ${chain}`);
    return (res.data ?? "0x") as Hex;
  }

  async evmGetCode(chain: ChainId, address: Hex): Promise<Hex> {
    const code = await withTimeout(this.client(chain).getCode({ address }), this.timeoutMs * 2, `eth_getCode ${chain}`);
    return (code ?? "0x") as Hex;
  }

  async tronConstantCall(contractBase58: string, selector: string, paramHex: string): Promise<Hex> {
    const base = rpcsFor(getChain("tron"), this.env)[0] ?? "https://api.trongrid.io";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = this.env.TRONGRID_API_KEY;
    const body = {
      owner_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", // any valid address; constant call needs a caller
      contract_address: contractBase58,
      function_selector: selector,
      parameter: paramHex,
      visible: true,
    };
    const res = await this.fetchJson<{ constant_result?: string[]; result?: { result?: boolean; message?: string } }>(
      `${base}/wallet/triggerconstantcontract`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    if (!res.constant_result || !res.constant_result[0]) {
      throw new Error(`TronGrid constant call failed: ${JSON.stringify(res.result ?? res)}`);
    }
    return `0x${res.constant_result[0]}` as Hex;
  }

  async solanaTokenAccounts(owner: string, mint: string): Promise<SolanaTokenAccount[]> {
    const rpcs = rpcsFor(getChain("solana"), this.env);
    const url = this.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${this.env.HELIUS_API_KEY}` : rpcs[0]!;
    const res = await this.fetchJson<{
      result?: { value?: { pubkey: string; account: { data: { parsed: { info: { state: string; tokenAmount: { amount: string } } } } } }[] };
      error?: unknown;
    }>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [owner, { mint }, { encoding: "jsonParsed" }],
      }),
    });
    if (res.error) throw new Error(`solana rpc error: ${JSON.stringify(res.error)}`);
    return (res.result?.value ?? []).map((v) => ({
      pubkey: v.pubkey,
      state: v.account.data.parsed.info.state as SolanaTokenAccount["state"],
      amount: v.account.data.parsed.info.tokenAmount.amount,
    }));
  }

  async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const r = await withTimeout(fetch(url, init), this.timeoutMs, `fetch ${url}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return (await r.json()) as T;
  }

  async fetchText(url: string, init?: RequestInit): Promise<string> {
    const r = await withTimeout(fetch(url, init), this.timeoutMs, `fetch ${url}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  }
}

const SECRET_PARAMS = ["apikey", "api-key", "api_key"];

/** Fixture keys never carry a provider key: query params that look like secrets are blanked. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    let touched = false;
    for (const p of SECRET_PARAMS) {
      if (u.searchParams.has(p)) {
        u.searchParams.set(p, "REDACTED");
        touched = true;
      }
    }
    return touched ? u.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Fixture transport: answers from data/fixtures/recorded.json.
 * Keys:  evm:<chain>:<to>:<data>    tron:<contract>:<selector>:<param>
 *        sol:<owner>:<mint>          url:<url>
 * Unknown keys throw, so a test can never silently pass on missing data.
 * In record mode (CR_RECORD=1) it wraps a live transport and writes what it sees.
 */
export class FixtureTransport implements Transport {
  readonly mode = "fixture" as const;
  private data: Record<string, unknown>;
  constructor(
    private file: string,
    private recordFrom?: Transport,
  ) {
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  }
  private async get<T>(key: string, live: () => Promise<T>): Promise<T> {
    if (key in this.data) return this.data[key] as T;
    if (!this.recordFrom) throw new Error(`fixture miss: ${key}`);
    const v = await live();
    this.data[key] = v;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return v;
  }
  evmCall(chain: ChainId, to: Hex, data: Hex) {
    return this.get(`evm:${chain}:${to.toLowerCase()}:${data}`, () => this.recordFrom!.evmCall(chain, to, data));
  }
  evmGetCode(chain: ChainId, address: Hex) {
    return this.get(`code:${chain}:${address.toLowerCase()}`, () => this.recordFrom!.evmGetCode(chain, address));
  }
  tronConstantCall(c: string, s: string, p: string) {
    return this.get(`tron:${c}:${s}:${p}`, () => this.recordFrom!.tronConstantCall(c, s, p));
  }
  solanaTokenAccounts(owner: string, mint: string) {
    return this.get(`sol:${owner}:${mint}`, () => this.recordFrom!.solanaTokenAccounts(owner, mint));
  }
  fetchJson<T>(url: string, init?: RequestInit) {
    return this.get<T>(`url:${redactUrl(url)}`, () => this.recordFrom!.fetchJson<T>(url, init));
  }
  fetchText(url: string, init?: RequestInit) {
    return this.get<string>(`text:${redactUrl(url)}`, () => this.recordFrom!.fetchText(url, init));
  }
}

export function transportFromEnv(env: NodeJS.ProcessEnv = process.env, fixtureFile?: string): Transport {
  const file = fixtureFile ?? path.resolve(process.cwd(), "data/fixtures/recorded.json");
  if (env.CR_RECORD === "1") return new FixtureTransport(file, new LiveTransport(env));
  if ((env.CR_TRANSPORT ?? "live") === "fixture") return new FixtureTransport(file);
  return new LiveTransport(env);
}
