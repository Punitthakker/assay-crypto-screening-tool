/**
 * Telegram transport on grammY, long polling (no public URL needed). Same Conversation as WhatsApp.
 * Commands: /start /help, /check <input> [chain] [asset] [amount], /trace (alias of /check), plain text.
 * Inline mode: @bot <address> answers with the verdict as an article the user can send into any chat.
 * Required env: TELEGRAM_BOT_TOKEN.
 */
import { Bot, InlineQueryResultBuilder } from "grammy";
import type { Conversation } from "./conversation.js";

export function startTelegram(token: string, conversation: Conversation, log: (s: string) => void = console.log): Bot {
  const bot = new Bot(token);
  const answer = async (userId: string, text: string) => conversation.reply({ userId: `tg:${userId}`, text, transport: "telegram" });

  bot.command(["start", "help"], async (ctx) => {
    await ctx.reply(await answer(String(ctx.from?.id ?? ctx.chat.id), "/help"), { link_preview_options: { is_disabled: true } });
  });
  bot.command(["check", "trace"], async (ctx) => {
    const text = ctx.match?.toString().trim() || "/help";
    await ctx.reply(await answer(String(ctx.from?.id ?? ctx.chat.id), text), { link_preview_options: { is_disabled: true } });
  });
  bot.on("message:text", async (ctx) => {
    // in groups only react to commands and to messages that carry something screenable; stay quiet otherwise
    const text = ctx.message.text;
    if (ctx.chat.type !== "private" && !/0x[0-9a-fA-F]{40}|\bT[1-9A-HJ-NP-Za-km-z]{33}\b|https?:\/\//.test(text)) return;
    await ctx.reply(await answer(String(ctx.from.id), text), { link_preview_options: { is_disabled: true } });
  });
  bot.on("inline_query", async (ctx) => {
    const q = ctx.inlineQuery.query.trim();
    if (q.length < 20) return ctx.answerInlineQuery([], { cache_time: 0 });
    const text = await answer(String(ctx.from.id), q);
    const title = text.split("\n")[0] ?? "Assay";
    await ctx.answerInlineQuery([InlineQueryResultBuilder.article("assay-1", title, { description: "Assay verdict" }).text(text, { link_preview_options: { is_disabled: true } })], { cache_time: 0, is_personal: true });
  });
  bot.catch((err) => log(`[telegram] ${err.message}`));
  void bot.start({ onStart: (me) => log(`[telegram] polling as @${me.username}`) });
  return bot;
}
