import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getChain, normalizeAddress, type ChainId } from "@cr/shared";
import type { Transport } from "../transport.js";
import { now, unavailable, type AdapterResult } from "../types.js";

const SOURCE = "ofac-sdn";
const MIRROR = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_";
const ALL_TICKERS = ["XBT", "ETH", "USDT", "USDC", "TRX", "SOL", "ARB", "BSC", "LTC", "XMR", "ZEC", "DASH", "BCH", "ETC", "BTG", "BSV", "XVG", "XRP"];

export interface OfacSnapshot {
  fetchedAt: string;
  /** ticker -> lowercase(for evm)/exact addresses */
  lists: Record<string, string[]>;
}

export class OfacAdapter {
  private snapshot?: OfacSnapshot;
  private cacheDir: string;
  constructor(
    private transport: Transport,
    cacheDir?: string,
    private maxAgeHours = 24,
  ) {
    // fixture mode reads the committed snapshot so CI and demos need no network
    this.cacheDir = cacheDir ?? path.resolve(process.cwd(), transport.mode === "fixture" ? "data/fixtures" : ".cache");
  }

  private cacheFile() {
    return path.join(this.cacheDir, "ofac-snapshot.json");
  }

  async load(force = false): Promise<OfacSnapshot> {
    if (this.snapshot && !force) return this.snapshot;
    const f = this.cacheFile();
    if (!force && existsSync(f)) {
      const ageH = (Date.now() - statSync(f).mtimeMs) / 36e5;
      if (ageH < this.maxAgeHours || this.transport.mode === "fixture") {
        this.snapshot = JSON.parse(readFileSync(f, "utf8")) as OfacSnapshot;
        return this.snapshot;
      }
    }
    const lists: Record<string, string[]> = {};
    const results = await Promise.allSettled(
      ALL_TICKERS.map(async (t) => {
        const arr = await this.transport.fetchJson<string[]>(`${MIRROR}${t}.json`);
        lists[t] = arr;
      }),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (ok === 0) throw new Error("OFAC mirror unreachable for every ticker");
    this.snapshot = { fetchedAt: now(), lists };
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(f, JSON.stringify(this.snapshot));
    return this.snapshot;
  }

  /** Set of all sanctioned addresses relevant to a chain, normalised. */
  async setFor(chain: ChainId): Promise<{ set: Set<string>; ageHours: number; tickers: string[] }> {
    const snap = await this.load();
    const def = getChain(chain);
    const set = new Set<string>();
    for (const t of def.ofacTickers) {
      for (const a of snap.lists[t] ?? []) set.add(normalizeAddress(a, def.family));
    }
    const ageHours = (Date.now() - Date.parse(snap.fetchedAt)) / 36e5;
    return { set, ageHours, tickers: def.ofacTickers.filter((t) => snap.lists[t]) };
  }

  async screen(address: string, chain: ChainId): Promise<AdapterResult> {
    try {
      const def = getChain(chain);
      const { set, ageHours, tickers } = await this.setFor(chain);
      const hit = set.has(normalizeAddress(address, def.family));
      const checkedAt = now();
      return {
        facts: { sanctioned: hit },
        coverage: {
          source: SOURCE,
          status: tickers.length === def.ofacTickers.length ? "ok" : "partial",
          ageHours: Math.round(ageHours * 10) / 10,
          detail: `tickers ${tickers.join(",")}; ${set.size} addresses`,
        },
        evidence: hit
          ? [
              {
                code: "HB_SANCTIONED_LIST",
                source: SOURCE,
                severity: "block",
                points: 100,
                hop: 0,
                summary: "Sender address appears on the OFAC SDN digital currency address list",
                ref: `sdn_advanced.xml via 0xB10C mirror, snapshot ${new Date(Date.parse(checkedAt) - ageHours * 36e5).toISOString()}`,
                checkedAt,
              },
            ]
          : [],
      };
    } catch (e) {
      return unavailable(SOURCE, e);
    }
  }
}
