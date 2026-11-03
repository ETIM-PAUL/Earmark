import { z } from "zod";
import { Category } from "./category.js";
import { FamilyId, OrderId } from "./ids.js";
import { NgnKobo, UsdcAtomic } from "./money.js";
import { CustomerRefHash } from "./privacy.js";

/**
 * Every status an order can hold. Allowed transitions are in lifecycle.ts;
 * pods must not invent new statuses.
 */
export const OrderStatus = z.enum([
  "draft", // the bot is still collecting fields
  "awaiting_confirmation", // summary shown to the recipient, waiting for "yes"
  "awaiting_approval", // outside the rules, approval card sent to the sender
  "approved", // inside the rules, or the sender approved
  "paying", // family account transfer to settlement in flight
  "paid", // settlement account received the exact amount
  "purchasing", // biller call in flight (VTpass, or Flutterwave as backup)
  "fulfilled", // bill paid, token saved, receipt written
  "declined", // the sender declined the approval request
  "rejected", // a hard rule refused it: frozen, monthly budget, per-payment max
  "expired", // the quote or the approval request timed out
  "cancelled", // the recipient said no before paying
  "failed", // the biller failed after we were paid
  "refunding", // amount on its way back to the family account
  "refunded", // amount back in the family account, receipt written
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** Rate and USDC amount shown before the recipient confirms. Valid 10 minutes. */
export const Quote = z.object({
  /** NGN per 1 USD including our spread, as a decimal string, e.g. "1612.50". */
  rateNgnPerUsd: z.string().regex(/^\d+(\.\d+)?$/),
  amountUsdcAtomic: UsdcAtomic,
  quotedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type Quote = z.infer<typeof Quote>;

export const Approval = z.object({
  /** Which rule tripped, in plain words for the sender's approval card. */
  reason: z.string().min(1),
  requestedAt: z.iso.datetime(),
  decision: z.enum(["approved", "declined"]).optional(),
  decidedAt: z.iso.datetime().optional(),
});
export type Approval = z.infer<typeof Approval>;

export const Fulfillment = z.object({
  /** Biller's own transaction ID, for requery and support. */
  billerTransactionId: z.string().min(1),
  /** Prepaid electricity token. Sent to the recipient; never on-chain. */
  token: z.string().optional(),
  units: z.string().optional(),
  completedAt: z.iso.datetime(),
});
export type Fulfillment = z.infer<typeof Fulfillment>;

/**
 * One bill payment. Lives in the order service database; only the
 * Receipt projection of it goes on-chain.
 */
export const Order = z
  .object({
    id: OrderId,
    familyId: FamilyId,
    category: Category,
    /** VTpass serviceID, e.g. "ikeja-electric", "mtn", "mtn-data", "dstv". */
    billerCode: z.string().min(1),
    /** Bundle or plan code. Required for data and TV. */
    variationCode: z.string().min(1).optional(),
    /**
     * Meter number (electricity), phone number (airtime, data) or smartcard
     * number (TV). Personal data: off-chain only.
     */
    customerRef: z.string().min(1),
    customerRefHash: CustomerRefHash,
    /** Name the biller returned on lookup, shown in the confirmation summary. */
    customerName: z.string().optional(),
    amountNgnKobo: NgnKobo.positive(),
    quote: Quote.optional(),
    status: OrderStatus,
    approval: Approval.optional(),
    /** Family account → settlement transfer reference. */
    paymentTxHash: z.string().optional(),
    fulfillment: Fulfillment.optional(),
    refundTxHash: z.string().optional(),
    /** Plain-language reason, safe to show the recipient. */
    failureReason: z.string().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine((o) => !(o.category === "data" || o.category === "tv") || o.variationCode, {
    message: "variationCode is required for data and tv",
    path: ["variationCode"],
  });
export type Order = z.infer<typeof Order>;
