// Small pure helpers for the sender app, kept apart so they can be tested.

/** "$18.85" → 18.85. NaN when it isn't a dollar amount. */
export const usdNumber = (s: string): number => Number(s.replace(/[$,]/g, ""));

/** The naira equivalent of a "$100.00" string at a rate like "1325.81": "₦132,581". */
export function usdToNaira(usd: string, rate: string | null): string | null {
  const r = Number(rate);
  const u = usdNumber(usd);
  if (!rate || !Number.isFinite(r) || !Number.isFinite(u)) return null;
  return `₦${Math.round(u * r).toLocaleString("en-NG")}`;
}

export const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

/** What an order's status means to a sender, in a word and a tone. */
export function statusLabel(status: string): { text: string; tone: "ok" | "wait" | "bad" } {
  switch (status) {
    case "fulfilled":
      return { text: "Paid", tone: "ok" };
    case "refunded":
      return { text: "Refunded", tone: "bad" };
    case "awaiting_approval":
      return { text: "Needs you", tone: "wait" };
    case "approved":
    case "paying":
    case "paid":
    case "purchasing":
      return { text: "In progress", tone: "wait" };
    case "failed":
    case "refunding":
      return { text: "Refunding", tone: "bad" };
    case "declined":
      return { text: "Declined", tone: "bad" };
    case "rejected":
      return { text: "Not allowed", tone: "bad" };
    case "expired":
      return { text: "Expired", tone: "bad" };
    default:
      return { text: status, tone: "wait" };
  }
}

/** "in 3 h 20 min" / "in 12 min" / "now" */
export function timeLeft(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return "now";
  const min = Math.ceil(ms / 60_000);
  return min < 60 ? `in ${min} min` : `in ${Math.floor(min / 60)} h ${min % 60} min`;
}

export const CATEGORY_NAMES: Record<string, string> = {
  electricity: "Electricity",
  airtime: "Airtime",
  data: "Data",
  tv: "TV",
};
