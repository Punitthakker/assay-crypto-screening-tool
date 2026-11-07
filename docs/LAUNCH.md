# Launch checklist - 2026-11-07

What is live, what is one click away, and what only you can do. In order. Nothing here is optional for the WhatsApp number to answer.

## Already live

- Web: https://assay-screening.netlify.app (landing with the WhatsApp CTA and number, /check console). Redeployed today from `apps/web`.
- Repo: `main` carries the bot (`apps/bot`), the identity layer, the trace, behaviour, labels and freeze index. 178 tests green.

## A. Railway: press Deploy (2 minutes)

Project `assay`, environment `production`, has staged changes waiting (non-destructive). Review and press **Deploy**:

1. `assay-api`: source branch `main` (this is why nothing deployed since 2 November), `WATCHMAN_URL`.
2. `watchman`: new service from `moov/watchman:latest` with the free official lists.
3. `assay-bot`: new service from this repo, `ASSAY_SERVICE=@cr/bot`, `PORT=8090`, plus the WhatsApp variables below once you have them.

After the deploy, `assay-bot` needs a public domain (service settings, Networking, Generate domain, port 8090). Its `/health` must answer `{"ok":true,"service":"assay-bot",...}`. Note the domain: it is the webhook URL in step B4.

If `assay-bot` was not staged (the automated session could only stage what it was allowed to), create it by hand: New service, GitHub repo `Punitthakker/assay-crypto-screening-tool`, branch `main`, variables `ASSAY_SERVICE=@cr/bot`, `PORT=8090`, `CR_TRANSPORT=live`, `TRONGRID_API_KEY` (copy from assay-api), `WATCHMAN_URL=http://watchman.railway.internal:8084`, `ASSAY_BOT_SALT=<any long random string>`, `ASSAY_BOT_UNLIMITED_IDS=wa:971564627605`.

## B. Meta: register +971 56 462 7605 on the WhatsApp Business Platform (20 to 40 minutes, your accounts)

The number must not be registered on a WhatsApp or WhatsApp Business app on a phone at the same time; if it is, delete that account first (Settings, Account, Delete my account), or use a number that is free.

1. https://business.facebook.com: a Meta Business portfolio (verify the business later for higher limits; not needed to start).
2. https://developers.facebook.com: create an app, type Business, add the product **WhatsApp**. In WhatsApp, API setup, add the phone number +971564627605 and verify it by SMS or call. Set the display name "Assay". Copy the **Phone number ID** (a long number, not the phone number) into `WHATSAPP_PHONE_NUMBER_ID`.
3. Token: Business settings, Users, System users, add a system user (admin), assign the app with full control, generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`, never expiring. Copy it into `WHATSAPP_TOKEN`. The temporary 24-hour token on the API setup page works for a first test but dies tonight.
4. Webhook: App dashboard, WhatsApp, Configuration. Callback URL `https://<assay-bot domain>/webhook/whatsapp`, Verify token = whatever you put in `WHATSAPP_VERIFY_TOKEN` on Railway (set it first, redeploy, then save the webhook: Meta calls the URL during the save and the bot must be up). Subscribe to the `messages` field.
5. App secret (optional, recommended): App settings, Basic, App secret into `WHATSAPP_APP_SECRET`; the bot then rejects deliveries that are not signed by Meta.
6. Go live: the app must be in **Live** mode (not Development) for people who are not test numbers to message it. Business verification may be required by Meta for that; until then only the up-to-5 test numbers you add on the API setup page can chat with it.

Set on `assay-bot` in Railway: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`. Redeploy. `/health` shows `"whatsapp":"configured"`.

## C. First conversation (2 minutes)

From your own phone, message +971 56 462 7605:

1. `hi` -> the help text (8 lines).
2. `TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX` -> a verdict for a Binance hot wallet on Tron (CLEAR, labelled licensed VASP), with a tronscan link and "2 free checks left today" (unless your id is in `ASSAY_BOT_UNLIMITED_IDS`).
3. `0x0330070FD38Ec3bB94F58FA55D40368271E9e54A on ethereum` -> BLOCK, OFAC and oracle lines.
4. `what does frozen mean` -> the FAQ answer, no check spent.

Railway logs show one line per reply with the hashed id and the time taken. If step 2 takes more than 10 seconds, set `CR_TRACE_EXPAND_CAP=10` on assay-bot (question 5).

## D. Telegram (optional, 3 minutes)

@BotFather, `/newbot`, paste the token into `TELEGRAM_BOT_TOKEN` on `assay-bot`, redeploy. Enable inline mode with `/setinline`. The same conversation answers there.

## E. Known limits on launch day

- Explorer coverage without keys: Tron runs keyed (TronGrid key is set), Ethereum, Base, Arbitrum, Polygon fall back to Blockscout (403 was seen from Railway on Base), BNB Chain has no explorer, Solana has no fund flow. Set `ETHERSCAN_API_KEY` and `HELIUS_API_KEY` on both services to lift that (question 1). The bot states "Fund flow: unavailable" when that is the case, it never pretends.
- Everything in VERIFY.md steps 2 and 4 to 8 has run on fixtures only. The first real conversations are the live verification; keep the report ids from any answer that looks wrong and send them to me.
- The quota is in memory: a redeploy resets everyone's count. Fine for a free tier, not for billing.
- WhatsApp charges per conversation after the free tier Meta gives each number (free service conversations opened by the user are free for 24 hours at the time of writing; check Meta's current pricing page before telling customers it is free).
- The Watchman match line (question 13), the VASP register (question 10) and the indirect-exposure BLOCK band (question 6) are policy choices you have not confirmed. Defaults are conservative and stated in every report.
