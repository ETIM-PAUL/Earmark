import { randomBytes } from "node:crypto";

/**
 * Invite links connect one recipient chat to one family. The sender's app
 * makes the invite; the recipient opens the link, and the bot sees
 * `/start <code>` (Telegram) or `start <code>` (WhatsApp).
 *
 * Codes are 128 random bits, single use, and expire after 7 days. Telegram
 * allows up to 64 of [A-Za-z0-9_-] in a start parameter; ours are 22.
 */

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODE = /^[A-Za-z0-9_-]{22}$/;

/** The code in "/start <code>", "/start@bot <code>" or "start <code>", if any. */
export function inviteCodeIn(text: string): string | null {
  const m = text.trim().match(/^\/?start(?:@\w+)?\s+(\S+)$/i);
  return m?.[1] && CODE.test(m[1]) ? m[1] : null;
}

interface Invite {
  familyId: string;
  expiresAt: number;
  usedBy: string | null;
}

export type Redeemed =
  | { ok: true; familyId: string }
  | { ok: false; reason: "unknown" | "expired" | "used" };

export class InviteStore {
  private readonly invites = new Map<string, Invite>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(familyId: string): { code: string; expiresAt: string } {
    const code = randomBytes(16).toString("base64url");
    const expiresAt = this.now().getTime() + INVITE_TTL_MS;
    this.invites.set(code, { familyId, expiresAt, usedBy: null });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Single use: the same chat may open its link again; nobody else can. */
  redeem(code: string, chat: string): Redeemed {
    const inv = this.invites.get(code);
    if (!inv) return { ok: false, reason: "unknown" };
    if (inv.usedBy && inv.usedBy !== chat) return { ok: false, reason: "used" };
    if (!inv.usedBy && this.now().getTime() >= inv.expiresAt)
      return { ok: false, reason: "expired" };
    inv.usedBy = chat;
    return { ok: true, familyId: inv.familyId };
  }
}

export function inviteLinks(
  code: string,
  opts: { telegramBot?: string | null; whatsappNumber?: string | null },
): { telegram: string | null; whatsapp: string | null } {
  return {
    telegram: opts.telegramBot ? `https://t.me/${opts.telegramBot}?start=${code}` : null,
    whatsapp: opts.whatsappNumber
      ? `https://wa.me/${opts.whatsappNumber.replace(/\D/g, "")}?text=${encodeURIComponent(`start ${code}`)}`
      : null,
  };
}
