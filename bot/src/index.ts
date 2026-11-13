import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  agentApiEnv,
  billersEnv,
  isConfigured,
  nearAiEnv,
  nearEnv,
  readEnv,
  telegramEnv,
  twilioEnv,
  vtpassEnv,
} from "@earmark/config";
import { createAgentApi } from "@near-intents-agent-api/sdk";
import { SenderAccounts } from "./accounts.js";
import { createAgentApiPayer } from "./agent-payer.js";
import { apiRoute } from "./api.js";
import { type Bot, createBot } from "./app.js";
import { Telegram, WhatsApp } from "./channels.js";
import { demoPorts } from "./demo.js";
import { NearAiModel } from "./model.js";
import { Monitor } from "./monitor.js";
import { Passkeys } from "./passkeys.js";
import { senderRoute } from "./sender-api.js";
import { FamilyTeam } from "./team.js";

// The assistant: Telegram (long polling) and WhatsApp (Twilio webhook) in
// front of one dialog engine. Demo mode until the order service lands.
//
//   pnpm --filter @earmark/bot start      (after pnpm build)

const ROOT = resolve(import.meta.dirname, "../..");
try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  // fall back to the process environment
}

const port = Number(process.env.BOT_PORT ?? 4003);
/** Public https URL that Twilio posts to, e.g. an ngrok tunnel. Needed to check signatures. */
const publicUrl = process.env.BOT_PUBLIC_URL?.replace(/\/+$/, "");

const ai = readEnv(nearAiEnv);
const vt = readEnv(vtpassEnv);
const knobs = readEnv(billersEnv);
const model = new NearAiModel({
  baseUrl: ai.NEAR_AI_BASE_URL,
  apiKey: ai.NEAR_AI_API_KEY,
  model: ai.NEAR_AI_MODEL,
});

const telegram = isConfigured(telegramEnv)
  ? new Telegram(readEnv(telegramEnv).TELEGRAM_BOT_TOKEN)
  : null;
const whatsapp = isConfigured(twilioEnv)
  ? (() => {
      const t = readEnv(twilioEnv);
      return new WhatsApp({
        accountSid: t.TWILIO_ACCOUNT_SID,
        authToken: t.TWILIO_AUTH_TOKEN,
        from: t.TWILIO_WHATSAPP_FROM,
      });
    })()
  : null;

async function send(chat: string, text: string): Promise<void> {
  const [kind, id = ""] = chat.split(/:(.*)/s);
  if (kind === "tg" && telegram) return telegram.send(id, text);
  if (kind === "wa" && whatsapp) return whatsapp.send(id, text);
  // The deployed judge page's "type as the recipient" box: shown through
  // the transcript GET endpoint, not sent anywhere.
  if (kind === "web") return;
  throw new Error(`no channel for ${kind}`);
}

// ── Alerts: console, plus a Telegram chat for the lead when configured ──

const alertChat = process.env.ALERTS_TELEGRAM_CHAT_ID?.trim();
const monitor = new Monitor({
  send: (msg) => {
    console.error(`ALERT ${msg}`);
    if (telegram && alertChat) {
      telegram
        .send(alertChat, `⚠️ Earmark: ${msg}`)
        .catch((e) => console.error(`alert to Telegram failed: ${String(e)}`));
    }
  },
});

