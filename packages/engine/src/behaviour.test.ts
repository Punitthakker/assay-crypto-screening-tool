import { describe, expect, it } from "vitest";
import { canonicalToken, type TokenDef } from "@cr/shared";
import type { Activity, ApprovalsResult, Label, Transfer } from "@cr/datasources";
import { BEHAV_CAP, DEFAULT_BEHAVIOUR, analyseBehaviour, median, passThroughPairs, structuringHits, type BehaviourInput } from "./behaviour.js";
import { computeScore } from "./score.js";

const NOW_MS = Date.UTC(2026, 10, 3);
const nowS = Math.floor(NOW_MS / 1000);
const DAY = 86_400;
const USDT: TokenDef = canonicalToken("ethereum", "USDT")!;
const ME = "0x5e0d000000000000000000000000000000000001";
const W = "0xaaaa000000000000000000000000000000000002";
const V = "0xbbbb000000000000000000000000000000000003";
const DRAINER = "0xdead000000000000000000000000000000000004";

let n = 0;
const tx = (from: string, to: string, value: number, secondsAgo: number): Transfer => ({
  chain: "ethereum",
  txHash: `0x${(++n).toString(16).padStart(4, "0")}`,
  from,
  to,
  token: USDT.address,
  valueBase: String(Math.round(value * 1e6)),
  decimals: 6,
  value,
  timestamp: nowS - secondsAgo,
});

const labels: Record<string, Label> = {
  [DRAINER.toLowerCase()]: { address: DRAINER, chainFamily: "evm", category: "scam", name: "Inferno Drainer (test)", source: "test" },
};

const activity = (over: Partial<Activity> = {}): Activity => ({
  firstSeen: nowS - 400 * DAY,
  lastSeen: nowS - DAY,
  txCount: 40,
  txCountBasis: "nonce",
  recentTimestamps: [nowS - DAY, nowS - 2 * DAY, nowS - 3 * DAY],
  isContract: false,
  providers: ["etherscan-v2", "rpc:nonce", "rpc:code"],
  errors: [],
  ...over,
});
const noApprovals: ApprovalsResult = { status: "ok", approvals: [], detail: "none" };

const mk = (over: Partial<BehaviourInput> = {}): BehaviourInput => ({
  sender: ME,
  token: USDT,
  nowMs: NOW_MS,
  inbound: [tx(W, ME, 500, 5 * DAY), tx(V, ME, 500, 6 * DAY)],
  outbound: [tx(ME, V, 200, 4 * DAY)],
  activity: activity(),
  approvals: noApprovals,
  label: (a) => labels[a.toLowerCase()],
  ...over,
});

const codes = (r: ReturnType<typeof analyseBehaviour>) => r.evidence.map((e) => e.code).sort();

