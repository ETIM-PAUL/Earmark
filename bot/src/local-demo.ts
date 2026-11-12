import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Quoter } from "@earmark/billers";
import { type Bot, createBot } from "./app.js";
import { wireDemo } from "./demo.js";
import { MockChain } from "./mock/chain.js";
import { ruleModel } from "./mock/rule-model.js";
import { simVtpass } from "./mock/sim-vtpass.js";
import { senderRoute } from "./sender-api.js";

/**
 * The whole bot with nothing real behind it, for `make demo`: a simulated
 * VTpass (one bill per request, instant), a local stand-in for the receipts
 * contract and its RPC, a fixed naira rate and a rule-based reader instead
 * of the NEAR AI model. No keys, no network, no money. It never reads .env.
 *
 * Chats are web chats: the judge page posts to /demo/say and shows the
 * transcript the bot keeps.
 */

export interface LocalDemoOptions {
  /** 0: any free port. */
  botPort?: number;
  chainPort?: number;
  /** Where the web app is served. */
  webUrl?: string;
}

export interface LocalDemo {
  botUrl: string;
  chainUrl: string;
  familyId: string;
  /** The judge view, ready to open. */
  judge: string;
  bot: Bot;
  close: () => Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export async function startLocalDemo(opts: LocalDemoOptions = {}): Promise<LocalDemo> {
  const webUrl = (opts.webUrl ?? "http://localhost:5173").replace(/\/+$/, "");
  const chain = new MockChain();
  const chainUrl = await chain.listen(opts.chainPort ?? 0);
  const sim = simVtpass({ balanceNgn: 1_000_000 });

  let bot: Bot | null = null;
  const demo = wireDemo({
    vtpass: sim.client,
    quoter: new Quoter({
      sources: [{ name: "fixed ₦1,346/$", fetch: async () => 1346 }],
      spreadBps: 150,
      warn: () => {},
    }),
    receipts: chain,
    contractId: chain.contractId,
    floatFloorNgn: 50_000,
    model: ruleModel,
    receiptsPageUrl: `${webUrl}/receipt.html`,
    onOrderUpdate: (o) => bot?.onOrderUpdate(o),
    onOrderWaiting: (o) => bot?.onOrderWaiting(o),
    // The simulated VTpass answers at once and has no 30 s repeat rule.
    executor: { sameBillGapMs: 0, purchase: { requerySchedule: [500, 1_000, 2_000] } },
    tickMs: 5_000,
  });

  const botServer: Server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": webUrl,
      "access-control-allow-headers": "content-type",
    };
    const local = LOOPBACK.has(req.socket.remoteAddress ?? "");
    if (senderRoute(req, res, { demo, webUrl })) return;
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ service: "bot", ok: true, mode: "local-demo" }));
    }
    const view =
      req.method === "GET" && req.url?.match(/^\/demo\/family\?family=(fam_[a-z0-9]{16})$/);
    if (view) {
      bot
        ?.familyView(view[1] as string)
        .then((v) => {
          res.writeHead(200, { ...cors, "content-type": "application/json" });
          res.end(JSON.stringify(v));
        })
        .catch(() => res.writeHead(500).end());
      return;
    }
    // The recipient's side of the chat, for the judge page.
    if (req.method === "POST" && req.url === "/demo/say") {
      if (!local) return void res.writeHead(403, cors).end();
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString("utf8").slice(0, 2_000);
      });
      req.on("end", () => {
        const { family, text } = (() => {
          try {
            return JSON.parse(body) as { family?: unknown; text?: unknown };
          } catch {
            return {};
          }
        })();
        if (
          typeof family !== "string" ||
          !/^fam_[a-z0-9]{16}$/.test(family) ||
          typeof text !== "string"
        ) {
          return void res.writeHead(400, cors).end();
        }
        void bot?.onMessage(`web:${family}`, text);
        res.writeHead(202, cors).end();
      });
      return;
    }
    res.writeHead(404, cors).end();
  });
  await new Promise<void>((ok) => botServer.listen(opts.botPort ?? 0, "127.0.0.1", ok));
  const botUrl = `http://127.0.0.1:${(botServer.address() as AddressInfo).port}`;

  bot = createBot({
    demo,
    // Web chats are shown from the transcript; there is nowhere else to send.
    send: async () => {},
    links: { webUrl, botUrl },
  });

  // One demo family, with its chat already connected through its invite.
  const invite = bot.newInvite("Ada");
  await bot.onMessage(`web:${invite.familyId}`, `/start ${invite.code}`);
  await bot.idle();
  const judge =
    `${webUrl}/judge.html?network=testnet&contract=${chain.contractId}` +
    `&family=${invite.familyId}&bot=${encodeURIComponent(botUrl)}&rpc=${encodeURIComponent(chainUrl)}`;

  return {
    botUrl,
    chainUrl,
    familyId: invite.familyId,
    judge,
    bot,
    close: async () => {
      await new Promise<void>((ok) => botServer.close(() => ok()));
      await chain.close();
    },
  };
}
