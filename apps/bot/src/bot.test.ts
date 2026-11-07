import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { createHmac } from "node:crypto";
import { Engine, TxScreener } from "@cr/engine";
import { FixtureTransport, LabelStore } from "@cr/datasources";
import { Conversation, Quota, conversationOptionsFromEnv, formatReply, helpText, parseIntent, type ConversationOptions } from "./conversation.js";
import { WhatsAppClient, parseInbound, signatureValid, verifyHandshake, whatsappConfigFromEnv } from "./whatsapp.js";

const root = path.resolve(import.meta.dirname, "../../..");
const BASE_CLEAN = "0x1111111111111111111111111111111111111111";
const ETH_BLOCKED = "0x0330070FD38Ec3bB94F58FA55D40368271E9e54A";
const ETH_USDC_FROZEN = "0x5555555555555555555555555555555555555555";

let conv: Conversation;
const opts = (over: Partial<ConversationOptions> = {}): ConversationOptions => ({ ...conversationOptionsFromEnv({}), ...over });

beforeAll(() => {
  process.chdir(root);
  const transport = new FixtureTransport(path.join(root, "data/fixtures/recorded.json"));
  const labels = new LabelStore(path.join(root, "data/labels"));
  const engine = new Engine({ transport, labels, env: {} });
  conv = new Conversation(new TxScreener(engine, transport, labels, {}), opts());
});

describe("parseIntent", () => {
  it("finds an EVM address with a chain word, an asset and an amount in free text", () => {
    const i = parseIntent(`is ${BASE_CLEAN} on Base safe? 25,000 USDC incoming`);
    expect(i).toMatchObject({ kind: "lookup", input: BASE_CLEAN, chain: "base", asset: "USDC", amount: 25000 });
  });
  it("does not read digits inside trc20 as an amount and understands 'k'", () => {
    expect(parseIntent("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t trc20").amount).toBeUndefined();
    expect(parseIntent("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t 12k usdt").amount).toBe(12000);
  });
  it("takes a link as the input and an 0x hash as a tx", () => {
    expect(parseIntent("check https://tronscan.org/#/transaction/abc123def456abc123def456abc123def456abc123def456abc123def456abcd").input).toMatch(/^https:\/\/tronscan/);
    expect(parseIntent(`0x${"a".repeat(64)} on polygon`)).toMatchObject({ kind: "lookup", chain: "polygon" });
  });
  it("routes greetings to help, questions to the FAQ, and the rest to unknown", () => {
    expect(parseIntent("hi").kind).toBe("help");
    expect(parseIntent("/start").kind).toBe("help");
    expect(parseIntent("what is assay?")).toMatchObject({ kind: "faq", topic: "what" });
    expect(parseIntent("which chains do you support")).toMatchObject({ kind: "faq", topic: "chains" });
    expect(parseIntent("how is the score calculated")).toMatchObject({ kind: "faq", topic: "score" });
    expect(parseIntent("what does frozen mean")).toMatchObject({ kind: "faq", topic: "frozen" });
    expect(parseIntent("is this pricing free?")).toMatchObject({ kind: "faq", topic: "price" });
    expect(parseIntent("ofac?")).toMatchObject({ kind: "faq", topic: "sanctions" });
    expect(parseIntent("lorem ipsum dolor").kind).toBe("unknown");
  });
});

