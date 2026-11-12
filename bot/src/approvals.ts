import { createHmac, timingSafeEqual } from "node:crypto";
import { formatNaira, formatUsdc, type Order } from "@earmark/shared";
import { LABELS, maskRef } from "./providers.js";

/**
 * Approvals: a request outside the family's category rules goes to the
 * sender as a card. The sender approves or declines; only a decision signed
 * by the account owner counts, and the signature covers this order, this
 * request and this decision, so an approval can't be replayed as a decline
 * or moved to another order.
 *
 * Until the sender app has a wallet (Phase 12), the demo owner signs with a
 * per-process HMAC secret. The real signer is the owner's NEAR or EVM
 * wallet; `checkProof` is the one place to swap.
 */

/** A request nobody answers is cancelled after this long. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type Decision = "approved" | "declined";

export interface ApprovalCard {
  orderId: string;
  /** "Ikeja Electric prepaid electricity" */
  what: string;
  /** Masked: "1111…1111". The sender knows the number; the card needn't repeat it. */
  who: string;
  customerName: string;
  amountNgn: string;
  amountUsd: string;
  /** Which rules tripped, in plain words. */
  reasons: string[];
  requestedAt: string;
  expiresAt: string;
}

export function approvalCard(o: Order): ApprovalCard {
  if (!o.approval) throw new Error(`order ${o.id} has no approval request`);
  const label = LABELS[o.billerCode] ?? o.billerCode;
  const what =
    o.category === "electricity"
      ? `${label} ${o.variationCode ?? "prepaid"} electricity`
      : o.category === "airtime"
        ? `${label} airtime`
        : `${label} ${o.variationCode ?? o.category}`;
  return {
    orderId: o.id,
    what,
    who: maskRef(o.customerRef),
    customerName: o.customerName ?? "",
    amountNgn: formatNaira(o.amountNgnKobo),
    amountUsd: o.quote ? formatUsdc(o.quote.amountUsdcAtomic) : "?",
    reasons: o.approval.reason.split(/(?<=[.!?])\s+/).filter(Boolean),
    requestedAt: o.approval.requestedAt,
    expiresAt: new Date(Date.parse(o.approval.requestedAt) + APPROVAL_TTL_MS).toISOString(),
  };
}

const message = (o: Order, decision: Decision) =>
  `${o.id}|${o.approval?.requestedAt ?? ""}|${decision}`;

/** What the owner's wallet signs: this order, this request, this decision. */
export function ownerProof(secret: string, o: Order, decision: Decision): string {
  return createHmac("sha256", secret).update(message(o, decision)).digest("hex");
}

export function checkProof(secret: string, o: Order, decision: Decision, proof: string): boolean {
  const a = Buffer.from(ownerProof(secret, o, decision));
  const b = Buffer.from(proof);
  return a.length === b.length && timingSafeEqual(a, b);
}

// What the recipient hears. English here; pidgin.ts translates each sentence.
export const declinedMessage = (sender: string) =>
  `${sender} declined this payment. Nothing was paid.`;
export const expiredMessage = (sender: string) =>
  `${sender} didn't answer in time, so this payment was cancelled. Nothing was paid. Please ask again if you still need it.`;
export const FROZEN_STOPPED = "The account is frozen by the sender. Nothing was paid.";
export const NOTHING_PAID = "Nothing was paid.";

export type DecideResult =
  | { ok: true; order: Order }
  | {
      ok: false;
      reason: "not_found" | "not_pending" | "bad_proof" | "expired" | "no_price";
      order?: Order;
    };
