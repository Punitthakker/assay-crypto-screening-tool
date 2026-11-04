# Scoring model v1 (scoring_version 1.0.0) - proposal for review

Risk score 0 to 100, higher is worse. Bands: CLEAR 0-19, LOW 20-39, CAUTION 40-59, HIGH 60-79, BLOCK 80-100. Deterministic: same inputs and same list snapshots give the same score.

## Stage 1 - hard blocks (score 100, verdict BLOCK, evaluation stops)

| Code | Condition |
|---|---|
| `HB_FROZEN` | Issuer freeze read returns true for the screened asset on the screened chain |
| `HB_SANCTIONED_LIST` | Sender address is on the OFAC digital-currency list for any ticker that maps to this chain family |
| `HB_SANCTIONED_ORACLE` | Chainalysis oracle `isSanctioned` returns true |
| `HB_FAKE_TOKEN` | The token contract being received is not in the registry but uses a USDT/USDC-like symbol |

If the two sanctions sources disagree the hit still blocks, and the report carries `discrepancy: true` with both results.

## Stage 2 - weighted signals (only when no hard block)

Each signal produces points; points are summed and capped at 95 so a non-hard-block case never reaches 100 by arithmetic.

### 2a. Exposure (value-weighted, hop-decayed)

For every inbound transfer within the trace window (default: last 90 days or last 200 transfers of the screened token, whichever is smaller), the share of total inbound value that came from a labelled category, multiplied by hop decay (hop 1 = 1.0, hop 2 = 0.5, hop 3 = 0.25). Share is then mapped to points by category:

| Category | Points at 100 percent share | Cap |
|---|---|---|
| sanctioned (indirect) | 80 | 80 |
| currently frozen counterparty | 60 | 60 |
| mixer / privacy pool | 55 | 55 |
| scam / phishing / drainer | 50 | 50 |
| darknet market | 50 | 50 |
| previously frozen counterparty (now released) | 20 | 20 |
| gambling | 15 | 15 |
| unlicensed or FATF-grey-list VASP | 20 | 20 |
| bridge-in from unknown origin chain | 10 | 10 |
| fresh wallet (< 7 days, < 5 tx) as counterparty | 8 | 15 |

Points scale linearly with share, with a floor: any non-zero exposure to `sanctioned`, `mixer` or `frozen` contributes at least 8 points even at dust share (dust rule). Exposure total is capped at 85.

Trace boundaries: a counterparty labelled as a licensed exchange hot wallet or deposit address terminates that branch and contributes 0 (KYC boundary, stated in the report). Fan-out cap 25 per hop by value; remainder bucketed as `untraced` and reduces confidence, not score.

Implemented 2026-11-03 (`packages/engine/src/trace.ts`), as specified above with these details:

- Share of a hop-2 node = (its share of the hop-1 wallet's inbound) x (that wallet's share of the sender's inbound), then x 0.5. Shares per category are summed across nodes and capped at 1 before mapping to points.
- A labelled, frozen or sanctioned counterparty contributes and is not expanded further; only unlabelled wallets are expanded. Loops back to the sender or to another hop-1 wallet are `internal` and counted once.
- Counterparty classification order: OFAC list or `sanctioned` label, then issuer freeze read, then label category. The sanctions oracle is not called per counterparty.
- Dust floor: a counterparty whose transfers total under 1 token unit (`CR_TRACE_DUST`) is dropped before fan-out, so dusting from a tainted address creates no exposure. The 8-point dust rule applies to every counterparty that is kept.
- Freeze reads are capped at 50 per trace (`CR_TRACE_FREEZE_CAP`), largest counterparties first; beyond the cap `frozen` is null and the node is classified by label and list only.
- `previously frozen` and `fresh wallet` categories are defined but cannot fire until the freeze event index and the behavioural signals land.
- Evidence: one `EXPOSURE_<CATEGORY>` line per category, `hop` = the nearest hop that contributed, `ref` = the largest contributor's tx hash, summary names up to three contributors. Plus one `FLOW_TRACE` info line with the counts.

### 2b. Behavioural (sender itself)

| Signal | Points | Note |
|---|---|---|
| Sender wallet age < 7 days | 10 | |
| Sender tx count < 5 | 6 | |
| Dormant > 180 days then active in last 7 days | 8 | |
| Median pass-through < 10 minutes over last 20 transfers | 15 | mule pattern |
| Structuring: >= 5 transfers in 30 days each within 5 percent below a threshold (USD 1,000, USD 3,000, AED 3,500 equiv, USD 10,000) | 12 | |
| > 70 percent of inbound value from a single unlabelled counterparty | 6 | |
| Sender is an unverified contract with upgrade admin | 10 | |
| Approval granted to a known drainer contract | 12 | compromise signal |

Behavioural cap: 35.

Implemented 2026-11-04 (`packages/engine/src/behaviour.ts`, inputs from `packages/datasources/src/adapters/activity.ts` and the explorer adapters' outbound side), as specified above with these details:

- Inputs: the sender's inbound transfers (already fetched), its outbound transfers of the same token over the same window, and account activity (first and latest transaction, transaction count, latest 25 timestamps, contract status, approvals). Every input is best effort; a signal whose input is missing is listed as "not evaluated" in the `behaviour` coverage line, never scored 0 silently.
- Wallet age counts from the first transaction (Etherscan `txlist` asc, TronGrid `create_time`, Helius when the whole history fits one page). Transaction count is the EVM nonce (outbound transactions) or the explorer's total where it counts them; the evidence line says which.
- Dormancy needs the two latest transactions: quiet for 180 days or more, then active in the last 7. On Tron only first and latest operation times are known, so it fires only for a wallet with at most 2 transactions whose creation and latest activity are 180 days apart.
- Pass-through pairs each of the latest 20 outbound transfers with the nearest earlier inbound; the median hold must be under 10 minutes over at least 5 pairs.
- Structuring counts inbound and outbound transfers in the last 30 days whose value sits in the 5 percent band below USD 1,000, 3,000, the Travel Rule threshold (USD 953 default) or 10,000; the busiest threshold is reported. Stablecoin units are taken as USD.
- Concentration needs at least two counterparties; a labelled dominant counterparty is the label's business, not this signal's.
- Contract-with-admin fires only when the explorer says the source is unverified and the contract is a proxy or answers `owner()` with a non-zero address. Unknown verification (no Etherscan key, no Blockscout host) is "not evaluated", not a penalty.
- Drainer approvals: ERC-20 `Approval` logs on the screened token with the sender as owner (Etherscan `getLogs`, key required) and SPL token-account delegates on Solana, matched against `scam` and `darknet` labels. Tron is not evaluated yet.
- Suppressed for a sender labelled `exchange_licensed` (coverage `not_applicable`), skipped for a hard-blocked sender, off with `CR_BEHAVIOUR=0`.

### 2c. Asset authenticity

| Signal | Points |
|---|---|
| Token is `bridged` (USDC.e, USDbC, Binance-Peg): issuer freeze not applicable, custody risk | 8 |
| Token is `native-oft` (USDT0) and freeze read not yet confirmed | 5 (plus confidence downgrade) |
| Token contract age < 90 days | 15 |
| Chain mismatch between requested chain and address format | hard error, no score |

### 2d. Identity gap (exchange mode only, when `amount` is provided)

| Condition | Effect |
|---|---|
| Amount >= jurisdiction threshold (UAE AED 3,500 default) and no `originator` provided | verdict floor CAUTION, +0 points, report flag `TRAVEL_RULE_DATA_REQUIRED` |
| `originator` provided, Watchman name hit (sanctions) | hard block `HB_ORIGINATOR_SANCTIONED` |
| `originator` provided, PEP hit (paid feed) | +15 |
| Corporate originator, no LEI or opaque ownership chain | +10 |

### Final

`score = min(95, exposure + behavioural + asset + identity)` then band mapping, then verdict floors applied.

## Confidence

Implemented 2026-11-03: the `fund-flow` coverage line is `ok` for a full trace, `partial` when `untraced` exceeds 20 percent, a hop-2 fetch failed, the explorer capped hop 1, or the trace stopped at depth 1 with unlabelled counterparties left; `unavailable` when no explorer answered; `not_applicable` when the sender is hard-blocked (trace skipped, confidence unaffected); `disabled` at depth 0 or with the explorer off. `partial`, `unavailable` and `disabled` each cap confidence at `medium`.

| Level | Condition |
|---|---|
| high | freeze read + both sanctions sources + explorer data all returned; trace reached requested depth; lists < 36h old |
| medium | one of: a sanctions source missing, trace depth 1 only, lists 36-72h old, `untraced` share > 20 percent |
| low | freeze read unavailable, or explorer data unavailable (behavioural and exposure skipped), or lists > 72h old |

The `behaviour` coverage line (2026-11-04) is `ok` when every signal had its input, `partial` when one or more could not be evaluated (stated by name), `unavailable` when neither activity nor outbound transfers came back, `not_applicable` for a licensed VASP or hard-blocked sender, `disabled` when switched off. Only `unavailable` caps confidence at `medium`; `partial` is stated, not penalised, so keyless deployments can still reach `high`.

A `low` confidence result is never shown as CLEAR in the bot; it is shown as "CLEAR on available data, coverage partial".

## Worked examples (fixtures in `data/fixtures/`)

1. **Fresh benign EOA, USDC on Base.** Not frozen, not sanctioned. 3 tx, 2 days old. Behavioural: age 10 + tx count 6 = 16. Exposure 0. Score 16 -> CLEAR, confidence high. Control test: must be < 20. Tested end to end on `data/fixtures/behaviour.json` (16, CLEAR, high, behaviour `ok`).
2. **Licensed exchange hot wallet, USDT on Ethereum.** Labelled Binance hot wallet. Trace terminates at boundary. Behavioural signals suppressed for labelled VASP wallets. Score 0 -> CLEAR. Control test: < 20, zero sanctions entries. Suppression tested in `behaviour.test.ts`.
3. **OTC desk wallet with 12 percent of inbound value from a Tornado Cash pool at hop 2, USDT on Ethereum.** Mixer share 0.12 x decay 0.5 = 0.06 -> 55 x 0.06 = 3.3, floored to 8 (dust rule). Pass-through median 6 min: +15. Score 23 -> LOW. Report explains the mixer hop with tx hashes. Exposure part tested in `trace.test.ts` and end to end on `data/fixtures/trace.json` (8 points, hop 2, tx hash in `ref`); the pass-through part is tested on a Tron mule in `data/fixtures/behaviour.json` (median 3 min over 6 pairs, +15, with structuring +12 and concentration +6 -> 33, LOW).
4. **Wallet whose single largest inbound (65 percent) came directly from a currently frozen USDT address, Tron.** Frozen share 0.65 x 1.0 x 60 = 39. Fresh wallet 10 + tx count 6 = 16. Score 55 -> CAUTION. Not a hard block because the sender itself is not frozen; the report says "funds originate from a Tether-frozen address". Exposure part tested (39 points, hop 1); the behavioural 16 is the same pair as example 1 (`BEHAV_FRESH_WALLET` + `BEHAV_LOW_TX_COUNT`).
5. **Sender on OFAC list (Tornado Cash router), USDT on Ethereum.** Stage 1 `HB_SANCTIONED_LIST` -> 100 BLOCK, oracle agrees, discrepancy false.
6. **Sender currently frozen by Tether on Tron, same address screened for USDC on Base.** Tron USDT: `HB_FROZEN` -> BLOCK. Base USDC: not frozen on Base, not sanctioned; exposure and behavioural computed from Base activity only; report carries a cross-chain note "this address is frozen by Tether on Tron" as +20 informational exposure (treated like `previously frozen` category) -> likely LOW/CAUTION. Demonstrates chain-awareness.
7. **Exchange mode, USDT 25,000 on Tron, clean on-chain, no originator.** On-chain score 4 -> CLEAR, but identity floor applies -> CAUTION with `TRAVEL_RULE_DATA_REQUIRED`.

## Things I want Punit to decide

- Are the exposure weights right for your exchange audience? Mixers at 55 vs scam at 50 is deliberate (sanctions-adjacent), tell me if you want scam higher for the retail bot.
- Dust floor of 8 points: this means a wallet that once received USD 2 from a mixer sits in CLEAR with a visible warning line rather than LOW. Keep or raise to 20 (pushes to LOW)?
- Identity floor at CAUTION for missing Travel Rule data: strict reading of VARA. Some exchanges will want it configurable per jurisdiction. I have made the threshold and the floor configurable; default is on.
