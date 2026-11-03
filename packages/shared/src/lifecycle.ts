import type { Order, OrderStatus } from "./order.js";

/**
 * The order state machine. One order ID links one payment, one bill and one
 * receipt; this table is the only way an order's status may change.
 *
 *   draft ─► awaiting_confirmation ─► approved ─► paying ─► paid ─► purchasing ─► fulfilled
 *                     │                  ▲          │                  │
 *                     ▼                  │          ▼                  ▼
 *             awaiting_approval ─────────┘      rejected        failed ─► refunding ─► refunded
 *
 * Money is only ever with Earmark in `paid`, `purchasing`, `failed` and
 * `refunding`. Every one of those has exactly one way out that ends in a
 * receipt: fulfilled or refunded.
 */
export const TRANSITIONS = {
  draft: ["awaiting_confirmation", "cancelled", "expired"],
  // Recipient said "yes": rules decide. "no" cancels; a stale quote expires.
  awaiting_confirmation: ["approved", "awaiting_approval", "rejected", "cancelled", "expired"],
  // Sender votes. A freeze or hard limit can still reject after approval.
  awaiting_approval: ["approved", "declined", "rejected", "expired"],
  // The order service re-checks hard limits and requotes USDC just before paying.
  approved: ["paying", "rejected", "expired"],
  // The Agent API either delivers to settlement or refuses; a refusal moves no money.
  paying: ["paid", "rejected"],
  paid: ["purchasing", "failed"],
  // Pending biller results are requeried while staying in purchasing.
  purchasing: ["fulfilled", "failed"],
  failed: ["refunding"],
  refunding: ["refunded"],
  fulfilled: [],
  declined: [],
  rejected: [],
  expired: [],
  cancelled: [],
  refunded: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;

export const TERMINAL_STATUSES = (Object.keys(TRANSITIONS) as OrderStatus[]).filter(
  (s) => TRANSITIONS[s].length === 0,
);

/** Statuses in which the family's money sits with Earmark, not in their account. */
export const FUNDS_HELD_STATUSES: readonly OrderStatus[] = [
  "paid",
  "purchasing",
  "failed",
  "refunding",
];

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (TRANSITIONS[from] as readonly OrderStatus[]).includes(to);
}

export class TransitionError extends Error {
  constructor(
    readonly orderId: string,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    detail: string,
  ) {
    super(`order ${orderId}: ${from} → ${to} not allowed: ${detail}`);
    this.name = "TransitionError";
  }
}

/** Fields an order must carry to enter each status. */
const REQUIRES: Partial<Record<OrderStatus, (o: Order) => string | null>> = {
  awaiting_confirmation: (o) =>
    !o.quote ? "a quote" : !o.customerName ? "the customer name from the biller lookup" : null,
  awaiting_approval: (o) => (!o.approval ? "an approval request with a reason" : null),
  approved: (o) =>
    o.approval && o.approval.decision !== "approved" ? "the sender's approval decision" : null,
  declined: (o) => (o.approval?.decision !== "declined" ? "a declined approval decision" : null),
  paying: (o) => (!o.quote ? "a quote" : null),
  paid: (o) => (!o.paymentTxHash ? "paymentTxHash" : null),
  fulfilled: (o) => (!o.fulfillment ? "fulfillment details" : null),
  rejected: (o) => (!o.failureReason ? "a failureReason" : null),
  failed: (o) => (!o.failureReason ? "a failureReason" : null),
  expired: (o) => (!o.failureReason ? "a failureReason" : null),
  refunded: (o) => (!o.refundTxHash ? "refundTxHash" : null),
};

/**
 * Move an order to a new status, applying `patch` first. Returns a new
 * order; never mutates. Throws TransitionError when the move is not in the
 * table or the order lacks what the new status needs.
 */
export function advance(
  order: Order,
  to: OrderStatus,
  patch: Partial<Omit<Order, "id" | "familyId" | "status" | "createdAt" | "updatedAt">> = {},
  now: Date = new Date(),
): Order {
  if (!canTransition(order.status, to)) {
    throw new TransitionError(order.id, order.status, to, "not in the transition table");
  }
  const next: Order = { ...order, ...patch, status: to, updatedAt: now.toISOString() };
  const missing = REQUIRES[to]?.(next);
  if (missing) throw new TransitionError(order.id, order.status, to, `needs ${missing}`);
  return next;
}

/** Mermaid source for the state diagram, generated from TRANSITIONS. */
export function orderStateDiagram(): string {
  const lines = ["stateDiagram-v2", "  [*] --> draft"];
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) lines.push(`  ${from} --> ${to}`);
    if (tos.length === 0) lines.push(`  ${from} --> [*]`);
  }
  return lines.join("\n");
}
