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
import { InviteStore, inviteCodeIn, inviteLinks } from "./invites.js";
import { NearAiModel } from "./model.js";
import { maskRef } from "./providers.js";

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
const invites = new InviteStore();

function serial(chat: string, job: () => Promise<void>): Promise<void> {
  const run = (queues.get(chat) ?? Promise.resolve()).then(job, job);
  queues.set(
    chat,
    run.catch(() => {}),
  );
  return run;
}

const langOf = (chat: string): Lang => sessions.get(chat)?.lang ?? "en";

// ── Judge view transcript: demo families only, long numbers masked ─────

type Line = { from: "recipient" | "bot"; text: string; at: string };
const transcripts = new Map<string, Line[]>();
const maskNumbers = (text: string) =>
  text.replace(/\d[\d ]{5,}\d/g, (m) => maskRef(m.replace(/ /g, "")));

function record(chat: string, from: Line["from"], text: string): void {
  const familyId = [...chatOfFamily].find(([, c]) => c === chat)?.[0];
  if (!familyId) return;
  const lines = transcripts.get(familyId) ?? [];
  lines.push({ from, text: maskNumbers(text), at: new Date().toISOString() });
  transcripts.set(familyId, lines.slice(-100));
}

async function deliver(chat: string, text: string): Promise<void> {
  record(chat, "bot", text);
  await send(chat, text);
}

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
    deliver(chat, text).catch((e) => console.error(`notify ${chat} failed: ${String(e)}`));
  }
}

const webUrl = (process.env.WEB_APP_URL ?? "http://localhost:5173").replace(/\/+$/, "");
const demo = await demoPorts({
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
  onOrderUpdate,
});
const { ports, receiptLink } = demo;
const dialog = new Dialog(ports);

async function onMessage(chat: string, text: string | null): Promise<void> {
  return serial(chat, async () => {
    const session = sessions.get(chat) ?? newSession();
    const code = text ? inviteCodeIn(text) : null;
    let replies: string[];
    if (code) {
      // An invite link: connect this chat to the family that made it.
      const r = invites.redeem(code, chat);
      if (r.ok && demo.connect(chat, r.familyId)) {
        chatOfFamily.set(r.familyId, chat);
        record(chat, "recipient", "(opened the invite link)");
        const family = await ports.family(chat);
        const sender = family?.senderName ?? "";
        replies = [
          `${say(session.lang, "connected", { sender })}\n\n${say(session.lang, "help", { sender })}`,
        ];
      } else {
        replies = [say(session.lang, "inviteBad")];
      }
    } else if (text === null) {
      replies = [say(session.lang, "textOnly")];
    } else if (/^\/start\b/.test(text)) {
      const family = await ports.family(chat);
      replies = [
        say(session.lang, family ? "help" : "notConnected", { sender: family?.senderName ?? "" }),
      ];
    } else {
      record(chat, "recipient", text);
      const turn = await dialog.handle(chat, session, text);
      sessions.set(chat, turn.session);
      replies = turn.replies;
    }
    for (const r of replies) await deliver(chat, r);
  });
}

const botName = telegram ? await telegram.start() : null;
const whatsappNumber = isConfigured(twilioEnv)
  ? readEnv(twilioEnv).TWILIO_WHATSAPP_FROM.replace(/^whatsapp:/, "")
  : null;

/** A demo family and its invite. The sender app calls this in Phase 12. */
function newInvite(senderName?: string) {
  const family = demo.createFamily(senderName);
  const invite = invites.create(family.familyId);
  const links = inviteLinks(invite.code, { telegramBot: botName, whatsappNumber });
  const contract = demo.contractId;
  return {
    familyId: family.familyId,
    expiresAt: invite.expiresAt,
    ...links,
    feed: contract
      ? `${webUrl}/receipt.html?network=testnet&contract=${contract}&family=${family.familyId}`
      : null,
    judge: contract
      ? `${webUrl}/judge.html?network=testnet&contract=${contract}&family=${family.familyId}&bot=http://localhost:${port}`
      : null,
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

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
      res.end(JSON.stringify(newInvite(senderName)));
    });
    return;
  }

  // The judge view: the chat (long numbers masked) and each receipt's tx
  // hash, which the page then checks on-chain itself. Demo families only.
  const t = req.method === "GET" && req.url?.match(/^\/demo\/family\?family=(fam_[a-z0-9]{16})$/);
  if (t) {
    const familyId = t[1] as string;
    ports
      .recent(familyId, 50)
      .then((orders) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": webUrl,
        });
        res.end(
          JSON.stringify({
            transcript: transcripts.get(familyId) ?? [],
            receipts: orders
              .filter((o) => o.receiptTxHash && !o.receiptTxHash.includes(":"))
              .map((o) => ({ orderId: o.id, txHash: o.receiptTxHash })),
          }),
        );
      })
      .catch(() => res.writeHead(500).end());
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
  console.log(`Telegram: polling as @${botName}`);
  void telegram.poll(onMessage);
}

const first = newInvite();
console.log("Demo family ready. Open the invite link on your phone:");
if (first.telegram) console.log(`  Telegram: ${first.telegram}`);
if (first.whatsapp) console.log(`  WhatsApp: ${first.whatsapp}`);
if (first.judge) console.log(`  Judge view: ${first.judge}`);
console.log(`More: curl -X POST localhost:${port}/invites -d '{"senderName":"Ada"}'`);
