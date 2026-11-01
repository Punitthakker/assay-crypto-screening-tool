import { encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from "viem";
import { getChain, type ChainId } from "@cr/shared";
import type { Transport } from "../transport.js";
import { now, unavailable, type AdapterResult } from "../types.js";

const SOURCE = "chainalysis-oracle";
const ABI = parseAbi(["function isSanctioned(address) view returns (bool)"]);

/** Chainalysis public sanctions oracle. Free, no account. Second independent sanctions source on EVM chains. */
export class SanctionsOracleAdapter {
  constructor(private transport: Transport) {}

  async screen(address: string, chain: ChainId): Promise<AdapterResult> {
    const def = getChain(chain);
    const checkedAt = now();
    if (def.family !== "evm" || !def.sanctionsOracle) {
      return { facts: { sanctioned: null }, evidence: [], coverage: { source: SOURCE, status: "not_applicable", detail: `no oracle on ${chain}` } };
    }
    try {
      const data = encodeFunctionData({ abi: ABI, functionName: "isSanctioned", args: [address as Hex] });
      const raw = await this.transport.evmCall(chain, def.sanctionsOracle, data);
      const hit = decodeFunctionResult({ abi: ABI, functionName: "isSanctioned", data: raw }) as boolean;
      return {
        facts: { sanctioned: hit },
        coverage: { source: SOURCE, status: "ok", detail: def.sanctionsOracle },
        evidence: hit
          ? [
              {
                code: "HB_SANCTIONED_ORACLE",
                source: SOURCE,
                severity: "block",
                points: 100,
                hop: 0,
                summary: "Chainalysis sanctions oracle reports this address as sanctioned",
                ref: `isSanctioned(${address}) on ${def.sanctionsOracle} (${chain})`,
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
