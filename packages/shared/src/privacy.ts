import { z } from "zod";
import type { Category } from "./category.js";

/**
 * Names, phone numbers and meter numbers never go on-chain. Receipts carry
 * an HMAC-SHA256 of the customer reference, keyed by a per-family secret
 * salt that lives only in our database. Without the salt, nobody can
 * brute-force a phone number back out of a receipt.
 */
export const CustomerRefHash = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex chars");
export type CustomerRefHash = z.infer<typeof CustomerRefHash>;

/** Digits only; Nigerian phones in local 0XXXXXXXXXX form. */
export function normalizeCustomerRef(category: Category, ref: string): string {
  const digits = ref.replace(/\D/g, "");
  if (category === "airtime" || category === "data") {
    if (digits.length === 13 && digits.startsWith("234")) return `0${digits.slice(3)}`;
    if (digits.length === 10) return `0${digits}`;
  }
  return digits;
}

export async function hashCustomerRef(
  familySalt: string,
  category: Category,
  ref: string,
): Promise<CustomerRefHash> {
  if (familySalt.length < 32) throw new Error("family salt must be at least 32 chars");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(familySalt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msg = enc.encode(`earmark:v1:${category}:${normalizeCustomerRef(category, ref)}`);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes as hex, generated once per family. */
export function newFamilySalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
