/**
 * WhatsApp Business Cloud API transport (Meta Graph API). No SDK: two HTTP calls.
 *   GET  /webhook/whatsapp   Meta's verification handshake (hub.mode, hub.verify_token, hub.challenge)
 *   POST /webhook/whatsapp   inbound messages; each text message is answered with one text reply
 * Required env: WHATSAPP_TOKEN (system-user access token), WHATSAPP_PHONE_NUMBER_ID (the sending number's
 * id in Meta Business, not the phone number), WHATSAPP_VERIFY_TOKEN (any secret you type into the webhook form).
 * Optional: WHATSAPP_APP_SECRET to check the X-Hub-Signature-256 header, WHATSAPP_API_VERSION (v21.0).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Transport } from "@cr/datasources";

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret?: string;
  apiVersion: string;
}

export function whatsappConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WhatsAppConfig | undefined {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim();
  if (!token || !phoneNumberId || !verifyToken) return undefined;
  return { token, phoneNumberId, verifyToken, ...(env.WHATSAPP_APP_SECRET ? { appSecret: env.WHATSAPP_APP_SECRET } : {}), apiVersion: env.WHATSAPP_API_VERSION ?? "v21.0" };
}

/** Meta calls GET with these three query params when you save the webhook URL; echo the challenge on a match. */
export function verifyHandshake(query: URLSearchParams, verifyToken: string): { ok: true; challenge: string } | { ok: false } {
  if (query.get("hub.mode") === "subscribe" && query.get("hub.verify_token") === verifyToken) {
    const challenge = query.get("hub.challenge");
    if (challenge) return { ok: true, challenge };
  }
  return { ok: false };
}

/** X-Hub-Signature-256: sha256=<hmac of the raw body with the app secret>. */
export function signatureValid(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
}

const MessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string().optional(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    /** a forwarded or tapped link arrives as text too; buttons and lists would land here */
    interactive: z.object({ button_reply: z.object({ title: z.string() }).optional(), list_reply: z.object({ title: z.string() }).optional() }).optional(),
  })
  .passthrough();
const WebhookSchema = z
  .object({
    object: z.string().optional(),
    entry: z
      .array(
        z
          .object({
            changes: z
              .array(
                z
                  .object({
                    field: z.string().optional(),
                    value: z
                      .object({
                        messaging_product: z.string().optional(),
                        metadata: z.object({ phone_number_id: z.string().optional(), display_phone_number: z.string().optional() }).passthrough().optional(),
                        messages: z.array(MessageSchema).optional(),
                        statuses: z.array(z.unknown()).optional(),
                      })
                      .passthrough(),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export interface InboundText {
  from: string;
  messageId: string;
  text: string;
  phoneNumberId?: string;
}

/** Every text message in a webhook delivery. Status updates (sent, delivered, read) and media are ignored. */
export function parseInbound(body: unknown): InboundText[] {
  const parsed = WebhookSchema.safeParse(body);
  if (!parsed.success) return [];
  const out: InboundText[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      for (const m of change.value.messages ?? []) {
        const text = m.type === "text" ? m.text?.body : m.type === "interactive" ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : undefined;
        if (!text) continue;
        out.push({ from: m.from, messageId: m.id, text, ...(change.value.metadata?.phone_number_id ? { phoneNumberId: change.value.metadata.phone_number_id } : {}) });
      }
    }
  }
  return out;
}

export class WhatsAppClient {
  constructor(
    private transport: Pick<Transport, "fetchJson">,
    private cfg: WhatsAppConfig,
  ) {}

  private get base() {
    return `https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}`;
  }
  private headers() {
    return { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" };
  }

  /** Sends one text message. WhatsApp caps a text body at 4096 characters; replies here are far shorter. */
  async sendText(to: string, body: string, replyTo?: string): Promise<{ id?: string }> {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: body.slice(0, 4096) },
      ...(replyTo ? { context: { message_id: replyTo } } : {}),
    };
    const r = await this.transport.fetchJson<{ messages?: { id: string }[] }>(`${this.base}/messages`, { method: "POST", headers: this.headers(), body: JSON.stringify(payload) });
    return { ...(r.messages?.[0]?.id ? { id: r.messages[0].id } : {}) };
  }

  /** Blue ticks: marks the inbound message as read. Best effort. */
  async markRead(messageId: string): Promise<void> {
    await this.transport
      .fetchJson(`${this.base}/messages`, { method: "POST", headers: this.headers(), body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }) })
      .catch(() => undefined);
  }
}
