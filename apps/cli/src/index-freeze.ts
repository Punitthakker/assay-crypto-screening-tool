/**
 * Build or refresh the historic freeze event index (data/freeze-index/<chain>-<symbol>.json):
 *   pnpm index:freeze                      # every indexable token on every enabled chain, incremental from the stored cursor
 *   pnpm index:freeze -- ethereum tron     # named chains only
 *   pnpm index:freeze -- --status          # what is indexed, how fresh, how many events, no network
 *   pnpm index:freeze -- --rebuild         # ignore the stored cursors and read from genesis
 *   CR_RECORD=1 pnpm index:freeze          # also record the provider pages into data/fixtures/recorded.json
 * Needs ETHERSCAN_API_KEY for the EVM chains (Blockscout's /api is the keyless fallback where a host exists)
 * and TRONGRID_API_KEY for Tron. Solana has no freeze log (per token account) and is skipped with a note.
 * Exit 1 when any token that has a provider could not be updated; a token without a provider is reported, not failed.
 */
import path from "node:path";
import { ENABLED_CHAINS, TOKENS, type ChainId } from "@cr/shared";
import { FreezeIndex, FreezeIndexer, freezeEventsFor, readIndexFile, transportFromEnv, writeIndexFile } from "@cr/datasources";

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);

const args = process.argv.slice(2).filter((a) => a !== "--");
const flags = new Set(args.filter((a) => a.startsWith("--")));
const chains = args.filter((a) => !a.startsWith("--")) as ChainId[];
const dir = process.env.CR_FREEZE_INDEX_DIR ?? "data/freeze-index";

if (flags.has("--status")) {
  const ix = new FreezeIndex(dir);
  if (!ix.tokens.length) console.log(`no index files in ${dir}; run pnpm index:freeze`);
  for (const t of ix.tokens) {
    const age = Math.round((Date.now() - Date.parse(t.updatedAt)) / 3_600_000);
    console.log(`${`${t.chain}/${t.symbol}`.padEnd(20)} events=${String(t.events).padStart(6)} addresses=${String(t.addresses).padStart(6)} updated ${t.updatedAt} (${age}h ago)`);
  }
  process.exit(0);
}

const unknown = chains.filter((c) => !ENABLED_CHAINS.includes(c));
if (unknown.length) {
  console.error(`unknown or disabled chain(s): ${unknown.join(", ")}; enabled: ${ENABLED_CHAINS.join(", ")}`);
  process.exit(1);
}

const transport = transportFromEnv();
const indexer = new FreezeIndexer(transport, process.env);
const targets = TOKENS.filter((t) => (chains.length ? chains.includes(t.chain) : ENABLED_CHAINS.includes(t.chain)) && t.kind !== "bridged");
let failures = 0;
let skipped = 0;

for (const token of targets) {
  const name = `${token.chain}/${token.onChainSymbol}`.padEnd(20);
  if (!freezeEventsFor(token)) {
    skipped++;
    const p = indexer.providerFor(token);
    console.log(`${name} skipped: ${"reason" in p ? p.reason : "no freeze log"}`);
    continue;
  }
  const p = indexer.providerFor(token);
  if ("reason" in p) {
    skipped++;
    console.log(`${name} skipped: ${p.reason}`);
    continue;
  }
  const existing = flags.has("--rebuild") ? undefined : readIndexFile(dir, token);
  const started = Date.now();
  try {
    const r = await indexer.update(token, existing);
    const file = writeIndexFile(dir, token, r.file);
    const added = r.file.events.filter((e) => e.type === "added").length;
    const removed = r.file.events.filter((e) => e.type === "removed").length;
    const destroyed = r.file.events.filter((e) => e.type === "destroyed").length;
    console.log(`${name} ${p.provider.padEnd(12)} +${String(r.added).padStart(5)} new, ${String(r.file.events.length).padStart(6)} total (${added} added, ${removed} removed, ${destroyed} destroyed), cursor ${r.file.cursor.block}, ${r.pages} request${r.pages === 1 ? "" : "s"}, ${Date.now() - started}ms -> ${path.relative(root, file)}`);
  } catch (e) {
    failures++;
    console.error(`${name} ${p.provider.padEnd(12)} FAILED ${e instanceof Error ? e.message : String(e)}${existing ? " (existing file kept)" : ""}`);
  }
}

console.log(`\n${targets.length - failures - skipped} updated, ${skipped} skipped, ${failures} failed; mode ${transport.mode}`);
process.exit(failures ? 1 : 0);
