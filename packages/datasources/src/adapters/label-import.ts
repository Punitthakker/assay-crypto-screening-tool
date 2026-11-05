import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isEvmAddress, normalizeAddress } from "@cr/shared";
import type { Transport } from "../transport.js";
import type { Label, LabelCategory } from "./labels.js";

/**
 * Label import: public address-label datasets pulled over raw.githubusercontent.com,
 * parsed into the local Label shape, and written to data/labels/imported-<source>.json
 * by `pnpm import:labels`. Fetches go through Transport so the importer runs from
 * fixtures too. Parsers are pure (text in, labels out) and tested on hand-encoded rows.
 *
 * Licences are recorded in docs/LICENCES.md. A source whose licence is not
 * commercially clean (GPL, non-commercial) has `defaultEnabled: false` and is never
 * written into data/labels; see `optionalDir`.
 */

export const VaspStatusSchema = z.enum(["licensed", "unlicensed", "unknown"]);
export const VaspSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  jurisdiction: z.string().length(2).or(z.literal("")),
  licence: z.string(),
  status: VaspStatusSchema,
  source: z.string(),
});
export const VaspFileSchema = z.object({
  $comment: z.string().optional(),
  checkedAt: z.string(),
  vasps: z.array(VaspSchema),
});
export type Vasp = z.infer<typeof VaspSchema>;

export function loadVasps(file = path.resolve(process.cwd(), "data/vasps.json")): Vasp[] {
  return VaspFileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).vasps;
}

/** "Binance 14" -> "binance"; "Poloniex: USDC" -> "poloniex"; "Huobi 3 (hot)" -> "huobi" */
export function entityKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[:_].*$/, " ")
    .replace(/\s+\d+\s*$/, "")
    .replace(/\s+(hot|cold)?\s*wallet\s*$/, "")
    .trim();
}

/** Longest alias that the entity key starts with wins. A name ending in "?" is never matched. */
export function matchVasp(name: string, vasps: Vasp[]): Vasp | undefined {
  if (name.trim().endsWith("?")) return undefined;
  const key = entityKey(name);
  let best: { v: Vasp; len: number } | undefined;
  for (const v of vasps) {
    for (const a of v.aliases) {
      const al = a.toLowerCase();
      if ((key === al || key.startsWith(`${al} `) || key.startsWith(`${al}.`)) && (!best || al.length > best.len)) best = { v, len: al.length };
    }
  }
  return best?.v;
}

/** Minimal RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. No header handling. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows.map((r) => r.map((f) => f.trim()));
}

export interface ParseStats {
  rows: number;
  kept: number;
  skipped: { reason: string; count: number }[];
}
export interface ParseOutput {
  labels: Label[];
  stats: ParseStats;
}

function finish(labels: Label[], rows: number, skipped: Map<string, number>): ParseOutput {
  return { labels, stats: { rows, kept: labels.length, skipped: [...skipped].map(([reason, count]) => ({ reason, count })) } };
}
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** forta-network phishing_scams.csv: address,etherscan_tag,etherscan_labels,is_contract */
export function parseFortaPhishingCsv(text: string, source: string): ParseOutput {
  const rows = parseCsv(text);
  const out: Label[] = [];
  const skipped = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    const [address = "", tag = "", labels = ""] = r;
    if (address.toLowerCase() === "address") continue;
    n++;
    if (!isEvmAddress(address)) {
      bump(skipped, "not an EVM address");
      continue;
    }
    if (!/phish|hack|scam|exploit|heist|drain/i.test(labels)) {
      bump(skipped, `label not a scam class (${labels || "empty"})`);
      continue;
    }
    out.push({ address: address.toLowerCase(), chainFamily: "evm", category: "scam", name: tag || "Phishing (Etherscan tag)", source });
  }
  return finish(out, n, skipped);
}

