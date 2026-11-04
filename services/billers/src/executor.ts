import { advance, type Order, type OrderStatus, receiptFromOrder } from "@earmark/shared";
import type { VtpassClient } from "./client.js";
import type { FloatGuard } from "./float.js";
import { lookupCustomer } from "./lookup.js";
import { COMING_BACK } from "./messages.js";
import type { Outcome } from "./outcome.js";
import {
  type BillPurchase,
  buildPayRequest,
  checkPurchase,
  PurchaseInputError,
  type PurchaseOptions,
  purchaseBill,
  requestIdIsToday,
} from "./purchase.js";
import type { ReceiptWriter } from "./receipts.js";
import { type OrderStore, StaleOrderError } from "./store.js";

/**
 * The order executor. It takes an order the order service has marked `paid`
 * (settlement holds the family's USDC) and carries it to a receipt:
 *
 *   paid ─► purchasing ─► fulfilled ─► receipt
 *     │          │
 *     └──────────┴─► failed ─► refunding ─► refunded ─► receipt
 *
 * Every step is saved before the next one starts, and each save is
 * compare-and-set, so a crash or a second worker resumes where the first
 * stopped. `purchasing` is saved before VTpass is called, and from then on
 * the order is only ever requeried (or re-sent under the same request ID,
 * which VTpass dedupes). Nothing is refunded until VTpass says, in words we
 * know, that nothing was bought.
 */

/** Sends USDC from settlement back to the family account (Phase 8). */
export interface Refunds {
  /** Must be idempotent per order ID: a retry after a crash must not pay twice. */
  refund(order: Order): Promise<{ txHash: string }>;
}

export interface ExecutorDeps {
  store: OrderStore;
  vtpass: VtpassClient;
  float: FloatGuard;
  receipts: ReceiptWriter;
  refunds: Refunds;
  /** The recipient's phone, which VTpass needs on electricity and TV purchases. */
  contactPhone: (order: Order) => Promise<string>;
  /** Called after every saved status change, e.g. so the bot can tell the recipient. */
  notify?: (order: Order) => void;
  /** Problems a person must look at. Default console.error. */
  alert?: (msg: string) => void;
  purchase?: PurchaseOptions;
  /**
   * VTpass refuses (019) a repeat bill for the same number within 30 s, and
   * a refused request ID can't be reused. So a bill waits, still `paid`,
   * while another for the same number is in flight or ended less than this
   * long ago. Default 35 s.
   */
  sameBillGapMs?: number;
  /** A `purchasing` order VTpass has never heard of is failed after this long. Default 1 h. */
  unknownAfterMs?: number;
  now?: () => Date;
}

export type ExecResult = {
  orderId: string;
  status: OrderStatus | "unknown_order";
  /** True when the order still owes a step: pending biller, refund or receipt. */
  waiting: boolean;
  note?: string;
};

/** Statuses the sweeper revisits. Terminal ones only while their receipt is owed. */
const UNFINISHED: readonly OrderStatus[] = [
  "paid",
  "purchasing",
  "failed",
  "refunding",
  "fulfilled",
  "refunded",
];

export const QUEUED_NOTE = "queued behind another bill for the same number";

/**
 * One lane per customer number. VTpass documents its duplicate check (019)
 * as per service, but the drill saw airtime and data to the same phone
 * refuse each other, so the lane spans services.
 */
const laneKey = (o: Order) => o.customerRef.replace(/\D/g, "");

export class OrderExecutor {
  private readonly lanes = new Map<string, { busy: boolean; lastAt: number }>();
  private readonly now: () => Date;
  private readonly alert: (msg: string) => void;

  constructor(private readonly deps: ExecutorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.alert = deps.alert ?? ((m) => console.error(`ALERT ${m}`));
  }

  /** Run a paid order as far as it can go now. Safe to call more than once. */
  async execute(orderId: string): Promise<ExecResult> {
    const order = await this.deps.store.get(orderId);
    if (!order) return { orderId, status: "unknown_order", waiting: false };
    try {
      return await this.drive(order);
    } catch (e) {
      if (e instanceof StaleOrderError) {
        return { orderId, status: order.status, waiting: true, note: "another worker has it" };
      }
      throw e;
    }
  }

  /** A VTpass webhook or a timer says this order may have moved. */
  settle(orderId: string): Promise<ExecResult> {
    return this.execute(orderId);
  }