describe("Quota", () => {
  it("gives 3 checks a day per hashed id, resets at the UTC day, never stores the raw id", () => {
    let day = new Date("2026-11-07T10:00:00Z");
    const q = new Quota(opts({ now: () => day }));
    expect(q.key("wa:971500000000")).not.toContain("971500000000");
    expect(q.left("wa:971500000000")).toBe(3);
    expect(q.take("wa:971500000000")).toBe(true);
    expect(q.take("wa:971500000000")).toBe(true);
    expect(q.take("wa:971500000000")).toBe(true);
    expect(q.take("wa:971500000000")).toBe(false);
    expect(q.left("wa:971500000001")).toBe(3);
    day = new Date("2026-11-08T00:01:00Z");
    expect(q.left("wa:971500000000")).toBe(3);
  });
  it("unlimited ids and freeChecksPerDay=0 are uncapped", () => {
    const q = new Quota(opts({ unlimitedIds: new Set(["wa:1"]) }));
    for (let i = 0; i < 10; i++) expect(q.take("wa:1")).toBe(true);
    expect(q.left("wa:1")).toBe(Infinity);
    const z = new Quota(opts({ freeChecksPerDay: 0 }));
    for (let i = 0; i < 10; i++) expect(z.take("wa:2")).toBe(true);
  });
  it("reads the env", () => {
    const o = conversationOptionsFromEnv({ ASSAY_BOT_FREE_CHECKS: "5", ASSAY_BOT_UNLIMITED_IDS: "wa:1, tg:2", ASSAY_BOT_SALT: "x" });
    expect(o.freeChecksPerDay).toBe(5);
    expect([...o.unlimitedIds]).toEqual(["wa:1", "tg:2"]);
    expect(conversationOptionsFromEnv({ ASSAY_BOT_FREE_CHECKS: "nope" }).freeChecksPerDay).toBe(3);
  });
});

describe("Conversation on fixtures (data/fixtures/recorded.json)", () => {
  const msg = (text: string, userId = "test:1") => conv.reply({ userId, text, transport: "test" });

  it("answers help and FAQ without spending a check", async () => {
    const before = conv.quota.left("test:faq");
    expect(await msg("hello", "test:faq")).toBe(helpText(conv.opts));
    expect(await msg("what is assay", "test:faq")).toContain("pre-receipt screen");
    expect(await msg("which chains", "test:faq")).toContain("Tron");
    expect(await msg("random words here", "test:faq")).toContain("did not catch an address");
    expect(conv.quota.left("test:faq")).toBe(before);
  });

  it("asks for the chain when an 0x address comes alone", async () => {
    const r = await msg(BASE_CLEAN, "test:chain");
    expect(r).toContain("Which chain?");
    expect(conv.quota.left("test:chain")).toBe(3);
  });

  it("screens a clean Base USDC address: CLEAR, under 12 lines, explorer link, checks left", async () => {
    const r = await msg(`${BASE_CLEAN} on base usdc`, "test:clean");
    const lines = r.split("\n");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines[0]).toMatch(/^CLEAR/);
    expect(r).toContain("basescan.org/address/");
    expect(r).toContain("2 free checks left today");
  });

  it("a sanctioned Ethereum sender is BLOCK with the hard-block reason first", async () => {
    const r = await msg(`${ETH_BLOCKED} eth usdt`, "test:block");
    expect(r.split("\n")[0]).toMatch(/^BLOCK: 100\/100/);
    expect(r).toMatch(/OFAC|sanction/i);
  });

  it("a Circle-frozen address on Ethereum USDC is BLOCK and says frozen", async () => {
    const r = await msg(`${ETH_USDC_FROZEN} ethereum usdc`, "test:frozen");
    expect(r).toMatch(/^BLOCK/);
    expect(r.toLowerCase()).toContain("frozen");
  });

  it("an amount above the Travel Rule threshold adds the originator line", async () => {
    const r = await msg(`${BASE_CLEAN} on base 25000 usdc`, "test:tr");
    expect(r).toContain("Travel Rule");
  });

  it("stops at the daily cap and says how to get more", async () => {
    await msg(`${BASE_CLEAN} on base`, "test:cap");
    await msg(`${BASE_CLEAN} on base`, "test:cap");
    await msg(`${BASE_CLEAN} on base`, "test:cap");
    const r = await msg(`${BASE_CLEAN} on base`, "test:cap");
    expect(r).toContain("used your 3 free checks");
    expect(r).toContain(conv.opts.contact);
  });

  it("an address on the wrong chain family is a readable error, not a crash", async () => {
    const r = await msg(`${BASE_CLEAN} on solana`, "test:err");
    expect(r).toMatch(/^Could not screen that:/);
    expect(r).toContain("evm");
  });

  it("an address the fixtures have no explorer data for is CLEAR on available data, with the coverage stated", async () => {
    const r = await msg("TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX", "test:partial");
    expect(r).toMatch(/^CLEAR on available data/);
    expect(r).toContain("Fund flow: unavailable");
  });

  it("formatReply never exceeds 12 lines even with many evidence lines and sources", async () => {
    const t = new FixtureTransport(path.join(root, "data/fixtures/recorded.json"));
    const labels = new LabelStore(path.join(root, "data/labels"));
    const screener = new TxScreener(new Engine({ transport: t, labels, env: {} }), t, labels, {});
    const r = await screener.lookup({ input: ETH_BLOCKED, chain: "ethereum" });
    const padded = { ...r, sources: Array.from({ length: 8 }, (_, i) => ({ address: `0x${String(i).padStart(40, "0")}`, share: 0.1, total: 1, count: 1, firstSeen: "", lastSeen: "", sanctioned: true, frozen: false, status: "sanctioned" as const, txHashes: [] })) };
    expect(formatReply(padded, 1).split("\n").length).toBeLessThanOrEqual(12);
  });
});

