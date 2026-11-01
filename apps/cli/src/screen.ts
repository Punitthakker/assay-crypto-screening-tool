import { Command } from "commander";
import path from "node:path";
import { Engine } from "@cr/engine";
import { LabelStore, transportFromEnv } from "@cr/datasources";
import { CHAINS, ENABLED_CHAINS, detectFamily, type Report } from "@cr/shared";

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);

const program = new Command()
  .name("screen")
  .description("Pre-receipt screening of a sender address for a stablecoin on a chain")
  .argument("<address>", "sender address")
  .option("-c, --chain <chain>", `one of ${ENABLED_CHAINS.join(", ")} (inferred for tron/solana)`)
  .option("-a, --asset <asset>", "USDT | USDC", "USDT")
  .option("-m, --amount <n>", "amount in token units (enables Travel Rule check)", (v) => Number(v))
  .option("-t, --token <contract>", "token contract you are about to receive (authenticity check)")
  .option("--json", "print raw JSON report")
  .option("--fixture", "use recorded fixtures instead of the network (same as CR_TRANSPORT=fixture)")
  .parse();

const opts = program.opts<{ chain?: string; asset: string; amount?: number; token?: string; json?: boolean; fixture?: boolean }>();
const [address] = program.args as [string];

let chain = opts.chain;
if (!chain) {
  const fam = detectFamily(address);
  if (fam === "tron") chain = "tron";
  else if (fam === "solana") chain = "solana";
  else if (fam === "evm") {
    console.error("0x address: pass --chain (ethereum, base, arbitrum, polygon, avalanche, bnb). The same address has different freeze state on each.");
    process.exit(2);
  } else {
    console.error("Unrecognised address format.");
    process.exit(2);
  }
}

const env = { ...process.env, ...(opts.fixture ? { CR_TRANSPORT: "fixture" } : {}) };
const transport = transportFromEnv(env);
const engine = new Engine({ transport, labels: new LabelStore(), env });

try {
  const report = await engine.screen({
    address,
    chain,
    asset: opts.asset.toUpperCase(),
    ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
    ...(opts.token ? { tokenContract: opts.token } : {}),
  });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(render(report, transport.mode));
  }
  process.exit(report.verdict === "BLOCK" ? 3 : 0);
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

function render(r: Report, mode: string): string {
  const dot = { CLEAR: "🟢", LOW: "🟢", CAUTION: "🟡", HIGH: "🟠", BLOCK: "🔴" }[r.verdict];
  const lines: string[] = [];
  const chainName = CHAINS[r.request.chain as keyof typeof CHAINS]?.name ?? r.request.chain;
  lines.push(`${dot} ${r.verdict}  risk ${r.score}/100  confidence ${r.confidence}${mode === "fixture" ? "  [fixture data]" : ""}`);
  lines.push(`${r.request.asset} on ${chainName}  ${short(r.request.address)}`);
  if (r.resolvedToken) lines.push(`token ${r.resolvedToken.onChainSymbol} (${r.resolvedToken.issuer}, ${r.resolvedToken.kind}) ${short(r.resolvedToken.address)}`);
  if (r.hardBlock) lines.push(`HARD BLOCK ${r.hardBlock}`);
  lines.push("");
  for (const e of r.evidence) {
    const tag = e.severity === "block" ? "BLOCK" : e.severity === "risk" ? `+${e.points}` : "info";
    lines.push(`  ${tag.padEnd(6)} ${e.summary}`);
  }
  lines.push("");
  lines.push("coverage: " + r.coverage.map((c) => `${c.source}=${c.status}${c.ageHours !== undefined ? ` (${c.ageHours}h)` : ""}`).join("  "));
  if (r.flags.length) lines.push("flags:    " + r.flags.join(" | "));
  lines.push(`identity: ${r.identity}   report ${r.reportId.slice(0, 8)}  sha256 ${r.reportHash.slice(0, 16)}  ${r.checkedAt}`);
  lines.push("");
  lines.push(r.disclaimer);
  return lines.join("\n");
}

function short(a: string) {
  return a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}