  /** Revisit every order that still owes a step. Run on a timer. */
  async sweep(): Promise<ExecResult[]> {
    const due = (await this.deps.store.listByStatus(UNFINISHED)).filter(
      (o) => !((o.status === "fulfilled" || o.status === "refunded") && o.receiptTxHash),
    );
    const out: ExecResult[] = [];
    for (const o of due) {
      try {
        out.push(await this.execute(o.id));
      } catch (e) {
        this.alert(`order ${o.id}: sweep step failed: ${String(e)}`);
        out.push({ orderId: o.id, status: o.status, waiting: true, note: String(e) });
      }
    }
    return out;
  }

  private async drive(start: Order): Promise<ExecResult> {
    let order = start;
    for (;;) {
      switch (order.status) {
        case "paid": {
          const release = await this.takeLane(order);
          if (!release) return this.result(order, true, QUEUED_NOTE);
          try {
            order = await this.startPurchase(order);
          } finally {
            release();
          }
          if (order.status === "purchasing")
            return this.result(order, true, "biller still processing");
          break;
        }
        case "purchasing": {
          const next = await this.followUp(order);
          if (!next) return this.result(order, true, "biller still processing");
          order = next;
          break;
        }
        case "failed":
          order = await this.commit(order, advance(order, "refunding", {}, this.stamp(order)));
          break;
        case "refunding": {
          const refund = await this.attempt(order, "refund", () => this.deps.refunds.refund(order));
          if (!refund) return this.result(order, true, "refund not sent yet");
          const { txHash } = refund;
          order = await this.commit(
            order,
            advance(order, "refunded", { refundTxHash: txHash }, this.stamp(order)),
          );
          break;
        }
        case "fulfilled":
        case "refunded": {
          if (order.receiptTxHash) return this.result(order, false);
          const receipt = await this.attempt(order, "receipt", () =>
            this.deps.receipts.record(receiptFromOrder(order)),
          );
          if (!receipt) return this.result(order, true, "receipt not written yet");
          const { txHash } = receipt;
          order = await this.commit(order, {
            ...order,
            receiptTxHash: txHash,
            updatedAt: this.stamp(order).toISOString(),
          });
          return this.result(order, false);
        }
        default:
          return this.result(order, false, `nothing to do while ${order.status}`);
      }
    }
  }

  /**
   * Claim the lane for this order's customer number, or null if another
   * bill holds it or used it too recently. The in-process claim is taken
   * before any await, so two workers here can't both pass; the store check
   * covers other processes and orders left pending.
   */
  private async takeLane(order: Order): Promise<(() => void) | null> {
    const key = laneKey(order);
    const lane = this.lanes.get(key);
    const t = this.now().getTime();
    if (lane && (lane.busy || t - lane.lastAt < (this.deps.sameBillGapMs ?? 35_000))) return null;
    const previous = lane?.lastAt ?? 0;
    this.lanes.set(key, { busy: true, lastAt: previous });
    const inFlight = (await this.deps.store.listByStatus(["purchasing"])).some(
      (o) => o.id !== order.id && laneKey(o) === key,
    );
    if (inFlight) {
      this.lanes.set(key, { busy: false, lastAt: previous });
      return null;
    }
    return () => this.lanes.set(key, { busy: false, lastAt: this.now().getTime() });
  }

  /** paid → purchasing → fulfilled | failed, or stays purchasing while pending. */
  private async startPurchase(order: Order): Promise<Order> {
    const now = this.now();
    if (!order.quote)
      return this.fail(order, "This order lost its price.", "paid order has no quote");
    if (!requestIdIsToday(order.id, now)) {
      return this.fail(order, "This order is from yesterday, so we couldn't send it today.");
    }

    // The family's money is already with us, so check everything we can
    // before VTpass sees the order.
    let purchase: BillPurchase;
    try {
      purchase = await this.toPurchase(order);
      buildPayRequest(purchase, now);
    } catch (e) {
      if (!(e instanceof PurchaseInputError)) throw e;
      return this.fail(order, "We couldn't send this bill.", e.message);
    }
    if (order.category === "electricity" || order.category === "tv") {
      const meterType = order.variationCode === "postpaid" ? "postpaid" : "prepaid";
      const found = await lookupCustomer(this.deps.vtpass, {
        category: order.category,
        billerCode: order.billerCode,
        customerRef: order.customerRef,
        ...(order.category === "electricity" ? { meterType } : {}),
      });
      // "unavailable" is our side or VTpass's, not the number: let /pay decide.
      if (!found.ok && found.reason === "not_found") return this.fail(order, found.recipient);
    }
    const float = await this.deps.float.check(order.amountNgnKobo);
    if (!float.ok) return this.fail(order, float.recipient, `float guard: ${float.reason}`);

    // Saved before VTpass is called: from here on, only requery.
    const purchasing = await this.commit(
      order,
      advance(order, "purchasing", {}, this.stamp(order)),
    );
    this.deps.float.spent(order.amountNgnKobo);
    const outcome = await purchaseBill(this.deps.vtpass, purchase, this.deps.purchase);
    return (await this.apply(purchasing, outcome)) ?? purchasing;
  }

