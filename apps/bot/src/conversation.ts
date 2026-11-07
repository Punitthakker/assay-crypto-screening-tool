/**
 * The bot's brain, independent of the messaging transport. One text in, one text out, under 12 lines.
 * Understands: an address, a tx hash, an explorer link (with an optional chain or asset word in the
 * same message), and plain questions about Assay. Everything that touches the chain goes through the
 * same Engine and TxScreener as the API, so a WhatsApp answer and a /v1/lookup answer never disagree.
 */
import { createHash } from "node:crypto";
import { CHAINS, ENABLED_CHAINS, DISCLAIMER, detectFamily, getChain, type ChainId, type Report } from "@cr/shared";
import { classifyInput, explorerAddressUrl } from "@cr/datasources";
import type { LookupReport, TxScreener } from "@cr/engine";

export interface BotMessage {
  /** transport-specific user id (phone number on WhatsApp, numeric id on Telegram); hashed before use */
  userId: string;
  text: string;
  transport: "whatsapp" | "telegram" | "test";
}

export interface ConversationOptions {
  /** free checks per user per UTC day; 0 = unlimited */
  freeChecksPerDay: number;
  /** user ids (raw, as the transport gives them) with no daily cap */
  unlimitedIds: Set<string>;
  /** salt for the hashed user id; the raw id is never stored */
  salt: string;
  /** link printed under every verdict */
  consoleUrl: string;
  /** contact for pilot access */
  contact: string;
  /** clock, for tests */
  now?: () => Date;
}

