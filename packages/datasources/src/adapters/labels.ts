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

export interface LabelStoreOptions {
  /** main directory, default data/labels */
  dir?: string;
  /** extra directories loaded after the main one (e.g. data/labels-optional for opt-in lists); env CR_LABELS_EXTRA_DIR, comma separated */
  extraDirs?: string[];
}

/**
 * Local label store: every *.json in data/labels (arrays of Label), loaded in
 * name order with seed.json last, so a hand-kept seed entry overrides an imported
 * one for the same address. Imported files are written by `pnpm import:labels`
 * (packages/datasources/src/adapters/label-import.ts); opt-in lists live outside
 * the main directory and are only loaded through `extraDirs`.
 */
export class LabelStore {
  private byKey = new Map<string, Label>();
  private perFile = new Map<string, number>();
  constructor(dirOrOpts: string | LabelStoreOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    const opts: LabelStoreOptions = typeof dirOrOpts === "string" ? { dir: dirOrOpts } : dirOrOpts;
    const dir = opts.dir ?? path.resolve(process.cwd(), "data/labels");
    const extras = opts.extraDirs ?? (env.CR_LABELS_EXTRA_DIR ? env.CR_LABELS_EXTRA_DIR.split(",").map((s) => s.trim()).filter(Boolean) : []);
    for (const d of [dir, ...extras.map((e) => path.resolve(process.cwd(), e))]) this.loadDir(d);
  }

  private loadDir(dir: string) {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((x) => x.endsWith(".json"))
      .sort((a, b) => (a === "seed.json" ? 1 : b === "seed.json" ? -1 : a.localeCompare(b)));
    for (const f of files) {
      const arr = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Label[];
      for (const l of arr) this.byKey.set(`${l.chainFamily}:${normalizeAddress(l.address, l.chainFamily)}`, l);
      this.perFile.set(path.join(dir, f), arr.length);
    }
  }

  get size() {
    return this.byKey.size;
  }
  /** label count per file, in load order */
  get files(): { file: string; count: number }[] {
    return [...this.perFile].map(([file, count]) => ({ file, count }));
  }
  lookup(address: string, chain: ChainId): Label | undefined {
    const fam = getChain(chain).family;
    return this.byKey.get(`${fam}:${normalizeAddress(address, fam)}`);
  }
}