// The bot and the demo need each other: the demo tells the bot when an
// order moves, the bot reads the demo's ports.
let bot: Bot | null = null;
const webUrl = (process.env.WEB_APP_URL ?? "http://localhost:5173").replace(/\/+$/, "");
// Sender sign-in and approval signatures: passkeys, verified here.
const accounts = new SenderAccounts();
const team = new FamilyTeam(accounts);
const passkeys = new Passkeys({
  rpID: new URL(webUrl).hostname,
  rpName: "Earmark",
  origin: new URL(webUrl).origin,
  accounts,
});
// Real settlement through the Agent API, from `pnpm setup:agent-production`.
// Off by default: every other run stays on the simulated payer, as before.
async function realPayer() {
  if (process.env.AGENT_API_REAL_PAYMENTS !== "true") return {};
  const state = JSON.parse(
    await readFile(resolve(ROOT, ".earmark/agent-production.json"), "utf8"),
  ) as { agentId: string; grantToken: string; usdcAssetId: string };
  const agentApi = createAgentApi({
    apiKey: readEnv(agentApiEnv).NEAR_INTENTS_AGENT_API_KEY,
    baseUrl: readEnv(agentApiEnv).NEAR_INTENTS_AGENT_API_URL,
  });
  const settlementAccountId = readEnv(nearEnv).SETTLEMENT_ACCOUNT_ID;
  return {
    payer: createAgentApiPayer({
      api: agentApi,
      agentId: state.agentId,
      grantToken: state.grantToken,
      usdcAssetId: state.usdcAssetId,
      settlementAccountId,
    }),
    settlementAccountId,
  };
}

const demo = await demoPorts({
  verifyOwner: (o, d, p) => passkeys.verifyDecision(o, d, p),
  vtpass: {
    baseUrl: vt.VTPASS_BASE_URL,
    apiKey: vt.VTPASS_API_KEY,
    publicKey: vt.VTPASS_PUBLIC_KEY,
    secretKey: vt.VTPASS_SECRET_KEY,
  },
  spreadBps: knobs.QUOTE_SPREAD_BPS,
  floatFloorNgn: knobs.VTPASS_FLOAT_FLOOR_NGN,
  model,
  testnetStateFile: resolve(ROOT, ".earmark/receipts-testnet.json"),
  receiptsPageUrl: `${webUrl}/receipt.html`,
  onOrderUpdate: (o) => bot?.onOrderUpdate(o),
  onOrderWaiting: (o) => bot?.onOrderWaiting(o),
  alert: (m) => monitor.alert(m),
  ...(await realPayer()),
});

const botName = telegram ? await telegram.start() : null;
const whatsappNumber = isConfigured(twilioEnv)
  ? readEnv(twilioEnv).TWILIO_WHATSAPP_FROM.replace(/^whatsapp:/, "")
  : null;

bot = createBot({
  demo,
  send,
  monitor,
  links: { telegramBot: botName, whatsappNumber, webUrl, botUrl: `http://localhost:${port}` },
});
const app = bot;

// Float, stuck orders and failure rate, every minute.
setInterval(() => {
  app.check().catch((e) => monitor.alert(`monitor check failed: ${String(e)}`, "monitor"));
}, 60_000).unref();

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// ── HTTP: health and the Twilio webhook ───────────────────────────────

