/**
 * Live verification of every registry entry. Run from a machine with internet access:
 *   pnpm verify:sources
 * Writes docs/SOURCES.verified.json. Also usable in record mode to refresh fixtures:
 *   CR_RECORD=1 pnpm verify:sources
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from "viem";
import { CHAINS, ENABLED_CHAINS, TOKENS, tronToHex, tronHexToEvm, type ChainId } from "@cr/shared";
import { IssuerFreezeAdapter, OfacAdapter, SanctionsOracleAdapter, transportFromEnv } from "@cr/datasources";

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);

const ERC20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
// candidate blacklist views for USDT0 (OFT); first that decodes wins
const OFT_CANDIDATES = ["isBlocked(address)", "blocked(address)", "isBlackListed(address)", "isBlacklisted(address)"];

const transport = transportFromEnv();
const out: Record<string, unknown> = { verifiedAt: new Date().toISOString(), mode: transport.mode, chains: {}, tokens: [], ofac: {}, oracle: {} };
const chains = out.chains as Record<string, unknown>;
const tokens = out.tokens as unknown[];
let failures = 0;

// Positive control for the oracle is taken from today's OFAC ETH list (Tornado Cash was delisted in Mar 2025, so never hard-code it).
const NEGATIVE_CONTROL_EVM = "0x0000000000000000000000000000000000000001" as Hex;

for (const id of ENABLED_CHAINS) {
  const c = CHAINS[id];
  if (c.family !== "evm") {
    chains[id] = { rpc: "n/a (non-evm)", note: c.family };
    continue;
  }
  try {
    const code = await transport.evmGetCode(id, (c.sanctionsOracle ?? NEGATIVE_CONTROL_EVM) as Hex);
    chains[id] = { rpcOk: true, oracleHasCode: code !== "0x" };
  } catch (e) {
    failures++;
    chains[id] = { rpcOk: false, error: String(e) };
  }
}

for (const t of TOKENS) {
  const c = CHAINS[t.chain];
  if (!c.enabled) continue;
  const row: Record<string, unknown> = { chain: t.chain, symbol: t.onChainSymbol, address: t.address, expectedDecimals: t.decimals, freeze: t.freeze.kind };
  try {
    if (c.family === "evm") {
      const sym = decodeFunctionResult({ abi: ERC20, functionName: "symbol", data: await transport.evmCall(t.chain, t.address as Hex, encodeFunctionData({ abi: ERC20, functionName: "symbol" })) });
      const dec = decodeFunctionResult({ abi: ERC20, functionName: "decimals", data: await transport.evmCall(t.chain, t.address as Hex, encodeFunctionData({ abi: ERC20, functionName: "decimals" })) });
      row.onChainSymbol = sym;
      row.onChainDecimals = Number(dec);
      row.symbolMatches = String(sym).toLowerCase().replace("₮", "t") === t.onChainSymbol.toLowerCase().replace("₮", "t");
      row.decimalsMatch = Number(dec) === t.decimals;
      if (t.freeze.kind === "tbd") {
        const found: string[] = [];
        for (const sig of OFT_CANDIDATES) {
          try {
            const fn = sig.split("(")[0]!;
            const abi = [{ type: "function", name: fn, stateMutability: "view", inputs: [{ type: "address", name: "a" }], outputs: [{ type: "bool", name: "" }] }] as const;
            const raw = await transport.evmCall(t.chain, t.address as Hex, encodeFunctionData({ abi, functionName: fn, args: [NEGATIVE_CONTROL_EVM] }));
            if (raw && raw !== "0x") found.push(sig);
          } catch {
            /* not this one */
          }
        }
        row.oftBlacklistViews = found;
        if (found.length === 0) row.action = "no candidate view responded; inspect verified ABI on explorer";
      }
      if (t.freeze.kind === "evm") {
        const r = await new IssuerFreezeAdapter(transport).screen(NEGATIVE_CONTROL_EVM, t);
        row.freezeReadOk = r.coverage.status === "ok";
      }
    } else if (c.family === "tron") {
      const hex = tronToHex(t.address);
      row.tronHex = hex;
      const neg = tronHexToEvm(tronToHex("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb")).slice(2).padStart(64, "0");
      const raw = await transport.tronConstantCall(t.address, "isBlackListed(address)", neg);
      row.freezeReadOk = typeof raw === "string";
    } else if (c.family === "solana") {
      const accts = await transport.solanaTokenAccounts("11111111111111111111111111111111", t.address);
      row.freezeReadOk = Array.isArray(accts);
    }
  } catch (e) {
    failures++;
    row.error = e instanceof Error ? e.message : String(e);
  }
  tokens.push(row);
}

let POSITIVE_CONTROL_EVM: Hex | undefined;
try {
  const ofac = new OfacAdapter(transport);
  const snap = await ofac.load(true);
  out.ofac = { fetchedAt: snap.fetchedAt, counts: Object.fromEntries(Object.entries(snap.lists).map(([k, v]) => [k, v.length])) };
  POSITIVE_CONTROL_EVM = snap.lists.ETH?.[0] as Hex | undefined;
} catch (e) {
  failures++;
  out.ofac = { error: String(e) };
}

try {
  const oracle = new SanctionsOracleAdapter(transport);
  if (!POSITIVE_CONTROL_EVM) throw new Error("no OFAC ETH entry available for positive control");
  const pos = await oracle.screen(POSITIVE_CONTROL_EVM, "ethereum" as ChainId);
  const neg = await oracle.screen(NEGATIVE_CONTROL_EVM, "ethereum" as ChainId);
  out.oracle = { positiveControl: POSITIVE_CONTROL_EVM, positiveControlSanctioned: pos.facts?.sanctioned, negativeControlSanctioned: neg.facts?.sanctioned, coverage: pos.coverage };
  if (pos.facts?.sanctioned !== true) failures++;
} catch (e) {
  failures++;
  out.oracle = { error: String(e) };
}

out.failures = failures;
writeFileSync("docs/SOURCES.verified.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(failures === 0 ? "\nAll sources verified." : `\n${failures} check(s) failed - see above.`);
process.exit(failures === 0 ? 0 : 1);
