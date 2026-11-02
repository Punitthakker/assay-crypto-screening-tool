import { createHash } from "node:crypto";
import type { ChainFamily } from "./chains.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 char "${ch}"`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // leading zeros
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function sha256(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(b).digest());
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Tron base58check (T...) -> 21-byte hex starting with 41. Throws on bad checksum. */
export function tronToHex(addr: string): string {
  const raw = base58Decode(addr);
  if (raw.length !== 25) throw new Error("tron address: bad length");
  const payload = raw.slice(0, 21);
  const check = raw.slice(21);
  const h = sha256(sha256(payload)).slice(0, 4);
  if (toHex(h) !== toHex(check)) throw new Error("tron address: bad checksum");
  if (payload[0] !== 0x41) throw new Error("tron address: bad prefix");
  return toHex(payload);
}

/** Tron hex (41-prefixed, or 0x / bare 20-byte EVM form) -> base58check T... address. */
export function tronHexToBase58(hex: string): string {
  let h = hex.toLowerCase().replace(/^0x/, "");
  if (h.length === 40) h = "41" + h;
  if (h.length !== 42 || !/^41[0-9a-f]{40}$/.test(h)) throw new Error(`tron hex address: bad form "${hex}"`);
  const payload = Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
  const check = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(check, 21);
  return base58Encode(full);
}

/** Tron 41-prefixed hex -> EVM-style 0x address (last 20 bytes) for ABI encoding. */
export function tronHexToEvm(hex41: string): `0x${string}` {
  return `0x${hex41.slice(2)}` as `0x${string}`;
}

export function isEvmAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function isTronAddress(s: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) return false;
  try {
    tronToHex(s);
    return true;
  } catch {
    return false;
  }
}

export function isSolanaAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

export function isBitcoinAddress(s: string): boolean {
  return /^(bc1[02-9ac-hj-np-z]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(s);
}

export function detectFamily(address: string): ChainFamily | undefined {
  if (isEvmAddress(address)) return "evm";
  if (isTronAddress(address)) return "tron";
  if (isBitcoinAddress(address)) return "bitcoin";
  if (isSolanaAddress(address)) return "solana";
  return undefined;
}

export function normalizeAddress(address: string, family: ChainFamily): string {
  return family === "evm" ? address.toLowerCase() : address;
}
