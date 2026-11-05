/**
 * Import public address-label datasets into data/labels (needs raw.githubusercontent.com only, no keys):
 *   pnpm import:labels                      # every default-enabled source -> data/labels/imported-<id>.json
 *   pnpm import:labels -- <id> [<id> ...]   # named sources only; a non-default source goes to data/labels-optional/
 *   pnpm import:labels -- --list            # sources, licences, default state
 * Also writes data/label-imports.json (counts, timestamps, licences) for the report footer and docs/LICENCES.md.
 * Exit 1 when any requested source could not be fetched or parsed.
 */
import path from "node:path";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { LABEL_SOURCES, LabelStore, importSource, importedFileName, loadVasps, transportFromEnv } from "@cr/datasources";

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);

const args = process.argv.slice(2).filter((a) => a !== "--");
if (args.includes("--list")) {
  for (const s of LABEL_SOURCES) console.log(`${s.id.padEnd(26)} ${s.defaultEnabled ? "default " : "OPT-IN  "} ${s.licence.padEnd(48)} ${s.url}`);
  process.exit(0);
}

const wanted = args.length ? LABEL_SOURCES.filter((s) => args.includes(s.id)) : LABEL_SOURCES.filter((s) => s.defaultEnabled);
const unknown = args.filter((a) => !LABEL_SOURCES.some((s) => s.id === a));
if (unknown.length) {
  console.error(`unknown source(s): ${unknown.join(", ")}; run with --list`);
  process.exit(1);
}

const transport = transportFromEnv();
const vasps = loadVasps();
const manifestFile = "data/label-imports.json";
const manifest: Record<string, unknown> = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>) : {};
let failures = 0;

for (const src of wanted) {
  const dir = src.defaultEnabled ? "data/labels" : "data/labels-optional";
  try {
    const r = await importSource(transport, src, vasps);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, importedFileName(src.id));
    writeFileSync(file, JSON.stringify(r.labels, null, 1));
    manifest[src.id] = { url: r.url, licence: r.licence, defaultEnabled: r.defaultEnabled, fetchedAt: r.fetchedAt, file, ...r.stats };
    const skipped = r.stats.skipped.map((s) => `${s.reason}: ${s.count}`).join("; ");
    console.log(`${src.id.padEnd(26)} rows=${String(r.stats.rows).padStart(5)} kept=${String(r.stats.kept).padStart(5)} dup=${r.stats.duplicates}  -> ${file}${skipped ? `\n${"".padEnd(27)}skipped ${skipped}` : ""}`);
    if (!src.defaultEnabled) console.log(`${"".padEnd(27)}licence ${src.licence}: NOT loaded by default; set CR_LABELS_EXTRA_DIR=${dir} to use it`);
  } catch (e) {
    failures++;
    console.error(`${src.id.padEnd(26)} FAILED ${e instanceof Error ? e.message : String(e)}`);
  }
}

writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
const store = new LabelStore();
console.log(`\nlabel store now holds ${store.size} addresses from ${store.files.length} files`);
process.exit(failures ? 1 : 0);
