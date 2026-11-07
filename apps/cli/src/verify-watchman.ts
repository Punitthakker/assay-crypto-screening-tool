/**
 * Live check of the identity layer against a running Watchman. Run from a machine that can reach it:
 *   docker compose up -d watchman            # first download and index takes a minute
 *   WATCHMAN_URL=http://localhost:8084 pnpm verify:watchman
 *   WATCHMAN_URL=http://localhost:8084 pnpm verify:watchman -- "<name>" [yyyy-mm-dd]   # your own control
 * Prints the loaded lists, then four controls: the OFAC SDN example from Watchman's README with and
 * without a date of birth, a matching national ID, and an invented clean name.
 * Writes docs/WATCHMAN.verified.json. Exit 1 when a control does not behave as SCORING.md 2d expects.
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { WatchmanAdapter, transportFromEnv } from "@cr/datasources";
import type { Originator } from "@cr/shared";

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);

const transport = transportFromEnv();
const adapter = new WatchmanAdapter(transport, process.env);
if (!adapter.enabled) {
  console.error("WATCHMAN_URL is not set. Start one with `docker compose up -d watchman` and export WATCHMAN_URL=http://localhost:8084.");
  process.exit(2);
}

const [argName, argDob] = process.argv.slice(2);
const out: Record<string, unknown> = { verifiedAt: new Date().toISOString(), mode: transport.mode, url: adapter.opts.url, minMatch: adapter.opts.minMatch, reviewMatch: adapter.opts.reviewMatch };
let failures = 0;

try {
  const info = await adapter.listInfo();
  out.lists = info.lists;
  console.log(`lists: ${Object.entries(info.lists).map(([k, v]) => `${k}=${v}`).join("  ")}  total=${info.total}`);
  if (!info.lists.us_ofac) {
    failures++;
    console.log("  us_ofac is not loaded (or still downloading). Wait for /v2/listinfo to show it and run again.");
  }
} catch (e) {
  out.lists = { error: e instanceof Error ? e.message : String(e) };
  console.error(`listinfo failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

/** Controls: the first three are OFAC SDN 48603 as published in moov-io/watchman's README; the last is invented. */
const CONTROLS: { name: string; originator: Originator; expect: string }[] = argName
  ? [{ name: "yours", originator: { name: argName, ...(argDob ? { dateOfBirth: argDob } : {}), isLegalPerson: false }, expect: "any" }]
  : [
      { name: "sdn.nameAndDob", originator: { name: "Dmitry Khoroshev", dateOfBirth: "1993-04-17", isLegalPerson: false }, expect: "HB_ORIGINATOR_SANCTIONED" },
      { name: "sdn.nameOnly", originator: { name: "Dmitry Khoroshev", isLegalPerson: false }, expect: "IDENTITY_NAME_REVIEW" },
      { name: "sdn.nationalId", originator: { name: "D. Khoroshev", nationality: "RU", nationalId: "2018278055", isLegalPerson: false }, expect: "HB_ORIGINATOR_SANCTIONED" },
      { name: "clean.invented", originator: { name: "Amina Haddad", dateOfBirth: "1988-02-11", isLegalPerson: false }, expect: "IDENTITY_NAME_CLEAR" },
    ];

const results: Record<string, unknown> = {};
for (const c of CONTROLS) {
  const started = Date.now();
  const r = await adapter.screenOriginator(c.originator);
  const ms = Date.now() - started;
  const code = r.evidence[0]?.code ?? "(none)";
  const ok = c.expect === "any" ? r.coverage.status === "ok" : code === c.expect;
  if (!ok) failures++;
  results[c.name] = { expect: c.expect, got: code, coverage: r.coverage, facts: r.facts, summary: r.evidence[0]?.summary, ms };
  console.log(`${c.name.padEnd(16)} ${(ok ? "ok" : "FAILED").padEnd(7)} ${code.padEnd(26)} ${r.coverage.status.padEnd(12)} ${ms}ms  ${r.coverage.detail ?? ""}`);
  if (r.evidence[0]) console.log(`    ${r.evidence[0].summary}`);
}
out.controls = results;
writeFileSync("docs/WATCHMAN.verified.json", JSON.stringify(out, null, 2));
console.log(failures === 0 ? "\nWatchman identity layer verified." : `\n${failures} control(s) failed - see docs/WATCHMAN.verified.json. A near miss where a block was expected usually means Watchman's scoring changed; adjust WATCHMAN_MIN_MATCH or send me the JSON.`);
process.exit(failures === 0 ? 0 : 1);
