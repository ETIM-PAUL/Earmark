import { z } from "zod";

/**
 * Naira amounts are integer kobo (₦1 = 100 kobo). Never use floats for money.
 * Pilot caps keep these far below Number.MAX_SAFE_INTEGER.
 */
export const NgnKobo = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type NgnKobo = z.infer<typeof NgnKobo>;

/**
 * USDC amounts are atomic units (6 decimals) as a decimal string, matching
 * NEAR's U128 JSON encoding. "1000000" is $1.00.
 */
export const UsdcAtomic = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be a non-negative integer string");
export type UsdcAtomic = z.infer<typeof UsdcAtomic>;

export const USDC_DECIMALS = 6;

export function nairaToKobo(naira: number): NgnKobo {
  return Math.round(naira * 100);
}

export function formatNaira(kobo: NgnKobo): string {
  return `₦${(kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
}

export function formatUsdc(atomic: UsdcAtomic): string {
  const v = BigInt(atomic);
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const cents = (v * 100n + unit / 2n) / unit; // round half up to cents
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