  /** purchasing: requery. Returns null while VTpass is still working. */
  private async followUp(order: Order): Promise<Order | null> {
    const outcome = await checkPurchase(this.deps.vtpass, order.id);
    if (outcome.kind !== "pending" || !outcome.notFound) return this.apply(order, outcome);

    // VTpass has never seen this ID: we stopped between saving and /pay.
    const now = this.now();
    if (requestIdIsToday(order.id, now)) {
      return this.apply(
        order,
        await purchaseBill(this.deps.vtpass, await this.toPurchase(order), this.deps.purchase),
      );
    }
    // Past midnight VTpass would refuse the ID (085), so nothing can be bought under it.
    const since = now.getTime() - Date.parse(order.updatedAt);
    if (since < (this.deps.unknownAfterMs ?? 60 * 60 * 1000)) return null;
    return this.commit(
      order,
      advance(
        order,
        "failed",
        { failureReason: `The biller never received this payment. ${COMING_BACK}` },
        this.stamp(order),
      ),
    );
  }

  /** Save what one VTpass answer means. Null while pending. */
  private async apply(order: Order, outcome: Outcome): Promise<Order | null> {
    if (outcome.kind !== "delivered" && outcome.message.alert) {
      this.alert(`order ${order.id}: VTpass ${outcome.message.code}: ${outcome.message.operator}`);
    }
    switch (outcome.kind) {
      case "delivered":
        return this.commit(
          order,
          advance(order, "fulfilled", { fulfillment: outcome.fulfillment }, this.stamp(order)),
        );
      case "failed":
      case "refused":
        return this.commit(
          order,
          advance(order, "failed", { failureReason: outcome.message.recipient }, this.stamp(order)),
        );
      case "pending":
        return null;
    }
  }

  /** Run a step that talks to the chain; on error, alert and leave it for the sweeper. */
  private async attempt<T>(order: Order, step: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      this.alert(`order ${order.id}: ${step} failed, will retry: ${String(e)}`);
      return null;
    }
  }

  private fail(order: Order, recipient: string, why?: string): Promise<Order> {
    if (why) this.alert(`order ${order.id}: not bought, refunding: ${why}`);
    const failureReason = recipient.includes(COMING_BACK)
      ? recipient
      : `${recipient} ${COMING_BACK}`;
    return this.commit(order, advance(order, "failed", { failureReason }, this.stamp(order)));
  }

  private async toPurchase(order: Order): Promise<BillPurchase> {
    return {
      orderId: order.id,
      category: order.category,
      billerCode: order.billerCode,
      ...(order.variationCode ? { variationCode: order.variationCode } : {}),
      customerRef: order.customerRef,
      amountNgnKobo: order.amountNgnKobo,
      contactPhone: await this.deps.contactPhone(order),
    };
  }

  private async commit(prev: Order, next: Order): Promise<Order> {
    if (!(await this.deps.store.replace(prev, next))) throw new StaleOrderError(prev.id);
    this.deps.notify?.(next);
    return next;
  }

  /** Now, but always later than the order's last update, so compare-and-set can't be fooled. */
  private stamp(order: Order): Date {
    return new Date(Math.max(this.now().getTime(), Date.parse(order.updatedAt) + 1));
  }

  private result(order: Order, waiting: boolean, note?: string): ExecResult {
    return {
      orderId: order.id,
      status: order.status,
      waiting,
      ...(note ? { note } : {}),
    };
  }
}