/** forta-network malicious_smart_contracts.csv: contract_address,contract_tag,...,contract_creator_etherscan_label */
export function parseFortaMaliciousCsv(text: string, source: string): ParseOutput {
  const rows = parseCsv(text);
  const out: Label[] = [];
  const skipped = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    const [address = "", tag = "", creator = "", , creatorTag = "", , , cls = ""] = r;
    if (address.toLowerCase() === "contract_address") continue;
    n++;
    if (!isEvmAddress(address)) {
      bump(skipped, "not an EVM address");
      continue;
    }
    const name = tag || creatorTag || (cls ? `Malicious contract (${cls})` : "Malicious contract");
    out.push({ address: address.toLowerCase(), chainFamily: "evm", category: "scam", name, source });
    // the deployer of an exploit contract is tainted too, when the dataset names it
    if (isEvmAddress(creator) && creatorTag) {
      out.push({ address: creator.toLowerCase(), chainFamily: "evm", category: "scam", name: creatorTag, source: `${source} (contract creator)` });
    }
  }
  return finish(out, n, skipped);
}

/**
 * Exchange wallet CSVs. Two shapes:
 *   blockchain-unit exchange.csv: address,name,balance,txcount (no header)
 *   etherclust exchanges.csv:     address,name,accountType,type (header)
 * Only addresses whose entity is in data/vasps.json with a decided status are kept.
 */
export function parseExchangeCsv(text: string, source: string, vasps: Vasp[]): ParseOutput {
  const rows = parseCsv(text);
  const out: Label[] = [];
  const skipped = new Map<string, number>();
  let n = 0;
  // etherclust carries a header with a "type" column; blockchain-unit has no header and column 4 is a tx count
  const header = rows[0]?.[0]?.toLowerCase() === "address" ? rows[0]!.map((h) => h.toLowerCase()) : undefined;
  const typeCol = header ? header.indexOf("type") : -1;
  for (const r of rows) {
    const [address = "", name = ""] = r;
    if (address.toLowerCase() === "address") continue;
    n++;
    if (!isEvmAddress(address)) {
      bump(skipped, "not an EVM address");
      continue;
    }
    const type = typeCol >= 0 ? (r[typeCol] ?? "") : "";
    if (type && !/exchange|fiat gateway/i.test(type)) {
      bump(skipped, `type ${type.toLowerCase()} is not an exchange`);
      continue;
    }
    const v = matchVasp(name, vasps);
    if (!v) {
      bump(skipped, "entity not in data/vasps.json");
      continue;
    }
    if (v.status === "unknown") {
      bump(skipped, `licence status unknown (${v.id})`);
      continue;
    }
    const category: LabelCategory = v.status === "licensed" ? "exchange_licensed" : "exchange_unlicensed";
    const label: Label = { address: address.toLowerCase(), chainFamily: "evm", category, name: `${v.name} (${name})`, source };
    if (v.jurisdiction) label.jurisdiction = v.jurisdiction;
    if (v.licence) label.licence = v.licence;
    out.push(label);
  }
  return finish(out, n, skipped);
}

/** ScamSniffer blacklist/address.json: string[] of EVM addresses (frozen since 2024-02). */
export function parseScamSnifferAddresses(text: string, source: string): ParseOutput {
  const arr = z.array(z.string()).parse(JSON.parse(text));
  const out: Label[] = [];
  const skipped = new Map<string, number>();
  for (const a of arr) {
    if (!isEvmAddress(a)) {
      bump(skipped, "not an EVM address");
      continue;
    }
    out.push({ address: a.toLowerCase(), chainFamily: "evm", category: "scam", name: "ScamSniffer blacklist (drainer or phishing)", source });
  }
  return finish(out, arr.length, skipped);
}

/** Same address twice in one source: first row wins, later rows are counted. */
export function dedupe(labels: Label[]): { labels: Label[]; duplicates: number } {
  const seen = new Set<string>();
  const out: Label[] = [];
  let duplicates = 0;
  for (const l of labels) {
    const k = `${l.chainFamily}:${normalizeAddress(l.address, l.chainFamily)}`;
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    out.push(l);
  }
  return { labels: out, duplicates };
}

