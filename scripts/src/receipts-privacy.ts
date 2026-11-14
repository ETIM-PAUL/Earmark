import { createHash } from "node:crypto";

// The checks behind `pnpm audit:receipts`, kept pure so they can be tested
// against receipts that do carry personal data (receipts-privacy.test.ts).

export const FIELDS = [
  "amountNgnKobo",
  "amountUsdcAtomic",
  "category",
  "customerRefHash",
  "familyId",
  "orderId",
  "paymentTxHash",
  "recordedAtMs",
  "refundTxHash",
  "status",
];
const CATEGORIES = ["electricity", "airtime", "data", "tv"];
const STATUSES = ["fulfilled", "refunded"];
const ORDER_ID = /^\d{12}[a-z0-9]{12}$/;
const FAMILY_ID = /^fam_[a-z0-9]{16}$/;
const HASH = /^[0-9a-f]{64}$/;
/** A NEAR transaction hash, or a provider/simulation reference tied to an order. */
const TX_REF = /^(?:[1-9A-HJ-NP-Za-km-z]{43,44}|[a-z-]+:\d{12}[a-z0-9]{12}|[A-Za-z]+\d{0,4})$/;

/** The VTpass sandbox numbers these receipts were bought for: public test values. */
const SANDBOX_REFS: [string, string][] = [
  ["airtime", "08011111111"],
  ["data", "08011111111"],
  ["electricity", "1111111111111"],
  ["tv", "1212121212"],
];

/** Patterns that would mean personal data, checked on every string field. */
const PERSONAL: [string, RegExp][] = [
  ["Nigerian phone number", /(?:\+?234|\b0)[789][01]\d{8}\b/],
  ["meter or smartcard number (10+ digits)", /\d{10,}/],
  ["email address", /@/],
  ["a space (names have one)", /\s/],
];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A plain (unsalted) hash anyone could compute for a known number. */
export function plainHashes(): Set<string> {
  const out = new Set<string>();
  for (const [category, ref] of SANDBOX_REFS) {
    for (const form of [ref, ref.replace(/^0/, "234"), ref.replace(/^0/, "+234")]) {
      out.add(sha(form));
      out.add(sha(`earmark:v1:${category}:${form}`));
    }
  }
  return out;
}

export type Receipt = Record<string, unknown>;

export function problems(r: Receipt, plain: Set<string>): string[] {
  const out: string[] = [];
  const keys = Object.keys(r).sort();
  if (keys.join() !== FIELDS.join()) out.push(`fields are ${keys.join(", ")}`);
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const orderId = s("orderId");
  if (!ORDER_ID.test(orderId)) out.push("orderId format");
  else {
    // The 12 digits are a Lagos timestamp (YYYYMMDDHHmm), not a number someone owns.
    const [y, mo, d, h, mi] = [0, 4, 6, 8, 10].map((i, n) =>
      Number(orderId.slice(i, i + (n === 0 ? 4 : 2))),
    ) as [number, number, number, number, number];
    if (y < 2026 || y > 2030 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59)
      out.push("orderId prefix is not a timestamp");
  }
  if (!FAMILY_ID.test(s("familyId"))) out.push("familyId format");
  if (!HASH.test(s("customerRefHash"))) out.push("customerRefHash is not a 64-char hash");
  if (plain.has(s("customerRefHash"))) out.push("customerRefHash is an unsalted hash of a number");
  if (!CATEGORIES.includes(s("category"))) out.push("category");
  if (!STATUSES.includes(s("status"))) out.push("status");
  for (const k of ["paymentTxHash", "refundTxHash"]) {
    if (r[k] !== null && !TX_REF.test(s(k))) out.push(`${k} format`);
  }
  for (const k of ["amountNgnKobo", "amountUsdcAtomic", "recordedAtMs"]) {
    if (!/^\d+$/.test(String(r[k]))) out.push(`${k} is not a plain number`);
  }
  // Personal-data patterns on every string, once the order ID (a timestamp) is taken out.
  for (const k of keys) {
    if (typeof r[k] !== "string" || k === "customerRefHash") continue;
    const text = (r[k] as string).replace(/\d{12}[a-z0-9]{12}/g, "");
    for (const [what, re] of PERSONAL) if (re.test(text)) out.push(`${k}: ${what}`);
  }
  return out;
}