describe("behavioural signals", () => {
  it("a seasoned, balanced wallet fires nothing and the coverage line is ok", () => {
    const r = analyseBehaviour(mk());
    expect(codes(r)).toEqual([]);
    expect(r.coverage).toMatchObject({ source: "behaviour", status: "ok" });
    expect(r.coverage.detail).toMatch(/^0 signals fired via/);
    expect(r.facts.walletAgeDays).toBeCloseTo(400, 0);
  });

  it("fresh wallet (under 7 days) and low tx count (under 5): worked example 1 lands at 16", () => {
    const r = analyseBehaviour(mk({ activity: activity({ firstSeen: nowS - 2 * DAY, txCount: 3, recentTimestamps: [nowS - DAY, nowS - 2 * DAY] }) }));
    expect(codes(r)).toEqual(["BEHAV_FRESH_WALLET", "BEHAV_LOW_TX_COUNT"]);
    expect(r.evidence.find((e) => e.code === "BEHAV_FRESH_WALLET")!.summary).toMatch(/2 days old/);
    expect(r.evidence.find((e) => e.code === "BEHAV_LOW_TX_COUNT")!.summary).toMatch(/3 outbound transactions/);
    expect(computeScore(r.evidence).score).toBe(16);
  });

  it("a wallet exactly 7 days old is not fresh; 5 transactions is not low", () => {
    const r = analyseBehaviour(mk({ activity: activity({ firstSeen: nowS - 7 * DAY, txCount: 5 }) }));
    expect(codes(r)).toEqual([]);
  });

  it("dormant for 180+ days then active in the last 7", () => {
    const r = analyseBehaviour(mk({ activity: activity({ recentTimestamps: [nowS - 2 * DAY, nowS - 200 * DAY, nowS - 201 * DAY] }) }));
    expect(codes(r)).toEqual(["BEHAV_DORMANT_REACTIVATED"]);
    expect(r.evidence[0]!.summary).toMatch(/quiet for 198 days/);
    // same gap but the reactivation was 10 days ago: not recent, no signal
    expect(codes(analyseBehaviour(mk({ activity: activity({ recentTimestamps: [nowS - 10 * DAY, nowS - 200 * DAY] }) })))).toEqual([]);
    // a 100 day gap is a holiday, not dormancy
    expect(codes(analyseBehaviour(mk({ activity: activity({ recentTimestamps: [nowS - DAY, nowS - 101 * DAY] }) })))).toEqual([]);
  });

  it("pass-through: median hold under 10 minutes over at least 5 in-to-out pairs", () => {
    const inbound: Transfer[] = [];
    const outbound: Transfer[] = [];
    for (let i = 0; i < 6; i++) {
      inbound.push(tx(i % 2 ? W : V, ME, 400, (10 + i) * DAY));
      outbound.push(tx(ME, V, 399, (10 + i) * DAY - 240)); // 4 minutes later
    }
    const r = analyseBehaviour(mk({ inbound, outbound }));
    expect(codes(r)).toEqual(["BEHAV_PASS_THROUGH"]);
    expect(r.facts.passThroughMedianSeconds).toBe(240);
    expect(r.facts.passThroughPairs).toBe(6);
    expect(r.evidence[0]!.summary).toMatch(/Median hold .* is 4 min over 6 outbound transfers/);
    expect(r.evidence[0]!.ref).toBe(outbound[0]!.txHash);
  });

  it("pass-through needs 5 pairs: 4 fast hops are not enough, and a slow median is fine", () => {
    const inbound: Transfer[] = [];
    const outbound: Transfer[] = [];
    for (let i = 0; i < 4; i++) {
      inbound.push(tx(W, ME, 400, (10 + i) * DAY));
      outbound.push(tx(ME, V, 399, (10 + i) * DAY - 60));
    }
    expect(codes(analyseBehaviour(mk({ inbound, outbound })))).toEqual([]);
    const slowIn: Transfer[] = [];
    const slowOut: Transfer[] = [];
    for (let i = 0; i < 6; i++) {
      slowIn.push(tx(W, ME, 400, (10 + i) * DAY));
      slowOut.push(tx(ME, V, 399, (10 + i) * DAY - 3 * 3600));
    }
    const r = analyseBehaviour(mk({ inbound: slowIn, outbound: slowOut }));
    expect(codes(r)).toEqual([]);
    expect(r.facts.passThroughMedianSeconds).toBe(3 * 3600);
  });

  it("passThroughPairs pairs each outbound with the nearest earlier inbound only", () => {
    const inbound = [tx(W, ME, 1, 1000), tx(W, ME, 1, 500)];
    const outbound = [tx(ME, V, 1, 400), tx(ME, V, 1, 2000)]; // second outbound predates every inbound
    expect(passThroughPairs(inbound, outbound, 20)).toEqual([100]);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("structuring: five or more transfers within 5 percent below a reporting threshold in 30 days", () => {
    const inbound = [2900, 2950, 2999, 2880, 2860].map((v, i) => tx(i % 2 ? W : V, ME, v, (i + 1) * DAY));
    const r = analyseBehaviour(mk({ inbound, outbound: [] }));
    expect(codes(r)).toEqual(["BEHAV_STRUCTURING"]);
    expect(r.facts.structuringHits).toEqual({ threshold: 3000, count: 5 });
    expect(r.evidence[0]!.summary).toMatch(/5 USDT transfers in 30 days each within 5\.0% below 3,000/);
    // 3,000 on the nose is not "below"; 2,840 is more than 5 percent under
    const miss = [3000, 2840, 2900, 2950, 2999].map((v, i) => tx(i % 2 ? W : V, ME, v, (i + 1) * DAY));
    expect(structuringHits(miss, DEFAULT_BEHAVIOUR, nowS)).toBeNull();
    // same five hits but 40 days ago: outside the lookback
    const old = [2900, 2950, 2999, 2880, 2860].map((v, i) => tx(W, ME, v, (40 + i) * DAY));
    expect(structuringHits(old, DEFAULT_BEHAVIOUR, nowS)).toBeNull();
  });

  it("structuring counts the outbound side too and picks the busiest threshold", () => {
    const inbound = [960, 970].map((v, i) => tx(W, ME, v, (i + 1) * DAY));
    const outbound = [955, 980, 990, 9600, 9700, 9800, 9900, 9950, 9990].map((v, i) => tx(ME, V, v, (i + 1) * DAY + 3600));
    const r = analyseBehaviour(mk({ inbound, outbound }));
    expect(r.facts.structuringHits).toEqual({ threshold: 10000, count: 6 });
  });

  it("concentration: over 70 percent of inbound value from one unlabelled counterparty, with at least two counterparties", () => {
    const r = analyseBehaviour(mk({ inbound: [tx(W, ME, 800, DAY), tx(V, ME, 200, 2 * DAY)] }));
    expect(codes(r)).toEqual(["BEHAV_CONCENTRATION"]);
    expect(r.evidence[0]!.summary).toMatch(/^80% of inbound USDT value \(800\) came from one unlabelled counterparty/);
    expect(r.facts.topCounterpartyShare).toBeCloseTo(0.8, 6);
    // a single counterparty is 100 percent by definition: no signal
    expect(codes(analyseBehaviour(mk({ inbound: [tx(W, ME, 800, DAY)] })))).toEqual([]);
    // the dominant counterparty is labelled: the label speaks, not the concentration
    expect(codes(analyseBehaviour(mk({ inbound: [tx(DRAINER, ME, 800, DAY), tx(V, ME, 200, 2 * DAY)] })))).toEqual([]);
    // 70 percent exactly is not over
    expect(codes(analyseBehaviour(mk({ inbound: [tx(W, ME, 700, DAY), tx(V, ME, 300, 2 * DAY)] })))).toEqual([]);
  });

  it("contract with admin fires only when the source is known to be unverified", () => {
    const unverified = analyseBehaviour(mk({ activity: activity({ isContract: true, contract: { verified: false, upgradeable: true, admin: W } }) }));
    expect(codes(unverified)).toEqual(["BEHAV_CONTRACT_ADMIN"]);
    expect(unverified.evidence[0]!.ref).toBe(W);
    const verified = analyseBehaviour(mk({ activity: activity({ isContract: true, contract: { verified: true, upgradeable: true, admin: W } }) }));
    expect(codes(verified)).toEqual([]);
    expect(verified.coverage.status).toBe("ok");
    const immutable = analyseBehaviour(mk({ activity: activity({ isContract: true, contract: { verified: false, upgradeable: false } }) }));
    expect(codes(immutable)).toEqual([]);
    const unknown = analyseBehaviour(mk({ activity: activity({ isContract: true, contract: { verified: null, upgradeable: true, admin: W } }) }));
    expect(codes(unknown)).toEqual([]);
    expect(unknown.coverage.status).toBe("partial");
    expect(unknown.notEvaluated.BEHAV_CONTRACT_ADMIN).toMatch(/verification could not be checked/);
  });

  it("approval granted to a labelled drainer", () => {
    const approvals: ApprovalsResult = { status: "ok", approvals: [{ spender: V, txHash: "0xok" }, { spender: DRAINER, txHash: "0xbad" }], detail: "2" };
    const r = analyseBehaviour(mk({ approvals }));
    expect(codes(r)).toEqual(["BEHAV_DRAINER_APPROVAL"]);
    expect(r.evidence[0]!.ref).toBe("0xbad");
    expect(r.evidence[0]!.summary).toMatch(/Inferno Drainer \(test\)/);
    const none = analyseBehaviour(mk({ approvals: { status: "unavailable", approvals: [], detail: "approval log scan needs ETHERSCAN_API_KEY" } }));
    expect(none.coverage.status).toBe("partial");
    expect(none.notEvaluated.BEHAV_DRAINER_APPROVAL).toMatch(/ETHERSCAN_API_KEY/);
  });

  it("a licensed VASP sender has its behavioural signals suppressed (worked example 2)", () => {
    const binance: Label = { address: ME, chainFamily: "evm", category: "exchange_licensed", name: "Binance 15", source: "test" };
    const r = analyseBehaviour(mk({ senderLabel: binance, activity: activity({ firstSeen: nowS - DAY, txCount: 1 }) }));
    expect(codes(r)).toEqual([]);
    expect(r.coverage.status).toBe("not_applicable");
    expect(r.coverage.detail).toMatch(/Binance 15/);
  });

  it("missing inputs are listed as not evaluated, never scored", () => {
    const r = analyseBehaviour(mk({ activity: null, outbound: null, approvals: null }));
    expect(codes(r)).toEqual([]);
    expect(r.coverage.status).toBe("unavailable");
    expect(Object.keys(r.notEvaluated).sort()).toEqual(["BEHAV_CONTRACT_ADMIN", "BEHAV_DORMANT_REACTIVATED", "BEHAV_DRAINER_APPROVAL", "BEHAV_FRESH_WALLET", "BEHAV_LOW_TX_COUNT", "BEHAV_PASS_THROUGH", "BEHAV_STRUCTURING"]);
    const partial = analyseBehaviour(mk({ activity: activity({ firstSeen: null, errors: ["etherscan first tx: HTTP 403"] }) }));
    expect(partial.coverage.status).toBe("partial");
    expect(partial.coverage.detail).toMatch(/not evaluated: BEHAV_FRESH_WALLET \(first transaction date not available/);
  });

  it("all eight signals together are capped at 35 in the score", () => {
    const inbound: Transfer[] = [];
    const outbound: Transfer[] = [];
    for (let i = 0; i < 6; i++) {
      inbound.push(tx(i === 0 ? V : W, ME, 2900, (10 + i) * DAY));
      outbound.push(tx(ME, V, 2899, (10 + i) * DAY - 120));
    }
    const r = analyseBehaviour(
      mk({
        inbound,
        outbound,
        activity: activity({ firstSeen: nowS - DAY, txCount: 2, recentTimestamps: [nowS - DAY, nowS - 300 * DAY], isContract: true, contract: { verified: false, upgradeable: true, admin: W } }),
        approvals: { status: "ok", approvals: [{ spender: DRAINER }], detail: "1" },
      }),
    );
    expect(codes(r)).toEqual(["BEHAV_CONCENTRATION", "BEHAV_CONTRACT_ADMIN", "BEHAV_DORMANT_REACTIVATED", "BEHAV_DRAINER_APPROVAL", "BEHAV_FRESH_WALLET", "BEHAV_LOW_TX_COUNT", "BEHAV_PASS_THROUGH", "BEHAV_STRUCTURING"]);
    expect(r.evidence.reduce((s, e) => s + e.points, 0)).toBe(79);
    const s = computeScore(r.evidence);
    expect(s.score).toBe(BEHAV_CAP);
    expect(s.verdict).toBe("LOW");
  });
});
