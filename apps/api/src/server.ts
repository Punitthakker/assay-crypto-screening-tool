/**
 * Assay API - Phase 1 minimal service.
 *   GET  /health            liveness + transport mode
 *   POST /v1/screen         { address, chain, asset, amount?, tokenContract?, originator? } -> Report
 *   GET  /v1/chains         registry summary
 * Optional: ASSAY_API_KEY env makes x-api-key mandatory. In-memory rate limit 30 req/min per IP.
 */
import { createServer } from "node:http";
import path from "node:path";
import { Engine } from "@cr/engine";
import { LabelStore, transportFromEnv } from "@cr/datasources";
import { CHAINS, ENABLED_CHAINS, TOKENS, DISCLAIMER } from "@cr/shared";
import { selfTest } from "./selftest.js";

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);

const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.ASSAY_API_KEY;
const transport = transportFromEnv(process.env);
const engine = new Engine({ transport, labels: new LabelStore(), env: process.env });
const started = new Date().toISOString();

const hits = new Map<string, { n: number; t: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 60_000) { hits.set(ip, { n: 1, t: now }); return false; }
  h.n++;
  return h.n > 30;
}

function send(res: import("node:http").ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-api-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
  });
  res.end(json);
}

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) { chunks.push(c as Buffer); if (chunks.reduce((a, b) => a + b.length, 0) > 64_000) throw new Error("body too large"); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "?";
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (url.pathname === "/health" || url.pathname === "/") {
    return send(res, 200, { ok: true, service: "assay-api", transport: transport.mode, chains: ENABLED_CHAINS, started, disclaimer: DISCLAIMER });
  }
  if (url.pathname === "/v1/chains") {
    return send(res, 200, { chains: ENABLED_CHAINS.map((id) => ({ id, name: CHAINS[id].name, family: CHAINS[id].family, tokens: TOKENS.filter((t) => t.chain === id).map((t) => ({ symbol: t.symbol, onChainSymbol: t.onChainSymbol, issuer: t.issuer, kind: t.kind, address: t.address })) })) });
  }
  if (url.pathname === "/v1/screen" && req.method === "POST") {
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) return send(res, 401, { error: "invalid api key" });
    if (limited(ip)) return send(res, 429, { error: "rate limit: 30 requests per minute" });
    try {
      const body = await readJson(req);
      const t0 = Date.now();
      const report = await engine.screen(body);
      return send(res, 200, { ...report, ms: Date.now() - t0 });
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return send(res, 404, { error: "not found" });
});

server.listen(PORT, () => { console.log(`assay-api listening on :${PORT} transport=${transport.mode}`); if (process.env.ASSAY_SELFTEST !== "0") selfTest(transport).catch((e) => console.error("[selftest] failed", e)); });
