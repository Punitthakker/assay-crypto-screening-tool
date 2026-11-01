import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { getChain, normalizeAddress, type ChainId } from "@cr/shared";

export type LabelCategory =
  | "exchange_licensed"
  | "exchange_unlicensed"
  | "mixer"
  | "scam"
  | "darknet"
  | "gambling"
  | "bridge"
  | "dex"
  | "protocol"
  | "sanctioned";

export interface Label {
  address: string;
  chainFamily: "evm" | "tron" | "solana" | "bitcoin";
  category: LabelCategory;
  name: string;
  /** ISO 3166-1 alpha-2 of the operator's licence, when known */
  jurisdiction?: string;
  licence?: string;
  source: string;
}

/**
 * Local label store: data/labels/*.json (arrays of Label).
 * Phase 1 ships a small seed; the ImMike database and phishing lists are
 * imported into the same shape by scripts in Phase 1b.
 */
export class LabelStore {
  private byKey = new Map<string, Label>();
  constructor(dir = path.resolve(process.cwd(), "data/labels")) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const arr = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Label[];
      for (const l of arr) this.byKey.set(`${l.chainFamily}:${normalizeAddress(l.address, l.chainFamily)}`, l);
    }
  }
  get size() {
    return this.byKey.size;
  }
  lookup(address: string, chain: ChainId): Label | undefined {
    const fam = getChain(chain).family;
    return this.byKey.get(`${fam}:${normalizeAddress(address, fam)}`);
  }
}
