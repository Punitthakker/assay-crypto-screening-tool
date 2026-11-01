/** Boot-time live self-test. Logs raw bytes so a remote reader can diagnose without RPC access. */
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import type { Transport } from "@cr/datasources";
import { OfacAdapter, SanctionsOracleAdapter } from "@cr/datasources";

const ABI = parseAbi([
  "function isBlackListed(address) view returns (bool)",
  "function isBlacklisted(address) view returns (bool)",
  "function symbol() view returns (string)",
  "function getBlackListStatus(address) view returns (bool)",
]);
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Hex;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const BINANCE14 = "0x28C6c06298d514Db089934071355E5743bf21d60" as Hex;
const ONE = "0x0000000000000000000000000000000000000001" as Hex;

export async function selfTest(transport: Transport) {
  const log = (k: string, v: unknown) => console.log(`[selftest] ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (transport.mode !== "live") { log("skipped", "transport is not live"); return; }
  const calls: [string, Hex, Hex][] = [
    ["usdt.symbol", USDT, encodeFunctionData({ abi: ABI, functionName: "symbol" })],
    ["usdt.isBlackListed(binance14)", USDT, encodeFunctionData({ abi: ABI, functionName: "isBlackListed", args: [BINANCE14] })],
    ["usdt.isBlackListed(0x1)", USDT, encodeFunctionData({ abi: ABI, functionName: "isBlackListed", args: [ONE] })],
    ["usdt.getBlackListStatus(binance14)", USDT, encodeFunctionData({ abi: ABI, functionName: "getBlackListStatus", args: [BINANCE14] })],
    ["usdc.isBlacklisted(binance14)", USDC, encodeFunctionData({ abi: ABI, functionName: "isBlacklisted", args: [BINANCE14] })],
    ["usdc.isBlacklisted(0x1)", USDC, encodeFunctionData({ abi: ABI, functionName: "isBlacklisted", args: [ONE] })],
  ];
  for (const [name, to, data] of calls) {
    try { log(name, { data, raw: await transport.evmCall("ethereum", to, data) }); }
    catch (e) { log(name, { data, error: e instanceof Error ? e.message : String(e) }); }
  }
  try {
    const ofac = await new OfacAdapter(transport).load();
    log("ofac.counts", Object.fromEntries(Object.entries(ofac.lists).map(([k, v]) => [k, v.length])));
    const pos = ofac.lists.ETH?.[0];
    if (pos) {
      const o = new SanctionsOracleAdapter(transport);
      log("oracle.positive", { addr: pos, r: (await o.screen(pos, "ethereum")).facts });
      log("oracle.negative", { addr: ONE, r: (await o.screen(ONE, "ethereum")).facts });
    }
  } catch (e) { log("ofac/oracle", { error: e instanceof Error ? e.message : String(e) }); }
  // per-RPC probe: which endpoint answers what
  const { CHAINS } = await import("@cr/shared");
  const probe = encodeFunctionData({ abi: ABI, functionName: "isBlackListed", args: [ONE] });
  const probe2 = encodeFunctionData({ abi: ABI, functionName: "isBlackListed", args: [BINANCE14] });
  for (const url of CHAINS.ethereum.rpcs) {
    for (const [n, d] of [["0x1", probe], ["binance14", probe2]] as const) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDT, data: d }, "latest"] }) });
        const j = (await r.json()) as { result?: string; error?: unknown };
        log(`rpc ${url} isBlackListed(${n})`, j.result ?? j.error);
      } catch (e) { log(`rpc ${url}`, { error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  log("done", "ok");
}
