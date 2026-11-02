import { z } from "zod";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LAGOS_UTC_OFFSET_MS = 60 * 60 * 1000; // WAT is UTC+1 with no daylight saving

function randomSuffix(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** YYYYMMDDHHmm in Africa/Lagos time. */
export function lagosTimestamp(now: Date = new Date()): string {
  const lagos = new Date(now.getTime() + LAGOS_UTC_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(lagos.getUTCFullYear()) +
    pad(lagos.getUTCMonth() + 1) +
    pad(lagos.getUTCDate()) +
    pad(lagos.getUTCHours()) +
    pad(lagos.getUTCMinutes())
  );
}

/**
 * One ID links one payment, one bill and one receipt.
 *
 * It doubles as the VTpass `request_id`, which must start with the Lagos
 * date and time as YYYYMMDDHHmm. Re-sending the same ID can never buy twice.
 * Format: 12 digits + 12 lowercase alphanumerics, 24 chars total.
 */
export const OrderId = z
  .string()
  .regex(/^\d{12}[a-z0-9]{12}$/, "order id must be YYYYMMDDHHmm + 12 lowercase alphanumerics");
export type OrderId = z.infer<typeof OrderId>;

export function newOrderId(now: Date = new Date()): OrderId {
  return lagosTimestamp(now) + randomSuffix(12);
}

/** Opaque family ID. Safe to put on-chain: it carries no personal data. */
export const FamilyId = z.string().regex(/^fam_[a-z0-9]{16}$/, "family id must be fam_ + 16 chars");
export type FamilyId = z.infer<typeof FamilyId>;

export function newFamilyId(): FamilyId {
  return `fam_${randomSuffix(16)}`;
}

/** NEAR account ID, e.g. `earmark-settle.near` or a 64-char implicit account. */
export const NearAccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "invalid NEAR account id");
export type NearAccountId = z.infer<typeof NearAccountId>;
