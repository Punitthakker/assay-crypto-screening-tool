import { z } from "zod";
import type { Originator } from "@cr/shared";
import type { Transport } from "../transport.js";
import { now, unavailable, type AdapterResult } from "../types.js";

/**
 * Identity layer: name screening of the originator (and later the VASP entity) against
 * sanctions lists through a self-hosted moov-io/watchman (Apache-2.0), `GET /v2/search`.
 * Watchman loads OFAC SDN and Non-SDN, US CSL, EU, UK and UN lists itself; nothing is paid.
 * Off until WATCHMAN_URL is set (docker-compose.yml starts one on :8084).
 */
const SOURCE = "watchman";

export interface WatchmanOptions {
  /** base URL, e.g. http://watchman:8084; unset = disabled */
  url?: string;
  /** score at or above which a hit is a sanctions match (Watchman's production line is 0.80) */
  minMatch: number;
  /** score at or above which a near miss is reported for manual review, no points (Watchman's high-recall line is 0.59) */
  reviewMatch: number;
  /** hits requested per search */
  limit: number;
  /** lists whose hits are PEP (15 points), not sanctions (hard block); matched as a substring of sourceList */
  pepListPattern: RegExp;
}

export const DEFAULT_WATCHMAN: WatchmanOptions = {
  minMatch: 0.8,
  reviewMatch: 0.59,
  limit: 5,
  pepListPattern: /pep/i,
};

export function watchmanOptionsFromEnv(env: NodeJS.ProcessEnv = process.env, over: Partial<WatchmanOptions> = {}): WatchmanOptions {
  const num = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && env[k] !== undefined && env[k] !== "" ? v : d;
  };
  const url = env.WATCHMAN_URL?.trim().replace(/\/+$/, "");
  return {
    ...DEFAULT_WATCHMAN,
    ...(url ? { url } : {}),
    minMatch: num("WATCHMAN_MIN_MATCH", DEFAULT_WATCHMAN.minMatch),
    reviewMatch: num("WATCHMAN_REVIEW_MATCH", DEFAULT_WATCHMAN.reviewMatch),
    limit: num("WATCHMAN_LIMIT", DEFAULT_WATCHMAN.limit),
    ...over,
  };
}