const server = createServer((req, res) => {
  if (senderRoute(req, res, { demo, webUrl })) return;
  if (
    apiRoute(req, res, {
      demo,
      bot: app,
      accounts,
      passkeys,
      team,
      webUrl,
      config: { network: "testnet", contractId: demo.contractId, rpcUrl: null },
      // A new family has no Telegram or WhatsApp of its own yet; connect its
      // web chat (the deployed judge page's "type as the recipient" box) so
      // it works right away, same as local demo mode.
      afterFamilyCreated: async (familyId) => {
        const code = app?.inviteFor(familyId).code;
        await app
          ?.onMessage(`web:${familyId}`, `/start ${code}`)
          .catch((e) => console.error(`web chat connect failed: ${String(e)}`));
      },
    })
  )
    return;
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        service: "bot",
        ok: true,
        telegram: !!telegram,
        whatsapp: !!whatsapp,
        model: ai.NEAR_AI_MODEL,
      }),
    );
    return;
  }
  // Orders by status, stuck orders, float and alerts. Local only.
  if (req.method === "GET" && req.url === "/status") {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
      res.writeHead(403).end();
      return;
    }
    app
      .check()
      .then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(monitor.status(), null, 2));
      })
      .catch(() => res.writeHead(500).end());
    return;
  }
  // Local only until the sender app (Phase 12) makes invites behind sign-in.
  if (req.method === "POST" && req.url === "/invites") {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
      res.writeHead(403).end();
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8").slice(0, 1_000);
    });
    req.on("end", () => {
      let senderName: string | undefined;
      try {
        const n = (JSON.parse(body || "{}") as { senderName?: unknown }).senderName;
        if (typeof n === "string" && /^[\p{L} .'-]{1,40}$/u.test(n)) senderName = n;
      } catch {
        // no name: the demo default
      }
      res.writeHead(201, { "content-type": "application/json" });
      const { code: _code, ...invite } = app.newInvite(senderName);
      res.end(JSON.stringify(invite));
    });
    return;
  }

  // The judge view: the chat (long numbers masked) and each receipt's tx
  // hash, which the page then checks on-chain itself. Demo families only.
  const t = req.method === "GET" && req.url?.match(/^\/demo\/family\?family=(fam_[a-z0-9]{16})$/);
  if (t) {
    const familyId = t[1] as string;
    app
      .familyView(familyId)
      .then((view) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": webUrl,
        });
        res.end(JSON.stringify(view));
      })
      .catch(() => res.writeHead(500).end());
    return;
  }
  if (req.method === "OPTIONS" && req.url === "/demo/say") {
    res.writeHead(204, {
      "access-control-allow-origin": webUrl,
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }
  // The recipient's side of the chat, for the deployed judge page: it has
  // no Telegram or WhatsApp of its own, so typing there posts here.
  if (req.method === "POST" && req.url === "/demo/say") {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8").slice(0, 2_000);
    });
    req.on("end", () => {
      const cors = { "access-control-allow-origin": webUrl };
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
      app.onMessage(`web:${family}`, text).catch((e) => console.error(`demo chat: ${String(e)}`));
      res.writeHead(202, cors).end();
    });
    return;
  }

  if (req.method === "POST" && req.url === "/webhooks/whatsapp") {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const signed =
        whatsapp && publicUrl
          ? whatsapp.verify(
              `${publicUrl}/webhooks/whatsapp`,
              params,
              req.headers["x-twilio-signature"] as string | undefined,
            )
          : false;
      // Empty TwiML: replies go out through the REST API, like later updates.
      res.writeHead(signed ? 200 : 403, { "content-type": "text/xml" });
      res.end("<Response/>");
      if (!signed) {
        console.warn("whatsapp webhook: bad or missing signature (is BOT_PUBLIC_URL set?)");
        return;
      }
      const msg = WhatsApp.chatOf(params);
      if (msg)
        app
          .onMessage(`wa:${msg.from}`, msg.text, msg.id)
          .catch((e) => console.error(`whatsapp: ${String(e)}`));
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, () => {
  console.log(
    `bot listening on :${port} (model ${ai.NEAR_AI_MODEL}, VTpass sandbox, demo families)`,
  );
  if (whatsapp) {
    console.log(
      publicUrl
        ? `WhatsApp webhook: ${publicUrl}/webhooks/whatsapp (set it in the Twilio sandbox settings)`
        : "WhatsApp: set BOT_PUBLIC_URL to a public https URL (e.g. ngrok) to receive messages",
    );
  }
});

if (telegram) {
  console.log(`Telegram: polling as @${botName}`);
  void telegram.poll(app.onMessage);
}

const first = app.newInvite();
await app
  .onMessage(`web:${first.familyId}`, `/start ${first.code}`)
  .catch((e) => console.error(`web chat connect failed: ${String(e)}`));
console.log("Demo family ready. Open the invite link on your phone:");
if (first.telegram) console.log(`  Telegram: ${first.telegram}`);
if (first.whatsapp) console.log(`  WhatsApp: ${first.whatsapp}`);
if (first.judge) console.log(`  Judge view: ${first.judge}`);
console.log(`More: curl -X POST localhost:${port}/invites -d '{"senderName":"Ada"}'`);
