import { createServer } from "node:http";
import { CATEGORIES } from "@earmark/shared";

// Order service skeleton. Owner: Money rails. Phases 8 and 11 fill this in:
// rule checks, the order lifecycle, refunds and reconciliation.

const port = Number(process.env.ORDERS_PORT ?? 4001);

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "orders", ok: true, categories: CATEGORIES }));
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, () => console.log(`orders listening on :${port}`));
