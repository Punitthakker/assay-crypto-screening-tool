/**
 * Hand-encoded fixtures for the identity layer (Watchman name screening).
 * Regenerate with:  pnpm tsx data/fixtures/build-watchman.ts
 * Shapes follow moov-io/watchman docs/search.md (v2: each entity is the list record with `match` on it).
 * The sanctioned-person row is the public OFAC SDN example from Watchman's own README (SDN 48603);
 * every other name is invented control data. WATCHMAN_URL in these keys is http://watchman:8084,
 * the docker-compose service name.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

export const WATCHMAN_URL = "http://watchman:8084";

function searchKey(params: Record<string, string>) {
  const q = new URLSearchParams(params);
  return `url:${WATCHMAN_URL}/v2/search?${q.toString()}`;
}

const SDN = {
  name: "Dmitry Yuryevich KHOROSHEV",
  entityType: "person",
  sourceList: "us_ofac",
  sourceID: "48603",
  person: { name: "Dmitry Yuryevich KHOROSHEV", gender: "male", birthDate: "1993-04-17T00:00:00Z" },
};

const fixtures: Record<string, unknown> = {
  [`url:${WATCHMAN_URL}/v2/listinfo`]: { lists: { us_ofac: 17842, un_csl: 1095, eu_csl: 4120, uk_csl: 5210 }, startedAt: "2026-11-07T01:00:00Z", endedAt: "2026-11-07T01:00:41Z" },

  // 1. name plus date of birth clears the 0.80 line (README: 0.867)
  [searchKey({ type: "person", name: "Dmitry Khoroshev", birthDate: "1993-04-17", minMatch: "0.59", limit: "5" })]: {
    query: { name: "Dmitry Khoroshev", entityType: "person" },
    entities: [{ ...SDN, match: 0.867 }],
  },
  // 2. name only: 0.767, between the review line and the match line
  [searchKey({ type: "person", name: "Dmitry Khoroshev", minMatch: "0.59", limit: "5" })]: {
    query: { name: "Dmitry Khoroshev", entityType: "person" },
    entities: [{ ...SDN, match: 0.767 }],
  },
  // 3. a matching national ID is an identity key and scores 1.0
  [searchKey({ type: "person", name: "D. Khoroshev", gov_national: "RU:2018278055", minMatch: "0.59", limit: "5" })]: {
    query: { name: "D. Khoroshev", entityType: "person" },
    entities: [{ ...SDN, match: 1 }],
  },
  // 4. invented clean originator: nothing at or above the review line
  [searchKey({ type: "person", name: "Amina Haddad", birthDate: "1988-02-11", minMatch: "0.59", limit: "5" })]: {
    query: { name: "Amina Haddad", entityType: "person" },
    entities: [],
  },
  // 5. legal person on an OpenSanctions PEP list (invented): PEP, not a sanctions block
  [searchKey({ type: "business", name: "Northbridge Holdings FZE", minMatch: "0.59", limit: "5" })]: {
    query: { name: "Northbridge Holdings FZE", entityType: "business" },
    entities: [{ name: "NORTHBRIDGE HOLDINGS FZE", entityType: "business", sourceList: "opensanctions_peps", sourceID: "Q-INVENTED-1", match: 0.91 }],
  },
  // 6. two hits, the weaker one below the line: only the strong one counts, both are candidates
  [searchKey({ type: "person", name: "Karim Al Mansour", minMatch: "0.59", limit: "5" })]: {
    query: { name: "Karim Al Mansour", entityType: "person" },
    entities: [
      { name: "Karim AL-MANSOUR", entityType: "person", sourceList: "un_csl", sourceID: "QDi.INVENTED", match: 0.83 },
      { name: "Karim MANSOURI", entityType: "person", sourceList: "eu_csl", sourceID: "EU.INVENTED", match: 0.66 },
    ],
  },
};

const file = path.resolve(import.meta.dirname, "watchman.json");
writeFileSync(file, JSON.stringify(fixtures, null, 2) + "\n");
console.log(`wrote ${Object.keys(fixtures).length} fixture keys to ${file}`);
