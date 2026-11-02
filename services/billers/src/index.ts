import { createServer } from "node:http";
import { CATEGORIES } from "@earmark/shared";

// Biller service skeleton. Owner: Billers. Phases 6 and 9 fill this in:
// VTpass purchases, requery, naira quotes and the float guard.

const port = Number(process.env.BILLERS_PORT ?? 4002);

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "billers", ok: true, categories: CATEGORIES }));
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, () => console.log(`billers listening on :${port}`));
