/** Boot-time live self-test with stable controls. Logged, never fatal. */
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from "viem";
import { OfacAdapter, SanctionsOracleAdapter, LabelStore, type Transport } from "@cr/datasources";
import { Engine } from "@cr/engine";

const ABI = parseAbi(["function isBlackListed(address) view returns (bool)", "function symbol() view returns (string)"]);
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Hex;
/** Tether permanently blacklists the 0x1 sink address, so it is a stable positive control for the freeze read. */
const FREEZE_POSITIVE = "0x0000000000000000000000000000000000000001" as Hex;
const FREEZE_NEGATIVE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Hex; // vitalik.eth

export async function selfTest(transport: Transport) {
  const log = (k: string, v: unknown) => console.log(`[selftest] ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (transport.mode !== "live") { log("skipped", "transport is not live"); return; }
  const out: Record<string, unknown> = {};
  try {
    const sym = decodeFunctionResult({ abi: ABI, functionName: "symbol", data: await transport.evmCall("ethereum", USDT, encodeFunctionData({ abi: ABI, functionName: "symbol" })) });
    const pos = decodeFunctionResult({ abi: ABI, functionName: "isBlackListed", data: await transport.evmCall("ethereum", USDT, encodeFunctionData({ abi: ABI, functionName: "isBlackListed", args: [FREEZE_POSITIVE] })) });
    const neg = decodeFunctionResult({ abi: ABI, functionName: "isBlackListed", data: await transport.evmCall("ethereum", USDT, encodeFunctionData({ abi: ABI, functionName: "isBlackListed", args: [FREEZE_NEGATIVE] })) });
    out.freeze = { symbol: sym, positiveControl: pos, negativeControl: neg, ok: sym === "USDT" && pos === true && neg === false };
  } catch (e) { out.freeze = { error: e instanceof Error ? e.message : String(e) }; }
  try {
    const snap = await new OfacAdapter(transport).load();
    const first = snap.lists.ETH?.[0];
    const o = new SanctionsOracleAdapter(transport);
    const pos = first ? (await o.screen(first, "ethereum")).facts?.sanctioned : null;
    const neg = (await o.screen(FREEZE_NEGATIVE, "ethereum")).facts?.sanctioned;
    out.sanctions = { ofacEth: snap.lists.ETH?.length ?? 0, ofacTrx: snap.lists.TRX?.length ?? 0, oraclePositive: pos, oracleNegative: neg, ok: pos === true && neg === false };
  } catch (e) { out.sanctions = { error: e instanceof Error ? e.message : String(e) }; }
  log("result", out);
  // end-to-end engine runs on the non-EVM paths
  try {
    const engine = new Engine({ transport, labels: new LabelStore() });
    const snap = await new OfacAdapter(transport).load();
    const cases: { name: string; req: Record<string, unknown> }[] = [
      { name: "tron.usdtContractItself", req: { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", chain: "tron", asset: "USDT" } },
      { name: "tron.binanceHot", req: { address: "TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX", chain: "tron", asset: "USDT" } },
      ...(snap.lists.TRX?.[0] ? [{ name: "tron.ofacFirst", req: { address: snap.lists.TRX[0], chain: "tron", asset: "USDT" } }] : []),
      { name: "solana.binanceHot.usdc", req: { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", chain: "solana", asset: "USDC" } },
      { name: "solana.binanceHot.usdt", req: { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", chain: "solana", asset: "USDT" } },
      ...(snap.lists.SOL?.[0] ? [{ name: "solana.ofacFirst", req: { address: snap.lists.SOL[0], chain: "solana", asset: "USDC" } }] : []),
      { name: "base.vitalik.usdc", req: { address: FREEZE_NEGATIVE, chain: "base", asset: "USDC" } },
    ];
    for (const c of cases) {
      const t0 = Date.now();
      try {
        const r = await engine.screen(c.req);
        log(`e2e ${c.name}`, { verdict: r.verdict, score: r.score, hardBlock: r.hardBlock ?? null, ms: Date.now() - t0, coverage: r.coverage.map((x) => `${x.source}=${x.status}${x.detail ? ` (${x.detail})` : ""}`) });
      } catch (e) { log(`e2e ${c.name}`, { error: e instanceof Error ? e.message : String(e) }); }
    }
  } catch (e) { log("e2e", { error: e instanceof Error ? e.message : String(e) }); }
}
