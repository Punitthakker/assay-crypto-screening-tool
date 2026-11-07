/**
 * Assay bot - one process, two transports.
 *   GET  /health              which transports are on
 *   GET  /webhook/whatsapp    Meta verification handshake
 *   POST /webhook/whatsapp    inbound WhatsApp messages (answers each text, acknowledges 200 immediately)
 *   POST /dev/message         { userId, text } -> { reply }  local testing without any messenger (ASSAY_BOT_DEV=1 only)
 * Telegram runs by long polling in the same process when TELEGRAM_BOT_TOKEN is set.
 * The engine runs in-process: same labels, transport and scoring as the API, no second hop.
 */
import { createServer } from "node:http";
import path from "node:path";
import { Engine, TxScreener } from "@cr/engine";
import { LabelStore, transportFromEnv } from "@cr/datasources";
import { Conversation, conversationOptionsFromEnv } from "./conversation.js";
import { WhatsAppClient, parseInbound, signatureValid, verifyHandshake, whatsappConfigFromEnv } from "./whatsapp.js";

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);

const PORT = Number(process.env.PORT ?? 8090);
const transport = transportFromEnv(process.env);
const labels = new LabelStore();
const engine = new Engine({ transport, labels, env: process.env });
const screener = new TxScreener(engine, transport, labels, process.env);
const conversation = new Conversation(screener, conversationOptionsFromEnv(process.env));

const wa = whatsappConfigFromEnv(process.env);
const waClient = wa ? new WhatsAppClient(transport, wa) : undefined;
const seen = new Set<string>(); // Meta retries deliveries; answer each message id once
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

function send(res: import("node:http").ServerResponse, code: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
    if (chunks.reduce((a, b) => a + b.length, 0) > 256_000) throw new Error("body too large");
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/health" || url.pathname === "/") {
    return send(res, 200, { ok: true, service: "assay-bot", transport: transport.mode, whatsapp: wa ? "configured" : "off", telegram: process.env.TELEGRAM_BOT_TOKEN ? "configured" : "off", freeChecksPerDay: conversation.opts.freeChecksPerDay });
  }
  if (url.pathname === "/webhook/whatsapp" && req.method === "GET") {
    if (!wa) return send(res, 503, { error: "whatsapp not configured" });
    const v = verifyHandshake(url.searchParams, wa.verifyToken);
    return v.ok ? send(res, 200, v.challenge, "text/plain") : send(res, 403, { error: "verification failed" });
  }
  if (url.pathname === "/webhook/whatsapp" && req.method === "POST") {
    if (!wa || !waClient) return send(res, 503, { error: "whatsapp not configured" });
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (e) {
      return send(res, 413, { error: String(e) });
    }
    if (wa.appSecret && !signatureValid(raw, req.headers["x-hub-signature-256"] as string | undefined, wa.appSecret)) return send(res, 401, { error: "bad signature" });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "not json" });
    }
    // acknowledge first: Meta retries anything not answered within seconds, and a screen can take longer
    send(res, 200, { ok: true });
    for (const m of parseInbound(body)) {
      if (seen.has(m.messageId)) continue;
      seen.add(m.messageId);
      if (seen.size > 5000) seen.delete(seen.values().next().value as string);
      void (async () => {
        const t0 = Date.now();
        await waClient.markRead(m.messageId);
        try {
          const reply = await conversation.reply({ userId: `wa:${m.from}`, text: m.text, transport: "whatsapp" });
          await waClient.sendText(m.from, reply, m.messageId);
          log(`[whatsapp] replied to ${conversation.quota.key(`wa:${m.from}`)} in ${Date.now() - t0}ms`);
        } catch (e) {
          log(`[whatsapp] failed for ${conversation.quota.key(`wa:${m.from}`)}: ${e instanceof Error ? e.message : String(e)}`);
          await waClient.sendText(m.from, "Something went wrong on my side. Try again in a minute.", m.messageId).catch(() => undefined);
        }
      })();
    }
    return;
  }
  if (url.pathname === "/dev/message" && req.method === "POST" && process.env.ASSAY_BOT_DEV === "1") {
    try {
      const b = JSON.parse(await readBody(req)) as { userId?: string; text?: string };
      const reply = await conversation.reply({ userId: `dev:${b.userId ?? "anon"}`, text: b.text ?? "", transport: "test" });
      return send(res, 200, { reply });
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  log(`assay-bot listening on :${PORT} transport=${transport.mode} whatsapp=${wa ? "on" : "off (set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN)"} telegram=${process.env.TELEGRAM_BOT_TOKEN ? "on" : "off"}`);
  if (process.env.TELEGRAM_BOT_TOKEN) {
    import("./telegram.js").then(({ startTelegram }) => startTelegram(process.env.TELEGRAM_BOT_TOKEN!, conversation, log)).catch((e) => log(`[telegram] failed to start: ${e instanceof Error ? e.message : String(e)}`));
  }
});
