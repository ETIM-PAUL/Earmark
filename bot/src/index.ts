import { createServer } from "node:http";
import { CATEGORIES } from "@earmark/shared";

// Assistant skeleton. Owner: Assistant. Phase 10 fills this in: Telegram
// and WhatsApp webhooks, and the NEAR AI Cloud model that turns messages
// into orders. The model never approves a payment; rules run in code.

const port = Number(process.env.BOT_PORT ?? 4003);

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "bot", ok: true, categories: CATEGORIES }));
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, () => console.log(`bot listening on :${port}`));
