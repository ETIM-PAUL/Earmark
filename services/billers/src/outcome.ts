import type { Fulfillment } from "@earmark/shared";
import type { VtpassResponse } from "./client.js";
import { type BillerMessage, describeCode } from "./messages.js";

/**
 * What one VTpass answer means for an order.
 *
 * - delivered: the bill is paid. Save the fulfillment.
 * - failed: VTpass took the request and it failed or was reversed. We are
 *   not charged; refund the family.
 * - refused: VTpass turned it away before processing it. We are not
 *   charged; refund the family (or retry, if `retryable`).
 * - pending: no final answer yet. Requery; never refund on this.
 *
 * Anything we don't recognise is pending. Calling a paid bill "failed" by
 * mistake would refund money that was also spent, so we only say failed or
 * refused when VTpass says so in words we know.
 */
export type Outcome =
  | { kind: "delivered"; fulfillment: Fulfillment; raw: VtpassResponse }
  | { kind: "failed"; message: BillerMessage; raw: VtpassResponse }
  | { kind: "refused"; message: BillerMessage; retryable: boolean; raw: VtpassResponse }
  | { kind: "pending"; message: BillerMessage; notFound: boolean; raw: VtpassResponse | null };

/** VTpass turned these away before processing: nothing was bought or charged. */
const REFUSED = new Set([
  "010",
  "011",
  "012",
  "013",
  "017",
  "018",
  "019",
  "021",
  "022",
  "023",
  "024",
  "025",
  "026",
  "027",
  "028",
  "031",
  "032",
  "034",
  "035",
  "085",
  "087",
  "091",
]);
/** Worth sending again later under a new order. */
const RETRYABLE = new Set(["018", "019", "034", "035"]);

export function classifyPay(res: VtpassResponse): Outcome {
  const code = res.code ?? "";
  if (REFUSED.has(code)) {
    return {
      kind: "refused",
      message: describeCode(code),
      retryable: RETRYABLE.has(code),
      raw: res,
    };
  }
  return classifyTransaction(res);
}

/** A requery never refuses: a code it doesn't explain leaves the order pending. */
export function classifyRequery(res: VtpassResponse): Outcome {
  if (res.code === "015") {
    return { kind: "pending", message: describeCode("015"), notFound: true, raw: res };
  }
  return classifyTransaction(res);
}

function classifyTransaction(res: VtpassResponse): Outcome {
  const code = res.code ?? "";
  const status = res.content?.transactions?.status?.toLowerCase();
  if (code === "000" && status === "delivered") {
    const fulfillment = fulfillmentOf(res);
    if (fulfillment) return { kind: "delivered", fulfillment, raw: res };
  }
  if (code === "040" || status === "reversed") {
    return { kind: "failed", message: describeCode("040"), raw: res };
  }
  if (code === "016" || (code === "000" && status === "failed")) {
    return { kind: "failed", message: describeCode("016"), raw: res };
  }
  // 000 + initiated/pending is VTpass's normal "still working", same as 099.
  const stillWorking = code === "000" && (status === "initiated" || status === "pending");
  return {
    kind: "pending",
    message: describeCode(stillWorking ? "099" : code || "unknown"),
    notFound: false,
    raw: res,
  };
}

function fulfillmentOf(res: VtpassResponse): Fulfillment | null {
  const transactionId = res.content?.transactions?.transactionId;
  if (!transactionId) return null;
  const f: Fulfillment = {
    billerTransactionId: String(transactionId),
    completedAt: isoOrNow(res.transaction_date),
  };
  const token = cleanToken(res.token ?? res.mainToken ?? res.purchased_code);
  if (token) f.token = token;
  const units = present(res.units);
  if (units) f.units = units;
  return f;
}

/** "Token : 2636 2054 4059" → "2636 2054 4059"; "N/A" and "" → undefined. */
export function cleanToken(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return present(raw.replace(/^\s*token\s*:\s*/i, ""));
}

function present(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" || s.toUpperCase() === "N/A" ? undefined : s;
}

function isoOrNow(v: unknown): string {
  const d = typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
}
