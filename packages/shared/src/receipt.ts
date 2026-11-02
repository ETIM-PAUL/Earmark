import { z } from "zod";
import { Category } from "./category.js";
import { FamilyId, OrderId } from "./ids.js";
import { NgnKobo, UsdcAtomic } from "./money.js";
import type { Order } from "./order.js";
import { CustomerRefHash } from "./privacy.js";

export const ReceiptStatus = z.enum(["fulfilled", "refunded"]);
export type ReceiptStatus = z.infer<typeof ReceiptStatus>;

/**
 * The on-chain record of one order. Mirrors `Receipt` in
 * contracts/receipts/src/lib.rs field for field (snake_case there).
 *
 * Strict: any extra key is a schema error, so personal data cannot slip
 * on-chain by accident.
 */
export const Receipt = z.strictObject({
  orderId: OrderId,
  familyId: FamilyId,
  category: Category,
  amountNgnKobo: NgnKobo,
  amountUsdcAtomic: UsdcAtomic,
  customerRefHash: CustomerRefHash,
  status: ReceiptStatus,
  paymentTxHash: z.string().nullable(),
  refundTxHash: z.string().nullable(),
  /** Set by the contract from block time. */
  recordedAtMs: z.number().int().nonnegative(),
});
export type Receipt = z.infer<typeof Receipt>;

/** What the service sends to the contract; the contract adds recordedAtMs. */
export type ReceiptInput = Omit<Receipt, "recordedAtMs">;

export function receiptFromOrder(order: Order): ReceiptInput {
  if (order.status !== "fulfilled" && order.status !== "refunded") {
    throw new Error(
      `order ${order.id} is ${order.status}; receipts are for fulfilled or refunded orders`,
    );
  }
  if (!order.quote) throw new Error(`order ${order.id} has no quote`);
  return {
    orderId: order.id,
    familyId: order.familyId,
    category: order.category,
    amountNgnKobo: order.amountNgnKobo,
    amountUsdcAtomic: order.quote.amountUsdcAtomic,
    customerRefHash: order.customerRefHash,
    status: order.status,
    paymentTxHash: order.paymentTxHash ?? null,
    refundTxHash: order.refundTxHash ?? null,
  };
}
