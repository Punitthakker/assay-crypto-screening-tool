import { describe, expect, it } from "vitest";
import path from "node:path";
import { FixtureTransport, type Transport } from "../transport.js";
import { DEFAULT_WATCHMAN, WatchmanAdapter, watchmanOptionsFromEnv } from "./watchman.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const URL_ = "http://watchman:8084";
const fixture = () => new FixtureTransport(path.join(root, "data/fixtures/watchman.json"));
/** a transport whose only live method is fetchJson; everything else is the fixture file */
const stub = (fetchJson: () => Promise<unknown>): Transport => Object.assign(Object.create(FixtureTransport.prototype) as Transport, fixture(), { fetchJson });
const adapter = (env: NodeJS.ProcessEnv = {}) => new WatchmanAdapter(fixture(), { WATCHMAN_URL: URL_, ...env });

describe("watchman options", () => {
  it("is disabled without WATCHMAN_URL and reads the thresholds from env", () => {
    expect(watchmanOptionsFromEnv({}).url).toBeUndefined();
    const o = watchmanOptionsFromEnv({ WATCHMAN_URL: "http://localhost:8084/", WATCHMAN_MIN_MATCH: "0.9", WATCHMAN_REVIEW_MATCH: "0.7", WATCHMAN_LIMIT: "3" });
    expect(o).toMatchObject({ url: "http://localhost:8084", minMatch: 0.9, reviewMatch: 0.7, limit: 3 });
    expect(watchmanOptionsFromEnv({ WATCHMAN_URL: URL_, WATCHMAN_MIN_MATCH: "abc" }).minMatch).toBe(DEFAULT_WATCHMAN.minMatch);
  });

  it("builds a v2 search query: type from isLegalPerson, birthDate for persons only, gov_national as COUNTRY:ID", () => {
    const a = adapter();
    expect(a.searchUrl({ name: " Dmitry Khoroshev ", dateOfBirth: "1993-04-17", isLegalPerson: false })).toBe(`${URL_}/v2/search?type=person&name=Dmitry+Khoroshev&birthDate=1993-04-17&minMatch=0.59&limit=5`);
    expect(a.searchUrl({ name: "D. Khoroshev", nationality: "ru", nationalId: "2018278055", isLegalPerson: false })).toContain("gov_national=RU%3A2018278055");
    const biz = a.searchUrl({ name: "Northbridge Holdings FZE", dateOfBirth: "2001-01-01", nationality: "AE", nationalId: "123", lei: "5493001KJTIIGC8Y1R12", isLegalPerson: true });
    expect(biz).toContain("type=business");
    expect(biz).not.toContain("birthDate");
    expect(biz).not.toContain("gov_");
    expect(biz).not.toContain("lei");
  });
});