describe("WhatsApp transport", () => {
  it("needs all three env values", () => {
    expect(whatsappConfigFromEnv({ WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1" })).toBeUndefined();
    expect(whatsappConfigFromEnv({ WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_VERIFY_TOKEN: "v" })).toMatchObject({ apiVersion: "v21.0" });
  });

  it("verification handshake echoes the challenge only for the right token", () => {
    const ok = verifyHandshake(new URLSearchParams("hub.mode=subscribe&hub.verify_token=secret&hub.challenge=12345"), "secret");
    expect(ok).toEqual({ ok: true, challenge: "12345" });
    expect(verifyHandshake(new URLSearchParams("hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"), "secret")).toEqual({ ok: false });
  });

  it("validates X-Hub-Signature-256", () => {
    const body = '{"a":1}';
    const sig = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    expect(signatureValid(body, sig, "app-secret")).toBe(true);
    expect(signatureValid(body, sig, "other")).toBe(false);
    expect(signatureValid(body, undefined, "app-secret")).toBe(false);
  });

  it("parses Meta's delivery shape: text messages in, statuses and media ignored", () => {
    const delivery = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "971564627605", phone_number_id: "PNID" },
                contacts: [{ profile: { name: "A" }, wa_id: "971500000000" }],
                messages: [
                  { from: "971500000000", id: "wamid.1", timestamp: "1", type: "text", text: { body: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" } },
                  { from: "971500000000", id: "wamid.2", timestamp: "2", type: "image", image: { id: "x" } },
                  { from: "971500000000", id: "wamid.3", timestamp: "3", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b", title: "help" } } },
                ],
              },
            },
            { field: "messages", value: { messaging_product: "whatsapp", statuses: [{ id: "wamid.1", status: "delivered" }] } },
          ],
        },
      ],
    };
    expect(parseInbound(delivery)).toEqual([
      { from: "971500000000", messageId: "wamid.1", text: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", phoneNumberId: "PNID" },
      { from: "971500000000", messageId: "wamid.3", text: "help", phoneNumberId: "PNID" },
    ]);
    expect(parseInbound({ nonsense: true })).toEqual([]);
  });

  it("sends a text reply through the Graph API with the bearer token and reply context", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = new WhatsAppClient({ fetchJson: async <T,>(url: string, init?: RequestInit) => (calls.push({ url, init }), { messages: [{ id: "wamid.out" }] } as T) }, { token: "TOK", phoneNumberId: "PNID", verifyToken: "v", apiVersion: "v21.0" });
    const r = await client.sendText("971500000000", "CLEAR: 0/100", "wamid.1");
    expect(r.id).toBe("wamid.out");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v21.0/PNID/messages");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer TOK");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({ messaging_product: "whatsapp", to: "971500000000", type: "text", text: { body: "CLEAR: 0/100" }, context: { message_id: "wamid.1" } });
  });
});
