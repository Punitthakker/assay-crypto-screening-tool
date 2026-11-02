# Open questions for Punit

Answer inline or in DECISIONS.md. Items stay here until decided.

## 2026-11-02
1. Keys. Please create a free Etherscan V2 key and a free Helius key and put them in `.env` on your machine and in Railway. Without Etherscan, BNB Chain has no explorer at all and the other EVM chains run on Blockscout's soft limits. Without Helius, Solana fund-flow is unavailable and Solana reports stay at `medium` confidence forever.
2. Helius `type=TRANSFER` excludes token movements that happen inside swaps and program calls. For a receiving-side screen that is usually right (we care about who sent, not what they swapped), but an attacker routing stolen USDC through a swap would arrive untyped. Keep the filter (cheaper, cleaner) or drop it and classify in code?
3. Probe addresses in `verify:explorers` are a Tether treasury and a Binance hot wallet. Fine for a smoke test, but tell me if you would rather use your own addresses so the verified file never names a third party.
