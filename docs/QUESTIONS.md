# Open questions for Punit

Answer inline or in DECISIONS.md. Items stay here until decided.

## 2026-11-04
7. Contract senders without a key. `BEHAV_CONTRACT_ADMIN` fires only when the explorer confirms the source is unverified. On a keyless deployment (Blockscout 403 from Railway, no Etherscan key) every contract sender shows "not evaluated" instead. Fine for the pilot, or do you want an info line "sender is a contract, verification unknown" so the operator sees it on the report?
8. Structuring thresholds are USD 1,000, 3,000, the Travel Rule threshold (953) and 10,000, from the brief. For a UAE exchange audience, should AED 55,000 (the cash reporting line, about USD 15,000) join the list? One number, no scoring change.

## 2026-11-03
5. Trace cost. Default hop-2 expansion fetches inbound transfers for up to 25 unlabelled hop-1 wallets, so a busy sender costs up to 26 explorer calls and up to 50 freeze reads per screen (a few seconds keyed, rate-limited keyless). For the bot and the pilot /check page, do you want `CR_TRACE_EXPAND_CAP=10` on Railway (top 10 hop-1 wallets by value get expanded, the rest counts as untraced, confidence drops to medium only when that remainder passes 20 percent of value)? I have left the default at 25 to match the brief.
6. Exposure band. 100 percent of inbound value from an OFAC-listed counterparty at hop 1 scores 80 points, which lands in the BLOCK band by arithmetic even though the sender itself is not listed. SCORING.md allows it (cap 95 only). Keep, or cap indirect exposure at 79 so BLOCK is reserved for hard blocks?

## 2026-11-02
1. Keys. Please create a free Etherscan V2 key and a free Helius key and put them in `.env` on your machine and in Railway. Without Etherscan, BNB Chain has no explorer at all and the other EVM chains run on Blockscout's soft limits. Without Helius, Solana fund-flow is unavailable and Solana reports stay at `medium` confidence forever.
2. Helius `type=TRANSFER` excludes token movements that happen inside swaps and program calls. For a receiving-side screen that is usually right (we care about who sent, not what they swapped), but an attacker routing stolen USDC through a swap would arrive untyped. Keep the filter (cheaper, cleaner) or drop it and classify in code?
3. Probe addresses in `verify:explorers` are a Tether treasury and a Binance hot wallet. Fine for a smoke test, but tell me if you would rather use your own addresses so the verified file never names a third party.
4. ANSWERED 2026-11-02: `TRONGRID_API_KEY` set on Railway by Punit; address lookup 660ms, tx lookup with 7 sources 1.0s. Original question: Tron keys, blocking for the pilot. Live on Railway today: TronGrid answers 429 after three or four keyless `/v1/` calls in a row, and Tronscan's API answers 401 without a key. Address and tx lookups work on the first try, but the sender's source list fails as soon as two lookups run close together. Please create one of these (both free, a few minutes) and set it on the Railway assay-api service; the code already sends either header: `TRONGRID_API_KEY` (trongrid.io, preferred, 100K requests a day) or `TRONSCAN_API_KEY` (tronscan.org account page). I cannot create accounts on your behalf.
