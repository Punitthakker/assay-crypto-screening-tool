import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Transport } from "../transport.js";
import { LabelStore, type Label } from "./labels.js";
import {
  LABEL_SOURCES,
  VaspFileSchema,
  dedupe,
  entityKey,
  importSource,
  importedFileName,
  loadVasps,
  matchVasp,
  parseCsv,
  parseExchangeCsv,
  parseFortaMaliciousCsv,
  parseFortaPhishingCsv,
  parseScamSnifferAddresses,
  type Vasp,
} from "./label-import.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const SRC = "import:test";

const vasps: Vasp[] = [
  { id: "binance", name: "Binance", aliases: ["binance"], jurisdiction: "AE", licence: "VARA VASP licence", status: "licensed", source: "t" },
  { id: "yobit", name: "YoBit", aliases: ["yobit"], jurisdiction: "", licence: "", status: "unlicensed", source: "t" },
  { id: "huobi", name: "HTX (Huobi)", aliases: ["huobi", "htx"], jurisdiction: "SC", licence: "", status: "unknown", source: "t" },
  { id: "gate", name: "Gate.io", aliases: ["gate.io", "gate"], jurisdiction: "", licence: "", status: "licensed", source: "t" },
];

/** Transport stub: only fetchText answers, from a url -> text map. Everything else throws. */
function textTransport(pages: Record<string, string>): Transport {
  const nope = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    mode: "fixture",
    evmCall: nope,
    evmGetCode: nope,
    evmGetTransactionCount: nope,
    evmGetTransactionReceipt: nope,
    tronConstantCall: nope,
    solanaTokenAccounts: nope,
    fetchJson: nope,
    async fetchText(url: string) {
      const t = pages[url];
      if (t === undefined) throw new Error(`no page for ${url}`);
      return t;
    },
  };
}

describe("parseCsv", () => {
  it("handles quoted fields with commas, doubled quotes, CRLF and blank lines", () => {
    const rows = parseCsv('a,"b, c","say ""hi"""\r\n\r\n1,2,3\n');
    expect(rows).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });
});

describe("entityKey and matchVasp", () => {
  it("strips numbering, token suffixes and wallet words", () => {
    expect(entityKey("Binance 14")).toBe("binance");
    expect(entityKey("Poloniex: USDC")).toBe("poloniex");
    expect(entityKey("Huobi 3 (hot)")).toBe("huobi");
    expect(entityKey("Binance Hot Wallet")).toBe("binance");
    expect(entityKey("Gate.io 2")).toBe("gate.io");
  });
  it("matches the longest alias and refuses uncertain names", () => {
    expect(matchVasp("Binance 7", vasps)?.id).toBe("binance");
    expect(matchVasp("Gate.io 1", vasps)?.id).toBe("gate");
    expect(matchVasp("HTX 2", vasps)?.id).toBe("huobi");
    expect(matchVasp("Upbit?", vasps)).toBeUndefined();
    expect(matchVasp("Binancex", vasps)).toBeUndefined();
    expect(matchVasp("Coinbase 1", vasps)).toBeUndefined();
  });
});

describe("parseFortaPhishingCsv", () => {
  it("keeps phish-hack rows as scam, skips the header, bad addresses and non-scam classes", () => {
    const csv = [
      "address,etherscan_tag,etherscan_labels,is_contract",
      "0x000000000532B45F47779FCE440748893B257865,Fake_Phishing3901,phish-hack,False",
      "0x00000000072d54638c2c2a3da3f715360269eea1,,phish-hack,False",
      "not-an-address,Fake_Phishing1,phish-hack,False",
      "0x1111111111111111111111111111111111111111,Some Dex,dex,True",
    ].join("\n");
    const r = parseFortaPhishingCsv(csv, SRC);
    expect(r.stats.rows).toBe(4);
    expect(r.labels).toHaveLength(2);
    expect(r.labels[0]).toEqual({ address: "0x000000000532b45f47779fce440748893b257865", chainFamily: "evm", category: "scam", name: "Fake_Phishing3901", source: SRC });
    expect(r.labels[1]!.name).toBe("Phishing (Etherscan tag)");
    expect(r.stats.skipped).toEqual([
      { reason: "not an EVM address", count: 1 },
      { reason: "label not a scam class (dex)", count: 1 },
    ]);
  });
});