describe("watchman screening (data/fixtures/watchman.json)", () => {
  it("reports loaded lists", async () => {
    const info = await adapter().listInfo();
    expect(info.lists.us_ofac).toBe(17842);
    expect(info.total).toBe(17842 + 1095 + 4120 + 5210);
  });

  it("is disabled without a URL: coverage disabled, no evidence, no network", async () => {
    const t = stub(() => Promise.reject(new Error("must not be called")));
    const r = await new WatchmanAdapter(t, {}).screenOriginator({ name: "Anyone", isLegalPerson: false });
    expect(r.coverage).toMatchObject({ source: "watchman", status: "disabled" });
    expect(r.evidence).toEqual([]);
    expect(r.facts?.screened).toBe(false);
  });

  it("name plus date of birth above the match line is HB_ORIGINATOR_SANCTIONED", async () => {
    const r = await adapter().screenOriginator({ name: "Dmitry Khoroshev", dateOfBirth: "1993-04-17", isLegalPerson: false });
    expect(r.coverage.status).toBe("ok");
    expect(r.evidence).toHaveLength(1);
    const e = r.evidence[0]!;
    expect(e.code).toBe("HB_ORIGINATOR_SANCTIONED");
    expect(e.severity).toBe("block");
    expect(e.points).toBe(100);
    expect(e.ref).toBe("us_ofac:48603");
    expect(e.summary).toContain("born 1993-04-17");
    expect(e.summary).toContain("at 0.867");
    expect(r.facts).toMatchObject({ screened: true, best: 0.867, sanctionsHits: 1, pepHits: 0 });
  });

  it("name only between the review line and the match line is a near miss: info line, flag, no points", async () => {
    const r = await adapter().screenOriginator({ name: "Dmitry Khoroshev", isLegalPerson: false });
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]).toMatchObject({ code: "IDENTITY_NAME_REVIEW", severity: "info", points: 0, ref: "us_ofac:48603" });
    expect(r.facts?.flags).toEqual(["ORIGINATOR_NAME_REVIEW"]);
    expect(r.coverage.detail).toContain("best 0.767");
  });

  it("a matching national ID scores 1.0 and blocks even with an abbreviated name", async () => {
    const r = await adapter().screenOriginator({ name: "D. Khoroshev", nationality: "RU", nationalId: "2018278055", isLegalPerson: false });
    expect(r.evidence[0]?.code).toBe("HB_ORIGINATOR_SANCTIONED");
    expect(r.facts?.best).toBe(1);
  });

  it("a clean originator gets one IDENTITY_NAME_CLEAR info line", async () => {
    const r = await adapter().screenOriginator({ name: "Amina Haddad", dateOfBirth: "1988-02-11", isLegalPerson: false });
    expect(r.evidence.map((e) => e.code)).toEqual(["IDENTITY_NAME_CLEAR"]);
    expect(r.facts).toMatchObject({ best: 0, hits: 0, flags: [] });
  });

  it("a legal person on a PEP list is IDENTITY_PEP at 15 points, not a hard block", async () => {
    const r = await adapter().screenOriginator({ name: "Northbridge Holdings FZE", isLegalPerson: true });
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]).toMatchObject({ code: "IDENTITY_PEP", severity: "risk", points: 15, ref: "opensanctions_peps:Q-INVENTED-1" });
  });

  it("two candidates: only the one above minMatch blocks, both are counted as candidates", async () => {
    const r = await adapter().screenOriginator({ name: "Karim Al Mansour", isLegalPerson: false });
    expect(r.evidence.map((e) => e.code)).toEqual(["HB_ORIGINATOR_SANCTIONED"]);
    expect(r.evidence[0]?.ref).toBe("un_csl:QDi.INVENTED");
    expect(r.facts).toMatchObject({ hits: 2, sanctionsHits: 1 });
  });

  it("a raised WATCHMAN_MIN_MATCH turns the same 0.83 hit into a near miss", async () => {
    const r = await adapter({ WATCHMAN_MIN_MATCH: "0.9" }).screenOriginator({ name: "Karim Al Mansour", isLegalPerson: false });
    expect(r.evidence.map((e) => e.code)).toEqual(["IDENTITY_NAME_REVIEW"]);
  });

  it("an unreachable Watchman is coverage unavailable, never a throw and never a clear", async () => {
    const t = stub(() => Promise.reject(new Error("HTTP 503 for http://watchman:8084/v2/search")));
    const r = await new WatchmanAdapter(t, { WATCHMAN_URL: URL_ }).screenOriginator({ name: "Anyone", isLegalPerson: false });
    expect(r.coverage).toMatchObject({ source: "watchman", status: "unavailable" });
    expect(r.coverage.detail).toContain("503");
    expect(r.evidence).toEqual([]);
  });

  it("rejects a response without the v2 shape instead of treating it as clear", async () => {
    const t = stub(() => Promise.resolve({ SDNs: [] }));
    const r = await new WatchmanAdapter(t, { WATCHMAN_URL: URL_ }).screenOriginator({ name: "Anyone", isLegalPerson: false });
    // v1 shape has no `entities`; zod defaults it to [], which would read as clear, so the adapter must not accept a v1 answer silently
    expect(r.coverage.status).toBe("unavailable");
  });
});