export function conversationOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ConversationOptions {
  const n = Number(env.ASSAY_BOT_FREE_CHECKS ?? 3);
  return {
    freeChecksPerDay: Number.isFinite(n) && n >= 0 ? n : 3,
    unlimitedIds: new Set((env.ASSAY_BOT_UNLIMITED_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    salt: env.ASSAY_BOT_SALT ?? "assay",
    consoleUrl: env.ASSAY_CONSOLE_URL ?? "https://assay-screening.netlify.app/check",
    contact: env.ASSAY_CONTACT ?? "pt@moneybee.world",
  };
}

/** Daily quota keyed by a salted hash of the user id. In memory: a restart resets it, which is fine for a free tier. */
export class Quota {
  private used = new Map<string, { day: string; n: number }>();
  constructor(private opts: ConversationOptions) {}
  key(userId: string): string {
    return createHash("sha256").update(`${this.opts.salt}:${userId}`).digest("hex").slice(0, 16);
  }
  private day(): string {
    return (this.opts.now?.() ?? new Date()).toISOString().slice(0, 10);
  }
  /** checks left today, Infinity when uncapped */
  left(userId: string): number {
    if (this.opts.freeChecksPerDay === 0 || this.opts.unlimitedIds.has(userId)) return Infinity;
    const u = this.used.get(this.key(userId));
    return this.opts.freeChecksPerDay - (u && u.day === this.day() ? u.n : 0);
  }
  /** consumes one check; false when none is left */
  take(userId: string): boolean {
    if (this.left(userId) <= 0) return false;
    if (this.opts.freeChecksPerDay === 0 || this.opts.unlimitedIds.has(userId)) return true;
    const k = this.key(userId);
    const u = this.used.get(k);
    const day = this.day();
    this.used.set(k, { day, n: u && u.day === day ? u.n + 1 : 1 });
    return true;
  }
}

const CHAIN_WORDS: Record<string, ChainId> = {
  ethereum: "ethereum", eth: "ethereum", erc20: "ethereum", "erc-20": "ethereum", mainnet: "ethereum",
  tron: "tron", trx: "tron", trc20: "tron", "trc-20": "tron",
  solana: "solana", sol: "solana", spl: "solana",
  base: "base",
  arbitrum: "arbitrum", arb: "arbitrum",
  polygon: "polygon", matic: "polygon", pol: "polygon",
  avalanche: "avalanche", avax: "avalanche",
  bnb: "bnb", bsc: "bnb", bep20: "bnb", "bep-20": "bnb", binance: "bnb",
};

export interface ParsedIntent {
  kind: "lookup" | "help" | "faq" | "unknown";
  input?: string;
  chain?: ChainId;
  asset?: "USDT" | "USDC";
  amount?: number;
  topic?: string;
}

/** Pulls the address, hash or link out of free text, plus any chain, asset or amount words around it. */
export function parseIntent(text: string): ParsedIntent {
  const t = text.trim();
  if (!t) return { kind: "help" };
  const lower = t.toLowerCase();
  const tokens = lower.split(/[\s,;]+/);
  const candidate =
    t.match(/https?:\/\/\S+/i)?.[0] ??
    t.match(/\b0x[0-9a-fA-F]{64}\b/)?.[0] ??
    t.match(/\b0x[0-9a-fA-F]{40}\b/)?.[0] ??
    t.match(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/)?.[0] ??
    t.match(/\b[1-9A-HJ-NP-Za-km-z]{43,88}\b/)?.[0] ??
    t.match(/\b[0-9a-fA-F]{64}\b/)?.[0];
  if (candidate) {
    const chain = tokens.map((w) => CHAIN_WORDS[w.replace(/^on$/, "")]).find((c): c is ChainId => Boolean(c));
    const asset = tokens.includes("usdc") ? "USDC" : tokens.includes("usdt") || tokens.includes("tether") ? "USDT" : undefined;
    const amt = lower.replace(candidate.toLowerCase(), " ").match(/(?:^|\s)(\d[\d,]*(?:\.\d+)?)\s*(?:k\b)?/);
    let amount: number | undefined;
    if (amt?.[1]) {
      amount = Number(amt[1].replace(/,/g, ""));
      if (/\d\s*k\b/.test(amt[0])) amount *= 1000;
      if (!Number.isFinite(amount) || amount <= 0) amount = undefined;
    }
    return { kind: "lookup", input: candidate, ...(chain ? { chain } : {}), ...(asset ? { asset } : {}), ...(amount !== undefined ? { amount } : {}) };
  }
  if (/^(\/?(start|help|hi|hello|hey|menu|salam|salaam)|what can you do|how does this work)\b/.test(lower)) return { kind: "help" };
  const topic = FAQ.find((f) => f.match.test(lower))?.id;
  return topic ? { kind: "faq", topic } : { kind: "unknown" };
}

const FAQ: { id: string; match: RegExp; answer: (o: ConversationOptions) => string }[] = [
  {
    id: "what",
    match: /\b(what is|what's|whats|about|who are you|explain)\b.*\b(assay|this|you)\b|^(assay|about)\??$/,
    answer: (o) => [
      "Assay is a pre-receipt screen for USDT and USDC.",
      "Send me a sender address, a transaction hash or an explorer link and I answer one question: is this clean enough to accept right now, and how sure are we.",
      "Checks: issuer freeze (Tether, Circle), OFAC and the Chainalysis oracle, where the funds came from (2 hops), wallet behaviour, and whether the token is real.",
      `Full report with every reason: ${o.consoleUrl}`,
    ].join("\n"),
  },
  {
    id: "chains",
    match: /\b(chain|chains|network|networks|support|supported|which coins|tokens?)\b/,
    answer: () => `Chains: ${ENABLED_CHAINS.map((c) => CHAINS[c].name).join(", ")}.\nAssets: USDT and USDC, native issues plus the bridged forms (Binance-Peg, USDC.e, USDbC) which are flagged as such.\nTron and Solana addresses are recognised on their own; for a 0x address add the chain, e.g. "0xabc... on base".`,
  },
  {
    id: "score",
    match: /\b(score|scoring|verdict|band|bands|clear|caution|block|confidence|how (do|does) (you|it) (decide|score|work))\b/,
    answer: () => [
      "Score 0 to 100, higher is worse. CLEAR 0-19, LOW 20-39, CAUTION 40-59, HIGH 60-79, BLOCK 80-100.",
      "Hard blocks go straight to 100: frozen by the issuer, on the OFAC list, flagged by the sanctions oracle, or a fake token.",
      "Otherwise points add up from exposure (who sent the funds, 2 hops back, value-weighted), wallet behaviour, asset authenticity and identity.",
      "Confidence says how much of that we could actually check. Every report carries the evidence and a SHA-256 hash.",
    ].join("\n"),
  },
  {
    id: "price",
    match: /\b(price|pricing|cost|free|pay|paid|subscription|plan|api key|api|pilot|integrate|integration|sdk)\b/,
    answer: (o) => `Here on WhatsApp: ${o.freeChecksPerDay === 0 ? "unlimited" : `${o.freeChecksPerDay} free`} checks a day, no sign-up.\nExchanges, OTC desks and PSPs get the API (POST /v1/screen, every reason and a report hash) and the console under a pilot agreement.\nWrite to ${o.contact} and say which chains and volumes you run.`,
  },
  {
    id: "frozen",
    match: /\b(frozen|freeze|blacklist|blacklisted|tether froze|circle froze|unfreeze)\b/,
    answer: () => "Tether and Circle can freeze any address on their own contracts. Assay reads that flag live from the contract on the chain you name, and keeps a history so a wallet that was frozen and released is still marked.\nA frozen sender is a BLOCK. A sender that received from a frozen wallet gets exposure points, not a block.\nSend the address and I will check it.",
  },
  {
    id: "sanctions",
    match: /\b(sanction|sanctions|ofac|sdn|chainalysis|un list|terror)\b/,
    answer: () => "Two independent sanctions sources on every check: the OFAC SDN digital-currency list (mirrored nightly) and the Chainalysis on-chain oracle. If they disagree the hit still blocks and the report says so.\nFor people and companies (Travel Rule originator data) there is a name screen against OFAC, UN, EU and UK lists through Watchman.\nSend an address to run it.",
  },
  {
    id: "safe",
    match: /\b(safe|scam|legit|trust|risky|should i (accept|take|receive)|is it ok)\b/,
    answer: () => "Paste the sender's address or the transaction link and I will tell you: frozen or not, sanctioned or not, where the funds came from, and a verdict with the reasons.\nI only look at public on-chain data and official lists. Not legal advice.",
  },
];

/** Formats one report into the short, declarative reply the brand asks for. Never more than 12 lines. */
export function formatReply(r: LookupReport, left: number): string {
  const lines: string[] = [];
  const report: Report | undefined = r.kind === "address" ? r.report : r.report;
  if (r.kind === "tx") {
    if (!r.screened || !report) {
      lines.push(`Transaction found on ${getChain(r.tx.chain).name}, but it moved no genuine USDT or USDC.`);
      if (r.otherTokens.length) lines.push(`Look-alike token: ${r.otherTokens[0]!.token}. Do not accept it as USDT/USDC.`);
      return lines.join("\n");
    }
    lines.push(`${verdictWord(report)} ${report.score}/100, confidence ${report.confidence}`);
    lines.push(`${fmtAmount(r.screened.value)} ${r.screened.onChainSymbol} on ${getChain(r.tx.chain).name}${r.screened.paysReceiver === false ? ", NOT to your address" : ""}`);
    lines.push(`Sender ${short(r.screened.from)} screened:`);
  } else {
    lines.push(`${verdictWord(report!)} ${report!.score}/100, confidence ${report!.confidence}`);
    lines.push(`${short(r.address)} for ${report!.request.asset} on ${getChain(r.chain).name}`);
  }
  const rep = report!;
  const top = rep.evidence.filter((e) => e.severity !== "info" || e.code.startsWith("IDENTITY_") || e.code === "FLOW_TRACE").slice(0, 3);
  for (const e of top) lines.push(`- ${trim(e.summary, 110)}`);
  if (top.length === 0) lines.push("- Not frozen, not sanctioned, no tainted sources found in the window.");
  const sources = r.sources.filter((s) => s.status !== "unlabelled" && s.status !== "licensed").slice(0, 2);
  for (const s of sources) lines.push(`- Source ${short(s.address)}: ${s.status.replace("_", " ")}, ${Math.round(s.share * 100)}% of inbound`);
  const flow = rep.coverage.find((c) => c.source === "fund-flow");
  if (flow && flow.status !== "ok" && flow.status !== "not_applicable") lines.push(`Fund flow: ${flow.status}${flow.status === "partial" ? "" : " (explorer not configured for this chain)"}.`);
  if (rep.flags.includes("TRAVEL_RULE_DATA_REQUIRED")) lines.push("Above the Travel Rule threshold: ask the sending VASP for originator details.");
  const addr = r.kind === "address" ? r.address : r.screened!.from;
  const chain: ChainId = r.kind === "address" ? r.chain : (r.tx.chain as ChainId);
  lines.push(`Report ${rep.reportId.slice(0, 8)} sha256 ${rep.reportHash.slice(0, 12)} | ${explorerAddressUrl(chain, addr)}`);
  if (Number.isFinite(left)) lines.push(`${left} free check${left === 1 ? "" : "s"} left today.`);
  return lines.slice(0, 12).join("\n");
}

function verdictWord(r: Report): string {
  const mark = r.verdict === "BLOCK" ? "BLOCK" : r.verdict === "HIGH" ? "HIGH RISK" : r.verdict === "CAUTION" ? "CAUTION" : r.verdict === "LOW" ? "LOW RISK" : r.confidence === "low" ? "CLEAR on available data" : "CLEAR";
  return `${mark}:`;
}
const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}...${a.slice(-6)}` : a);
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);
const fmtAmount = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function helpText(o: ConversationOptions): string {
  return [
    "Assay: test the asset before you take it.",
    "Send me one of these and I screen the sender:",
    "- a wallet address (add the chain for 0x addresses: \"0x... on base\")",
    "- a transaction hash or a tronscan / etherscan / solscan link",
    "- an amount too, e.g. \"TXYZ... 25000 USDT\", for the Travel Rule check",
    "Or ask: what is assay, which chains, how is it scored, what does frozen mean, pricing.",
    `${o.freeChecksPerDay === 0 ? "Unlimited" : `${o.freeChecksPerDay} free`} checks a day. Full console: ${o.consoleUrl}`,
    "Screening support only. Not legal advice.",
  ].join("\n");
}

export class Conversation {
  readonly quota: Quota;
  constructor(
    private screener: TxScreener,
    readonly opts: ConversationOptions,
  ) {
    this.quota = new Quota(opts);
  }

  async reply(m: BotMessage): Promise<string> {
    const intent = parseIntent(m.text);
    if (intent.kind === "help") return helpText(this.opts);
    if (intent.kind === "faq") return FAQ.find((f) => f.id === intent.topic)!.answer(this.opts);
    if (intent.kind === "unknown") return `I did not catch an address or a link in that.\n${helpText(this.opts)}`;

    // lookup
    const c = classifyInput(intent.input!, intent.chain);
    if (c.kind === "address" && !c.chain && !intent.chain) {
      const fam = detectFamily(c.address);
      if (fam === "evm") return `That is an EVM address. Which chain? Reply with the address and the chain, e.g. "${short(c.address)} on ethereum" (ethereum, base, arbitrum, polygon, avalanche, bnb).`;
    }
    if (!this.quota.take(m.userId)) {
      return `You have used your ${this.opts.freeChecksPerDay} free checks for today. They reset at midnight UTC.\nFor unlimited checks and the API, write to ${this.opts.contact}.`;
    }
    try {
      const r = await this.screener.lookup({
        input: intent.input!,
        ...(intent.chain ? { chain: intent.chain } : {}),
        ...(intent.asset ? { asset: intent.asset } : {}),
        ...(intent.amount !== undefined ? { amount: intent.amount } : {}),
      });
      return formatReply(r, this.quota.left(m.userId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Could not screen that: ${trim(msg, 160)}\nCheck the address or link and the chain, then try again.`;
    }
  }
}

export const SHORT_DISCLAIMER = DISCLAIMER;