describe("parseFortaMaliciousCsv", () => {
  it("labels the contract and its named deployer", () => {
    const csv = [
      "contract_address,contract_tag,contract_creator,contract_creation_tx,contract_creator_tag,source,notes,contract_creator_etherscan_label",
      "0x04ae3226c80e8c04d35e6e56089345bdd06da6de,Multichain Exploiter 10,0x98f5b0a99f258a09403d965647ee9d53677914af,0xe9,,Luabase,,exploit",
      "0xc5ac25cfc2b8284e84ca47dad21cf1319f732c11,,0x07e02088d68229300ae503395c6536f09179dc3e,0xae,xToken Exploiter,Luabase,,heist",
      "0x79dbe9bbde91a35fa8148a14084979a531fe57ea,,0x1111,0x07,,Luabase,,heist",
    ].join("\n");
    const r = parseFortaMaliciousCsv(csv, SRC);
    expect(r.labels.map((l) => [l.address, l.name])).toEqual([
      ["0x04ae3226c80e8c04d35e6e56089345bdd06da6de", "Multichain Exploiter 10"],
      ["0xc5ac25cfc2b8284e84ca47dad21cf1319f732c11", "xToken Exploiter"],
      ["0x07e02088d68229300ae503395c6536f09179dc3e", "xToken Exploiter"],
      ["0x79dbe9bbde91a35fa8148a14084979a531fe57ea", "Malicious contract (heist)"],
    ]);
    expect(r.labels[2]!.source).toBe(`${SRC} (contract creator)`);
    expect(r.labels.every((l) => l.category === "scam")).toBe(true);
  });
});

describe("parseExchangeCsv", () => {
  it("gates on data/vasps.json status: licensed, unlicensed, unknown skipped, absent skipped", () => {
    const csv = [
      '0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be,Binance 1,"206,188.85 Ether","11,121,245"',
      "0x0d0707963952f2fba59dd06f2b425ace40b492fe,Gate.io 1,1 Ether,2",
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,Yobit.net,0,1",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,Huobi 3,0,1",
      "0xcccccccccccccccccccccccccccccccccccccccc,Bittrex 1,0,1",
    ].join("\n");
    const r = parseExchangeCsv(csv, SRC, vasps);
    expect(r.labels.map((l) => [l.name, l.category, l.jurisdiction, l.licence])).toEqual([
      ["Binance (Binance 1)", "exchange_licensed", "AE", "VARA VASP licence"],
      ["Gate.io (Gate.io 1)", "exchange_licensed", undefined, undefined],
      ["YoBit (Yobit.net)", "exchange_unlicensed", undefined, undefined],
    ]);
    expect(r.stats.skipped).toEqual([
      { reason: "licence status unknown (huobi)", count: 1 },
      { reason: "entity not in data/vasps.json", count: 1 },
    ]);
  });
  it("reads the etherclust shape with header and drops non-exchange rows", () => {
    const csv = ["address,name,accountType,type", "0x05f51aab068caa6ab7eeb672f88c180f67f17ec7,Binance 2,eoa,Exchange", "0x1111111111111111111111111111111111111111,Binance 3,eoa,Wallet"].join("\n");
    const r = parseExchangeCsv(csv, SRC, vasps);
    expect(r.labels).toHaveLength(1);
    expect(r.stats.skipped).toEqual([{ reason: "type wallet is not an exchange", count: 1 }]);
  });
});

describe("parseScamSnifferAddresses", () => {
  it("reads the string array and drops non-EVM entries", () => {
    const r = parseScamSnifferAddresses(JSON.stringify(["0x101CE0cedd142f199c9ef61739ae59b6611a0fc0", "bc1qxyz"]), SRC);
    expect(r.labels).toEqual([{ address: "0x101ce0cedd142f199c9ef61739ae59b6611a0fc0", chainFamily: "evm", category: "scam", name: "ScamSniffer blacklist (drainer or phishing)", source: SRC }]);
    expect(r.stats.skipped).toEqual([{ reason: "not an EVM address", count: 1 }]);
  });
});

