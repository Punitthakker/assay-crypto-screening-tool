/** Boot-time live self-test with stable controls. Logged, never fatal. */
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from "viem";
import { OfacAdapter, SanctionsOracleAdapter, type Transport } from "@cr/datasources";

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
}
