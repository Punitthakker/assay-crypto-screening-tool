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

| Level | Condition |
|---|---|
| high | freeze read + both sanctions sources + explorer data all returned; trace reached requested depth; lists < 36h old |
| medium | one of: a sanctions source missing, trace depth 1 only, lists 36-72h old, `untraced` share > 20 percent |
| low | freeze read unavailable, or explorer data unavailable (behavioural and exposure skipped), or lists > 72h old |

A `low` confidence result is never shown as CLEAR in the bot; it is shown as "CLEAR on available data, coverage partial".

## Worked examples (fixtures in `data/fixtures/`)

1. **Fresh benign EOA, USDC on Base.** Not frozen, not sanctioned. 3 tx, 2 days old. Behavioural: age 10 + tx count 6 = 16. Exposure 0. Score 16 -> CLEAR, confidence high. Control test: must be < 20.
2. **Licensed exchange hot wallet, USDT on Ethereum.** Labelled Binance hot wallet. Trace terminates at boundary. Behavioural signals suppressed for labelled VASP wallets. Score 0 -> CLEAR. Control test: < 20, zero sanctions entries.
3. **OTC desk wallet with 12 percent of inbound value from a Tornado Cash pool at hop 2, USDT on Ethereum.** Mixer share 0.12 x decay 0.5 = 0.06 -> 55 x 0.06 = 3.3, floored to 8 (dust rule). Pass-through median 6 min: +15. Score 23 -> LOW. Report explains the mixer hop with tx hashes.
4. **Wallet whose single largest inbound (65 percent) came directly from a currently frozen USDT address, Tron.** Frozen share 0.65 x 1.0 x 60 = 39. Fresh wallet 10 + tx count 6 = 16. Score 55 -> CAUTION. Not a hard block because the sender itself is not frozen; the report says "funds originate from a Tether-frozen address".
5. **Sender on OFAC list (Tornado Cash router), USDT on Ethereum.** Stage 1 `HB_SANCTIONED_LIST` -> 100 BLOCK, oracle agrees, discrepancy false.
6. **Sender currently frozen by Tether on Tron, same address screened for USDC on Base.** Tron USDT: `HB_FROZEN` -> BLOCK. Base USDC: not frozen on Base, not sanctioned; exposure and behavioural computed from Base activity only; report carries a cross-chain note "this address is frozen by Tether on Tron" as +20 informational exposure (treated like `previously frozen` category) -> likely LOW/CAUTION. Demonstrates chain-awareness.
7. **Exchange mode, USDT 25,000 on Tron, clean on-chain, no originator.** On-chain score 4 -> CLEAR, but identity floor applies -> CAUTION with `TRAVEL_RULE_DATA_REQUIRED`.

## Things I want Punit to decide

- Are the exposure weights right for your exchange audience? Mixers at 55 vs scam at 50 is deliberate (sanctions-adjacent), tell me if you want scam higher for the retail bot.
- Dust floor of 8 points: this means a wallet that once received USD 2 from a mixer sits in CLEAR with a visible warning line rather than LOW. Keep or raise to 20 (pushes to LOW)?
- Identity floor at CAUTION for missing Travel Rule data: strict reading of VARA. Some exchanges will want it configurable per jurisdiction. I have made the threshold and the floor configurable; default is on.
