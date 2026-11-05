import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Chat transports. Chats are keyed "tg:<chat id>" or "wa:<+234…>" so one
 * bot core serves both.
 */

export type OnMessage = (chat: string, text: string | null) => Promise<void>;

// ── Telegram: long polling, so it runs anywhere without a public URL ─────

export class Telegram {
  private offset = 0;
  private stopped = false;
  private readonly api: string;

  constructor(token: string) {
    this.api = `https://api.telegram.org/bot${token}`;
  }

  async send(chatId: string, text: string): Promise<void> {
    const res = await fetch(`${this.api}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage HTTP ${res.status}`);
  }

  /** Who we are, and drop any webhook so polling works. Throws on a bad token. */
  async start(): Promise<string> {
    const me = (await (await fetch(`${this.api}/getMe`)).json()) as {
      ok: boolean;
      result?: { username?: string };
    };
    if (!me.ok) throw new Error("Telegram refused the bot token");
    await fetch(`${this.api}/deleteWebhook`);
    return me.result?.username ?? "?";
  }

  async poll(onMessage: OnMessage): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(
          `${this.api}/getUpdates?timeout=30&offset=${this.offset}&allowed_updates=["message"]`,
          { signal: AbortSignal.timeout(40_000) },
        );
        const body = (await res.json()) as {
          ok: boolean;
          result?: {
            update_id: number;
            message?: { chat: { id: number; type: string }; text?: string };
          }[];
        };
        for (const u of body.result ?? []) {
          this.offset = u.update_id + 1;
          const m = u.message;
          // Private chats only: a family's bills don't belong in a group.
          if (m?.chat.type !== "private") continue;
          onMessage(`tg:${m.chat.id}`, m.text ?? null).catch((e) =>
            console.error(`telegram message failed: ${String(e)}`),
          );
        }
      } catch (e) {
        console.warn(`telegram poll: ${(e as Error).name}; retrying`);
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

// ── WhatsApp through Twilio: a signed webhook in, the REST API out ────────

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** e.g. whatsapp:+14155238886, the sandbox number. */
  from: string;
}

export class WhatsApp {
  constructor(private readonly cfg: TwilioConfig) {}

  async send(to: string, text: string): Promise<void> {
    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: this.cfg.from, To: `whatsapp:${to}`, Body: text }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`Twilio send HTTP ${res.status}`);
  }

  /**
   * Twilio signs each webhook: base64 HMAC-SHA1 of the full URL followed by
   * every form field, sorted by name. Unsigned or mis-signed posts are dropped.
   */
  verify(url: string, params: URLSearchParams, signature: string | undefined): boolean {
    if (!signature) return false;
    const keys = [...new Set(params.keys())].sort();
    const data = url + keys.map((k) => k + (params.get(k) ?? "")).join("");
    const expected = createHmac("sha1", this.cfg.authToken).update(data).digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The sender, as +234…, from a verified webhook. */
  static chatOf(params: URLSearchParams): { from: string; text: string | null } | null {
    const from = params.get("From")?.replace(/^whatsapp:/, "");
    if (!from) return null;
    const media = Number(params.get("NumMedia") ?? "0");
    const body = params.get("Body");
    return { from, text: media > 0 && !body ? null : body };
  }
}
