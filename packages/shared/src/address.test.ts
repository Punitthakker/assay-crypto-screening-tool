import { describe, expect, it } from "vitest";
import { detectFamily, tronToHex, isTronAddress, isSolanaAddress } from "./address.js";

describe("address detection", () => {
  it("detects families", () => {
    expect(detectFamily("0xdAC17F958D2ee523a2206206994597C13D831ec7")).toBe("evm");
    expect(detectFamily("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe("tron");
    expect(detectFamily("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe("solana");
    expect(detectFamily("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe("bitcoin");
    expect(detectFamily("hello")).toBeUndefined();
  });
  it("decodes Tron base58check to 41-prefixed hex and rejects bad checksums", () => {
    expect(tronToHex("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe("41a614f803b6fd780986a42c78ec9c7f77e6ded13c");
    expect(isTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBe(false);
  });
  it("does not mistake a Tron address for Solana", () => {
    expect(isSolanaAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(false);
  });
});

describe("tron hex round trip", () => {
  it("encodes 41-hex, 0x-hex and bare hex back to the same base58check address", async () => {
    const { tronHexToBase58 } = await import("./address.js");
    const addr = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const hex41 = tronToHex(addr);
    expect(tronHexToBase58(hex41)).toBe(addr);
    expect(tronHexToBase58("0x" + hex41.slice(2))).toBe(addr);
    expect(tronHexToBase58(hex41.slice(2))).toBe(addr);
    expect(() => tronHexToBase58("0x1234")).toThrow();
  });
});