/** Watchman v2 search response: each entity is the list record with `match` on it. Unknown fields are kept loose. */
const EntitySchema = z
  .object({
    name: z.string().default(""),
    entityType: z.string().optional(),
    type: z.string().optional(),
    sourceList: z.string().optional(),
    source: z.string().optional(),
    sourceID: z.string().optional(),
    match: z.number().min(0).max(1),
    person: z.object({ birthDate: z.string().optional(), gender: z.string().optional() }).passthrough().optional(),
    business: z.object({ created: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
// `entities` is required on purpose: the v1 API answers `{ SDNs: [...] }`, and that must read as "wrong Watchman", not as clear
const SearchResponseSchema = z.object({ entities: z.array(EntitySchema) }).passthrough();
const ListInfoSchema = z.object({ lists: z.record(z.number()).default({}), startedAt: z.string().optional(), endedAt: z.string().optional() }).passthrough();

export interface WatchmanHit {
  name: string;
  type: string;
  list: string;
  sourceId: string;
  match: number;
  birthDate?: string;
}

export interface WatchmanSearch {
  /** the exact URL queried (keys redacted by the transport when recorded) */
  url: string;
  hits: WatchmanHit[];
  /** highest match returned, 0 when none */
  best: number;
}

export class WatchmanAdapter {
  readonly opts: WatchmanOptions;
  constructor(
    private transport: Transport,
    opts: Partial<WatchmanOptions> | NodeJS.ProcessEnv = {},
  ) {
    this.opts = "minMatch" in opts && typeof opts.minMatch === "number" ? { ...DEFAULT_WATCHMAN, ...(opts as Partial<WatchmanOptions>) } : watchmanOptionsFromEnv(opts as NodeJS.ProcessEnv);
  }

  get enabled(): boolean {
    return Boolean(this.opts.url);
  }

  /** Builds the /v2/search query for an originator. Exported for tests and the verify script. */
  searchUrl(o: Originator, minMatch = this.opts.reviewMatch): string {
    const q = new URLSearchParams();
    q.set("type", o.isLegalPerson ? "business" : "person");
    q.set("name", o.name.trim());
    if (!o.isLegalPerson && o.dateOfBirth) q.set("birthDate", o.dateOfBirth);
    // gov_national is documented (COUNTRY:ID) and a match scores 1.0. Business registration IDs and LEIs are
    // not sent: Watchman answers 400 to a query parameter it does not read, and the exact key is unverified.
    if (!o.isLegalPerson && o.nationalId && o.nationality) q.set("gov_national", `${o.nationality.toUpperCase()}:${o.nationalId}`);
    if (o.address) q.set("address", o.address);
    q.set("minMatch", String(minMatch));
    q.set("limit", String(this.opts.limit));
    return `${this.opts.url}/v2/search?${q.toString()}`;
  }

  /** Lists loaded and their sizes. Throws when Watchman is unreachable. */
  async listInfo(): Promise<{ lists: Record<string, number>; total: number }> {
    if (!this.opts.url) throw new Error("WATCHMAN_URL is not set");
    const raw = await this.transport.fetchJson<unknown>(`${this.opts.url}/v2/listinfo`);
    const info = ListInfoSchema.parse(raw);
    return { lists: info.lists, total: Object.values(info.lists).reduce((a, b) => a + b, 0) };
  }

  /** Raw search at the review floor so near misses come back too; the caller applies minMatch. */
  async search(o: Originator): Promise<WatchmanSearch> {
    const url = this.searchUrl(o);
    const raw = await this.transport.fetchJson<unknown>(url);
    const res = SearchResponseSchema.parse(raw);
    const hits: WatchmanHit[] = res.entities
      .map((e) => ({
        name: e.name,
        type: e.entityType ?? e.type ?? "unknown",
        list: e.sourceList ?? e.source ?? "unknown",
        sourceId: e.sourceID ?? "",
        match: e.match,
        ...(e.person?.birthDate ? { birthDate: e.person.birthDate.slice(0, 10) } : {}),
      }))
      .sort((a, b) => b.match - a.match);
    return { url, hits, best: hits[0]?.match ?? 0 };
  }

  /**
   * Screens the originator. A hit at or above minMatch on a sanctions list is the hard block
   * `HB_ORIGINATOR_SANCTIONED` (SCORING.md 2d); on a PEP list it is `IDENTITY_PEP` (+15). A best
   * score between reviewMatch and minMatch is `IDENTITY_NAME_REVIEW`, info only, so the operator sees
   * the near miss without a stale fuzzy match ever blocking on its own.
   */
  async screenOriginator(o: Originator): Promise<AdapterResult> {
    const checkedAt = now();
    if (!this.opts.url) {
      return { facts: { screened: false }, evidence: [], coverage: { source: SOURCE, status: "disabled", detail: "WATCHMAN_URL not set; originator name not screened" } };
    }
    let s: WatchmanSearch;
    try {
      s = await this.search(o);
    } catch (e) {
      return { ...unavailable(SOURCE, e), facts: { screened: false } };
    }
    const who = `${o.isLegalPerson ? "legal person" : "natural person"} "${o.name}"${o.dateOfBirth ? ` born ${o.dateOfBirth}` : ""}${o.nationality ? ` (${o.nationality.toUpperCase()})` : ""}`;
    const describe = (h: WatchmanHit) => `${h.name} on ${h.list}${h.sourceId ? ` #${h.sourceId}` : ""}${h.birthDate ? ` born ${h.birthDate}` : ""} at ${h.match.toFixed(3)}`;
    const strong = s.hits.filter((h) => h.match >= this.opts.minMatch);
    const sanctions = strong.filter((h) => !this.opts.pepListPattern.test(h.list));
    const pep = strong.filter((h) => this.opts.pepListPattern.test(h.list));
    const evidence: AdapterResult["evidence"] = [];
    const flags: string[] = [];
    if (sanctions.length) {
      const top = sanctions[0]!;
      evidence.push({
        code: "HB_ORIGINATOR_SANCTIONED",
        source: SOURCE,
        severity: "block",
        points: 100,
        hop: 0,
        summary: `Originator ${who} matches ${describe(top)}${sanctions.length > 1 ? ` and ${sanctions.length - 1} more` : ""} (minMatch ${this.opts.minMatch}).`,
        ref: `${top.list}:${top.sourceId}`,
        checkedAt,
      });
    }
    if (pep.length) {
      const top = pep[0]!;
      evidence.push({
        code: "IDENTITY_PEP",
        source: SOURCE,
        severity: "risk",
        points: 15,
        hop: 0,
        summary: `Originator ${who} matches a politically exposed person: ${describe(top)}.`,
        ref: `${top.list}:${top.sourceId}`,
        checkedAt,
      });
    }
    if (!strong.length && s.best >= this.opts.reviewMatch) {
      const top = s.hits[0]!;
      flags.push("ORIGINATOR_NAME_REVIEW");
      evidence.push({
        code: "IDENTITY_NAME_REVIEW",
        source: SOURCE,
        severity: "info",
        points: 0,
        hop: 0,
        summary: `Originator ${who} is a near miss against ${describe(top)}: below the ${this.opts.minMatch} match line, above the ${this.opts.reviewMatch} review line. Manual review, no points.`,
        ref: `${top.list}:${top.sourceId}`,
        checkedAt,
      });
    }
    if (!evidence.length) {
      evidence.push({
        code: "IDENTITY_NAME_CLEAR",
        source: SOURCE,
        severity: "info",
        points: 0,
        hop: 0,
        summary: `Originator ${who}: no sanctions or PEP match at or above ${this.opts.reviewMatch}.`,
        checkedAt,
      });
    }
    return {
      facts: { screened: true, best: s.best, hits: s.hits.length, sanctionsHits: sanctions.length, pepHits: pep.length, flags },
      evidence,
      coverage: { source: SOURCE, status: "ok", detail: `${s.hits.length} candidate${s.hits.length === 1 ? "" : "s"} at or above ${this.opts.reviewMatch}, best ${s.best.toFixed(3)}, minMatch ${this.opts.minMatch}` },
    };
  }
}
