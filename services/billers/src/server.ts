import { createServer } from "node:http";
import { billersEnv, readEnv, vtpassEnv } from "@earmark/config";
import { CATEGORIES, NgnKobo } from "@earmark/shared";
import { VtpassClient } from "./client.js";
import { FloatGuard } from "./float.js";
import { checkPurchase } from "./purchase.js";
import { DEFAULT_RATE_SOURCES, Quoter, QuoteUnavailableError } from "./quote.js";
import { parseWebhook, WEBHOOK_ACK } from "./webhook.js";

// Biller service: health, naira quotes, the float guard and the VTpass
// webhook. The order executor (executor.ts) runs inside the order service
// once Phase 8 gives it a database and refunds.

const port = Number(process.env.BILLERS_PORT ?? 4002);
const cfg = readEnv(vtpassEnv);
const vtpass = new VtpassClient({
  baseUrl: cfg.VTPASS_BASE_URL,
  apiKey: cfg.VTPASS_API_KEY,
  publicKey: cfg.VTPASS_PUBLIC_KEY,
  secretKey: cfg.VTPASS_SECRET_KEY,
});
const knobs = readEnv(billersEnv);
const quoter = new Quoter({ sources: DEFAULT_RATE_SOURCES, spreadBps: knobs.QUOTE_SPREAD_BPS });
const float = new FloatGuard({
  balance: () => vtpass.balance(),
  floorKobo: knobs.VTPASS_FLOAT_FLOOR_NGN * 100,
});
const MAX_BODY = 64 * 1024;

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * POST /quotes { amountNgnKobo } → the quote, or 503 with a message for the
 * recipient when we can't price or can't afford the bill right now.
 */
async function handleQuote(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) {
  let amount: number;
  try {
    amount = NgnKobo.positive().parse(JSON.parse(await readBody(req)).amountNgnKobo);
  } catch {
    json(res, 400, { error: "send { amountNgnKobo: positive integer }" });
    return;
  }
  const guard = await float.check(amount);
  if (!guard.ok) {
    json(res, 503, { error: guard.reason, recipient: guard.recipient });
    return;
  }
  try {
    json(res, 200, await quoter.quote(amount));
  } catch (e) {
    if (!(e instanceof QuoteUnavailableError)) throw e;
    json(res, 503, { error: "no_rate", recipient: e.recipient });
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, {
      service: "billers",
      ok: true,
      vtpass: vtpass.isSandbox ? "sandbox" : "live",
      categories: CATEGORIES,
    });
    return;
  }

  if (req.method === "POST" && req.url === "/quotes") {
    handleQuote(req, res).catch((e) => {
      console.error("quote failed", e);
      if (!res.headersSent) json(res, 500, { error: "internal" });
    });
    return;
  }

  if (req.method === "GET" && req.url === "/float") {
    float
      .check(0)
      .then((r) => json(res, 200, { ...r, floorKobo: knobs.VTPASS_FLOAT_FLOOR_NGN * 100 }))
      .catch(() => json(res, 500, { error: "internal" }));
    return;
  }

  if (req.method === "POST" && req.url === "/webhooks/vtpass") {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      // Acknowledge first, as VTpass asks; the requery runs afterwards.
      json(res, 200, WEBHOOK_ACK);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        console.warn("vtpass webhook: body is not JSON; ignored");
        return;
      }
      const event = parseWebhook(body);
      if (event.type === "ignored") {
        console.warn(`vtpass webhook ignored: ${event.why}`);
        return;
      }
      checkPurchase(vtpass, event.requestId)
        .then((o) => console.log(`vtpass webhook ${event.requestId}: ${o.kind}`))
        .catch((e) => console.error(`vtpass webhook ${event.requestId}: requery failed`, e));
    });
    return;
  }

  res.writeHead(404).end();
});

server.listen(port, () => {
  console.log(`billers listening on :${port} (VTpass ${vtpass.isSandbox ? "sandbox" : "LIVE"})`);
});