export interface LabelSource {
  id: string;
  title: string;
  url: string;
  licence: string;
  /** false: written only to the optional dir, never into data/labels */
  defaultEnabled: boolean;
  note?: string;
  parse: (text: string, source: string, vasps: Vasp[]) => ParseOutput;
}

const IMMIKE = "https://raw.githubusercontent.com/ImMike/crypto-wallet-address-labels/main/datasets";

export const LABEL_SOURCES: LabelSource[] = [
  {
    id: "immike-forta-phishing",
    title: "ImMike/crypto-wallet-address-labels: forta-network phishing_scams.csv",
    url: `${IMMIKE}/ethereum-phishing-and-scam-labels/phishing_scams.csv`,
    licence: "MIT (aggregator) / MIT (Forta Foundation 2022)",
    defaultEnabled: true,
    note: "Etherscan phish-hack tags as of 2022; ~6,700 EVM addresses",
    parse: (t, s) => parseFortaPhishingCsv(t, s),
  },
  {
    id: "immike-forta-malicious",
    title: "ImMike/crypto-wallet-address-labels: forta-network malicious_smart_contracts.csv",
    url: `${IMMIKE}/ethereum-phishing-and-scam-labels/malicious_smart_contracts.csv`,
    licence: "MIT (aggregator) / MIT (Forta Foundation 2022)",
    defaultEnabled: true,
    note: "exploit and heist contracts with their deployers; ~750 rows",
    parse: (t, s) => parseFortaMaliciousCsv(t, s),
  },
  {
    id: "immike-exchanges",
    title: "ImMike/crypto-wallet-address-labels: blockchain-unit exchange.csv",
    url: `${IMMIKE}/ethereum-exchange-and-dex-labels/exchange.csv`,
    licence: "MIT (aggregator); upstream blockchain-unit has no licence file, Etherscan public tags",
    defaultEnabled: true,
    note: "exchange hot wallets; kept only when the entity is in data/vasps.json with a decided status",
    parse: (t, s, v) => parseExchangeCsv(t, s, v),
  },
  {
    id: "immike-etherclust",
    title: "ImMike/crypto-wallet-address-labels: etherclust exchanges.csv",
    url: `${IMMIKE}/ethereum-cluster-exchange-labels/exchanges.csv`,
    licence: "MIT (aggregator); upstream etherclust has no licence file located",
    defaultEnabled: true,
    note: "exchange clusters; same vasps.json gate",
    parse: (t, s, v) => parseExchangeCsv(t, s, v),
  },
  {
    id: "scamsniffer",
    title: "scamsniffer/scam-database blacklist/address.json",
    url: "https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json",
    licence: "GPL-3.0",
    defaultEnabled: false,
    note: "copyleft; address list frozen by upstream since 2024-02; question 9 in docs/QUESTIONS.md",
    parse: (t, s) => parseScamSnifferAddresses(t, s),
  },
];

export interface ImportResult {
  id: string;
  url: string;
  licence: string;
  defaultEnabled: boolean;
  fetchedAt: string;
  labels: Label[];
  stats: ParseStats & { duplicates: number };
}

export async function importSource(transport: Transport, src: LabelSource, vasps: Vasp[]): Promise<ImportResult> {
  const text = await transport.fetchText(src.url);
  const parsed = src.parse(text, `import:${src.id}`, vasps);
  const { labels, duplicates } = dedupe(parsed.labels);
  return {
    id: src.id,
    url: src.url,
    licence: src.licence,
    defaultEnabled: src.defaultEnabled,
    fetchedAt: new Date().toISOString(),
    labels,
    stats: { ...parsed.stats, kept: labels.length, duplicates },
  };
}

/** File name LabelStore reads for a source; sorts before seed.json so hand-kept seed labels win. */
export const importedFileName = (id: string) => `imported-${id}.json`;
