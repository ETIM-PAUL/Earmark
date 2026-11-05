import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  billersEnv,
  isConfigured,
  nearAiEnv,
  readEnv,
  telegramEnv,
  twilioEnv,
  vtpassEnv,
} from "@earmark/config";
import type { Order } from "@earmark/shared";
import { Telegram, WhatsApp } from "./channels.js";
import { type Lang, say } from "./copy.js";
import { demoPorts } from "./demo.js";
import { Dialog, newSession, type Session, updateMessage } from "./dialog.js";
import { NearAiModel } from "./model.js";

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
  throw new Error(`no channel for ${kind}`);
}

// ── Sessions, one message at a time per chat ───────────────────────────

const sessions = new Map<string, Session>();
const queues = new Map<string, Promise<void>>();
const chatOfFamily = new Map<string, string>();
const announced = new Set<string>();

function serial(chat: string, job: () => Promise<void>): Promise<void> {
  const run = (queues.get(chat) ?? Promise.resolve()).then(job, job);
  queues.set(
    chat,
    run.catch(() => {}),
  );
  return run;
}

const langOf = (chat: string): Lang => sessions.get(chat)?.lang ?? "en";

function onOrderUpdate(o: Order): void {
  const chat = chatOfFamily.get(o.familyId);
  if (!chat) return;
  const out: string[] = [];
  if ((o.status === "fulfilled" || o.status === "refunded") && !announced.has(o.id)) {
    announced.add(o.id);
    const msg = updateMessage(o, langOf(chat), null);
    if (msg) out.push(msg);
  }
  const link = receiptLink(o);
  if (link && !announced.has(`${o.id}:receipt`)) {
    announced.add(`${o.id}:receipt`);
    out.push(say(langOf(chat), "receipt", { link }));
  }
  for (const text of out) {
    send(chat, text).catch((e) => console.error(`notify ${chat} failed: ${String(e)}`));
  }
}

const { ports, receiptLink } = await demoPorts({
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
  onOrderUpdate,
});
const dialog = new Dialog(ports);

async function onMessage(chat: string, text: string | null): Promise<void> {
  return serial(chat, async () => {
    const session = sessions.get(chat) ?? newSession();
    let replies: string[];
    if (text === null) {
      replies = [say(session.lang, "textOnly")];
    } else if (/^\/start\b/.test(text)) {
      const family = await ports.family(chat);
      if (family) chatOfFamily.set(family.familyId, chat);
      replies = [
        say(session.lang, family ? "help" : "notConnected", { sender: family?.senderName ?? "" }),
      ];
    } else {
      const family = await ports.family(chat);
      if (family) chatOfFamily.set(family.familyId, chat);
      const turn = await dialog.handle(chat, session, text);
      sessions.set(chat, turn.session);
      replies = turn.replies;
    }
    for (const r of replies) await send(chat, r);
  });
}

// ── HTTP: health and the Twilio webhook ───────────────────────────────

const server = createServer((req, res) => {
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
        onMessage(`wa:${msg.from}`, msg.text).catch((e) => console.error(`whatsapp: ${String(e)}`));
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
  const name = await telegram.start();
  console.log(`Telegram: polling as @${name}`);
  void telegram.poll(onMessage);
}
