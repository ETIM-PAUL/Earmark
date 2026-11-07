import type { Order } from "@earmark/shared";
import { COPY, type Lang, say } from "./copy.js";
import type { DemoWiring } from "./demo.js";
import { Dialog, newSession, type Session, updateMessage } from "./dialog.js";
import { InviteStore, inviteCodeIn, inviteLinks } from "./invites.js";
import { RateLimiter, SeenIds } from "./limits.js";
import { Monitor } from "./monitor.js";
import { maskRef } from "./providers.js";

/**
 * The bot without its transports: sessions, one message at a time per chat,
 * invites, order updates, the judge-view transcript, the rate limit and the
 * monitor. index.ts puts Telegram, WhatsApp and HTTP in front of it; the
 * failure drills drive it directly.
 */

export interface BotOptions {
  demo: DemoWiring;
  /** Sends one message to "tg:<id>" or "wa:<+234…>". */
  send: (chat: string, text: string) => Promise<void>;
  links?: {
    telegramBot?: string | null;
    whatsappNumber?: string | null;
    /** e.g. http://localhost:5173 */
    webUrl?: string;
    /** Where the judge view reads the chat from, e.g. http://localhost:4003 */
    botUrl?: string;
  };
  limiter?: RateLimiter;
  monitor?: Monitor;
}

export type Line = { from: "recipient" | "bot"; text: string; at: string };

const BUSY = new Set(Object.values(COPY.busy));

export function createBot(opts: BotOptions) {
  const { demo, send } = opts;
  const { ports } = demo;
  const dialog = new Dialog(ports);
  const limiter = opts.limiter ?? new RateLimiter();
  const monitor = opts.monitor ?? new Monitor();
  const seen = new SeenIds();
  const invites = new InviteStore();

  const sessions = new Map<string, Session>();
  const queues = new Map<string, Promise<void>>();
  const chatOfFamily = new Map<string, string>();
  const announced = new Set<string>();
  const transcripts = new Map<string, Line[]>();

  /** One job at a time per chat: messages, and the updates that follow them. */
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

  /** Queued behind the chat's current message, so "Done!" never beats "Paying now". */
  function notify(chat: string, texts: string[]): void {
    if (texts.length === 0) return;
    void serial(chat, async () => {
      for (const t of texts) await deliver(chat, t);
    }).catch((e) => {
      monitor.count("botErrors");
      console.error(`notify ${chat} failed: ${String(e)}`);
    });
  }

  function onOrderUpdate(o: Order): void {
    const chat = chatOfFamily.get(o.familyId);
    if (!chat) return;
    const out: string[] = [];
    const final = ["fulfilled", "refunded", "rejected", "declined", "expired"].includes(o.status);
    if (final && !announced.has(o.id)) {
      announced.add(o.id);
      const msg = updateMessage(o, langOf(chat), null);
      if (msg) out.push(msg);
    }
    const link = demo.receiptLink(o);
    if (link && !announced.has(`${o.id}:receipt`)) {
      announced.add(`${o.id}:receipt`);
      out.push(say(langOf(chat), "receipt", { link }));
    }
    notify(chat, out);
  }

  /** Once per order: it's taking a while, don't pay again. */
  function onOrderWaiting(o: Order): void {
    const chat = chatOfFamily.get(o.familyId);
    if (!chat || announced.has(o.id) || announced.has(`${o.id}:waiting`)) return;
    announced.add(`${o.id}:waiting`);
    notify(chat, [say(langOf(chat), "checking")]);
  }

  /**
   * One incoming message. `messageId` (Telegram update ID, Twilio
   * MessageSid) drops redelivered copies.
   */
  async function onMessage(chat: string, text: string | null, messageId?: string): Promise<void> {
    if (messageId && !seen.first(messageId)) {
      monitor.count("duplicates");
      return;
    }
    monitor.count("messages");
    const admit = limiter.admit(chat);
    if (admit !== "ok") {
      monitor.count("rateLimited");
      if (admit === "warn") notify(chat, [say(langOf(chat), "slowDown")]);
      return;
    }
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
          say(session.lang, family ? "help" : "notConnected", {
            sender: family?.senderName ?? "",
          }),
        ];
      } else {
        record(chat, "recipient", text);
        try {
          const turn = await dialog.handle(chat, session, text);
          sessions.set(chat, turn.session);
          replies = turn.replies;
        } catch (e) {
          monitor.count("botErrors");
          monitor.alert(`bot error: ${String(e)}`, "bot-error");
          replies = [say(session.lang, "busy")];
        }
        if (replies.some((r) => BUSY.has(r))) monitor.count("modelBusy");
      }
      for (const r of replies) await deliver(chat, r);
    });
  }

  /** A demo family and its invite. The sender app calls this in Phase 12. */
  function newInvite(senderName?: string) {
    const family = demo.createFamily(senderName);
    const invite = invites.create(family.familyId);
    const l = opts.links ?? {};
    const links = inviteLinks(invite.code, {
      telegramBot: l.telegramBot ?? null,
      whatsappNumber: l.whatsappNumber ?? null,
    });
    const contract = demo.contractId;
    const web = l.webUrl ?? "http://localhost:5173";
    return {
      familyId: family.familyId,
      code: invite.code,
      expiresAt: invite.expiresAt,
      ...links,
      feed: contract
        ? `${web}/receipt.html?network=testnet&contract=${contract}&family=${family.familyId}`
        : null,
      judge:
        contract && l.botUrl
          ? `${web}/judge.html?network=testnet&contract=${contract}&family=${family.familyId}&bot=${l.botUrl}`
          : null,
    };
  }

  /** The judge view: the chat and each receipt's tx hash. */
  async function familyView(familyId: string) {
    const orders = await ports.recent(familyId, 50);
    return {
      transcript: transcripts.get(familyId) ?? [],
      receipts: orders
        .filter((o) => o.receiptTxHash && !o.receiptTxHash.includes(":"))
        .map((o) => ({ orderId: o.id, txHash: o.receiptTxHash })),
    };
  }

  /** Resolves when every chat's queue and background payment is done. For tests. */
  async function idle(): Promise<void> {
    for (;;) {
      await demo.settled();
      const pending = [...queues.values()];
      await Promise.all(pending);
      await demo.settled();
      const now = [...queues.values()];
      if (now.length === pending.length && now.every((q, i) => q === pending[i])) return;
    }
  }

  /** Run the money checks once: float, stuck orders, failure rate. */
  async function check() {
    const f = await demo.float.check(0);
    return monitor.check({
      orders: await demo.orders(),
      floatKobo: f.balanceKobo,
      floorKobo: demo.floorKobo,
    });
  }

  return {
    onMessage,
    onOrderUpdate,
    onOrderWaiting,
    newInvite,
    familyView,
    idle,
    check,
    monitor,
  };
}

export type Bot = ReturnType<typeof createBot>;
