import { createServer } from "node:http";
import { readEnv, vtpassEnv } from "@earmark/config";
import { CATEGORIES } from "@earmark/shared";
import { VtpassClient } from "./client.js";
import { checkPurchase } from "./purchase.js";
import { parseWebhook, WEBHOOK_ACK } from "./webhook.js";

// Biller service. Phase 6 serves health and the VTpass webhook; Phase 9
// adds quotes, the float guard and the purchase API for the order service.

const port = Number(process.env.BILLERS_PORT ?? 4002);
const cfg = readEnv(vtpassEnv);
const vtpass = new VtpassClient({
  baseUrl: cfg.VTPASS_BASE_URL,
  apiKey: cfg.VTPASS_API_KEY,
  publicKey: cfg.VTPASS_PUBLIC_KEY,
  secretKey: cfg.VTPASS_SECRET_KEY,
});
const MAX_BODY = 64 * 1024;

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

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