describe("dedupe", () => {
  it("keeps the first row per normalised address", () => {
    const a: Label = { address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", chainFamily: "evm", category: "scam", name: "first", source: SRC };
    const b: Label = { ...a, address: a.address.toLowerCase(), name: "second" };
    const r = dedupe([a, b]);
    expect(r.duplicates).toBe(1);
    expect(r.labels.map((l) => l.name)).toEqual(["first"]);
  });
});

describe("LABEL_SOURCES and data/vasps.json", () => {
  it("only commercially clean sources are on by default; ScamSniffer (GPL) is opt-in", () => {
    for (const s of LABEL_SOURCES) {
      if (s.defaultEnabled) expect(s.licence.startsWith("MIT")).toBe(true);
    }
    expect(LABEL_SOURCES.find((s) => s.id === "scamsniffer")?.defaultEnabled).toBe(false);
    expect(new Set(LABEL_SOURCES.map((s) => s.id)).size).toBe(LABEL_SOURCES.length);
  });
  it("data/vasps.json validates and every licensed row names a jurisdiction and licence", () => {
    const v = loadVasps(path.join(root, "data/vasps.json"));
    expect(v.length).toBeGreaterThan(10);
    for (const x of v) {
      if (x.status === "licensed") {
        expect(x.jurisdiction, x.id).toHaveLength(2);
        expect(x.licence.length, x.id).toBeGreaterThan(0);
      }
    }
    expect(new Set(v.map((x) => x.id)).size).toBe(v.length);
    expect(() => VaspFileSchema.parse({ checkedAt: "x", vasps: [{ ...v[0], status: "maybe" }] })).toThrow();
  });
});

describe("importSource through Transport", () => {
  it("fetches, parses and dedupes from a fixture page", async () => {
    const src = LABEL_SOURCES.find((s) => s.id === "immike-forta-phishing")!;
    const page = ["address,etherscan_tag,etherscan_labels,is_contract", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,Fake_Phishing1,phish-hack,False", "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,Fake_Phishing2,phish-hack,False"].join("\n");
    const r = await importSource(textTransport({ [src.url]: page }), src, vasps);
    expect(r.labels).toHaveLength(1);
    expect(r.stats).toEqual({ rows: 2, kept: 1, skipped: [], duplicates: 1 });
    expect(r.labels[0]!.source).toBe("import:immike-forta-phishing");
  });
  it("surfaces a fetch failure instead of writing an empty list", async () => {
    const src = LABEL_SOURCES[0]!;
    await expect(importSource(textTransport({}), src, vasps)).rejects.toThrow(/no page/);
  });
});

describe("LabelStore load order", () => {
  it("seed.json overrides an imported label for the same address; optional dirs load only when asked", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "labels-"));
    const opt = path.join(dir, "optional");
    mkdirSync(opt);
    const addr = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const mk = (name: string, category: Label["category"]): Label[] => [{ address: addr, chainFamily: "evm", category, name, source: SRC }];
    writeFileSync(path.join(dir, importedFileName("x")), JSON.stringify(mk("imported", "scam")));
    writeFileSync(path.join(dir, "seed.json"), JSON.stringify(mk("seed", "exchange_licensed")));
    writeFileSync(path.join(opt, importedFileName("scamsniffer")), JSON.stringify([{ address: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", chainFamily: "evm", category: "scam", name: "opt", source: SRC }]));

    const plain = new LabelStore({ dir }, {});
    expect(plain.lookup(addr, "ethereum")?.name).toBe("seed");
    expect(plain.lookup("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "ethereum")).toBeUndefined();
    expect(plain.files.map((f) => path.basename(f.file))).toEqual(["imported-x.json", "seed.json"]);

    const withOpt = new LabelStore({ dir }, { CR_LABELS_EXTRA_DIR: opt });
    expect(withOpt.lookup("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "ethereum")?.name).toBe("opt");
    expect(withOpt.size).toBe(2);
  });
  it("the committed store loads mixers, bridges and imports without a collision on the Binance 14 seed entry", () => {
    const store = new LabelStore({ dir: path.join(root, "data/labels") }, {});
    expect(store.lookup("0x28C6c06298d514Db089934071355E5743bf21d60", "ethereum")?.source).toMatch(/^seed:/);
    expect(store.lookup("0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc", "ethereum")?.category).toBe("mixer");
    expect(store.lookup("0x3ee18B2214AFF97000D974cf647E7C347E8fa585", "base")?.category).toBe("bridge");
    expect(store.lookup("0x000000000532b45f47779fce440748893b257865", "ethereum")?.category).toBe("scam");
    expect(store.size).toBeGreaterThan(6000);
  });
});
