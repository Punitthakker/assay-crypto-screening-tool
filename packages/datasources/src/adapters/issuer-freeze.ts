import { encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from "viem";
import { tronToHex, tronHexToEvm, type TokenDef } from "@cr/shared";
import type { Transport } from "../transport.js";
import { now, unavailable, type AdapterResult } from "../types.js";

const SOURCE = "issuer-freeze";

const ABI = parseAbi([
  "function isBlackListed(address) view returns (bool)",
  "function isBlacklisted(address) view returns (bool)",
]);

/**
 * Reads the issuer's own freeze state for one address against one token on one chain.
 * This is the single most important check in the product: it is a hard block and it is free.
 */
export class IssuerFreezeAdapter {
  constructor(private transport: Transport) {}

  async screen(address: string, token: TokenDef): Promise<AdapterResult> {
    const checkedAt = now();
    const base = { source: SOURCE, token: `${token.onChainSymbol}@${token.chain}` };
    try {
      switch (token.freeze.kind) {
        case "none":
          return {
            facts: { frozen: null },
            evidence: [
              {
                code: "ASSET_BRIDGED",
                source: SOURCE,
                severity: "risk",
                points: 8,
                hop: 0,
                summary: `${token.onChainSymbol} on ${token.chain} is ${token.issuer}-pegged, not issuer-controlled. Issuer freeze does not apply; custody risk of the bridge operator applies.`,
                ref: token.address,
                checkedAt,
              },
            ],
            coverage: { ...base, status: "not_applicable", detail: token.note },
          };
        case "tbd":
          return {
            facts: { frozen: null },
            evidence: [
              {
                code: "ASSET_OFT_UNCONFIRMED",
                source: SOURCE,
                severity: "risk",
                points: 5,
                hop: 0,
                summary: `${token.onChainSymbol} on ${token.chain} is Tether's OFT deployment; blacklist read method not yet confirmed on-chain, freeze status unknown.`,
                ref: token.address,
                checkedAt,
              },
            ],
            coverage: { ...base, status: "partial", detail: "freeze view function unconfirmed (USDT0)" },
          };
        case "evm": {
          const data = encodeFunctionData({ abi: ABI, functionName: token.freeze.fn, args: [address as Hex] });
          const raw = await this.transport.evmCall(token.chain, token.address as Hex, data);
          const frozen = decodeFunctionResult({ abi: ABI, functionName: token.freeze.fn, data: raw }) as boolean;
          return this.result(frozen, token, `${token.freeze.fn}(${address}) on ${token.address}`, checkedAt);
        }
        case "tron": {
          const hex41 = tronToHex(address);
          const param = tronHexToEvm(hex41).slice(2).padStart(64, "0");
          const raw = await this.transport.tronConstantCall(token.address, "isBlackListed(address)", param);
          const frozen = BigInt(raw) === 1n;
          return this.result(frozen, token, `isBlackListed(${address}) on ${token.address}`, checkedAt);
        }
        case "spl": {
          const accounts = await this.transport.solanaTokenAccounts(address, token.address);
          const frozenAccounts = accounts.filter((a) => a.state === "frozen");
          const frozen = frozenAccounts.length > 0;
          const detail = accounts.length === 0 ? "owner holds no token account for this mint" : `${accounts.length} token account(s), ${frozenAccounts.length} frozen`;
          const r = this.result(frozen, token, `getTokenAccountsByOwner(${address}, ${token.address})`, checkedAt);
          r.coverage.detail = detail;
          return r;
        }
      }
    } catch (e) {
      return unavailable(SOURCE, e);
    }
  }

  private result(frozen: boolean, token: TokenDef, ref: string, checkedAt: string): AdapterResult {
    return {
      facts: { frozen },
      coverage: { source: SOURCE, status: "ok", detail: `${token.onChainSymbol}@${token.chain}` },
      evidence: frozen
        ? [
            {
              code: "HB_FROZEN",
              source: SOURCE,
              severity: "block",
              points: 100,
              hop: 0,
              summary: `Address is currently frozen by ${token.issuer} for ${token.onChainSymbol} on ${token.chain}. Any ${token.onChainSymbol} it sends or receives on this chain will fail.`,
              ref,
              checkedAt,
            },
          ]
        : [
            {
              code: "FREEZE_CLEAR",
              source: SOURCE,
              severity: "info",
              points: 0,
              hop: 0,
              summary: `Not frozen by ${token.issuer} for ${token.onChainSymbol} on ${token.chain} at time of check.`,
              ref,
              checkedAt,
            },
          ],
    };
  }
}
