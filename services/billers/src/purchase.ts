import { type Category, lagosTimestamp, OrderId } from "@earmark/shared";
import { isKnownService, METER_TYPES, type MeterType } from "./catalog.js";
import { type PayRequest, type VtpassClient, VtpassTransportError } from "./client.js";
import { describeCode } from "./messages.js";
import { classifyPay, classifyRequery, type Outcome } from "./outcome.js";

/** The order fields a purchase needs. A subset of `Order`, so tests stay small. */
export interface BillPurchase {
  orderId: string;
  category: Category;
  /** VTpass serviceID, e.g. "ikeja-electric", "mtn", "mtn-data", "dstv". */
  billerCode: string;
  /** Data bundle or TV bouquet; "prepaid" or "postpaid" for electricity (default prepaid). */
  variationCode?: string;
  /** Meter, phone or smartcard number. */
  customerRef: string;
  amountNgnKobo: number;
  /**
   * The recipient's phone. VTpass requires one on every purchase; for
   * airtime and data it is the number being topped up.
   */
  contactPhone: string;
}

export interface PurchaseOptions {
  /** Waits before each requery, in ms. Their sum is the most we wait in-line. */
  requerySchedule?: number[];
  /**
   * How many times to send /pay again when a requery says VTpass has never
   * seen the request ID. Safe: VTpass refuses a reused ID with 014.
   */
  maxResends?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SCHEDULE = [3_000, 5_000, 10_000, 20_000];

export class PurchaseInputError extends Error {
  constructor(
    readonly reason:
      | "bad_order_id"
      | "request_id_not_today"
      | "unknown_service"
      | "bad_amount"
      | "missing_variation"
      | "bad_meter_type",
    message: string,
  ) {
    super(message);
    this.name = "PurchaseInputError";
  }
}

/**
 * VTpass only accepts a request_id dated today in Lagos. An order created
 * before midnight and bought after it can't use its own ID.
 */
export function requestIdIsToday(orderId: string, now: Date = new Date()): boolean {
  return orderId.slice(0, 8) === lagosTimestamp(now).slice(0, 8);
}

/** Builds the /pay body. Throws PurchaseInputError before anything is sent. */
export function buildPayRequest(p: BillPurchase, now: Date = new Date()): PayRequest {
  if (!OrderId.safeParse(p.orderId).success) {
    throw new PurchaseInputError("bad_order_id", `not an order id: ${p.orderId}`);
  }
  if (!requestIdIsToday(p.orderId, now)) {
    throw new PurchaseInputError(
      "request_id_not_today",
      `order ${p.orderId} is not dated today in Lagos; VTpass would refuse it (085)`,
    );
  }
  if (!isKnownService(p.category, p.billerCode)) {
    throw new PurchaseInputError(
      "unknown_service",
      `${p.billerCode} is not a ${p.category} biller we sell`,
    );
  }
  // Airtime and electricity take whole naira. Data and TV are priced by
  // variation, and some cost kobo (Airtel's ₦49.99 bundle).
  const priced = p.category === "data" || p.category === "tv";
  if (
    !Number.isSafeInteger(p.amountNgnKobo) ||
    p.amountNgnKobo <= 0 ||
    (!priced && p.amountNgnKobo % 100)
  ) {
    throw new PurchaseInputError("bad_amount", "amount must be a positive whole naira amount");
  }
  const amount = p.amountNgnKobo / 100;
  const base = { request_id: p.orderId, serviceID: p.billerCode, phone: p.contactPhone };

  switch (p.category) {
    case "airtime":
      return { ...base, amount, phone: p.customerRef };
    case "data":
      if (!p.variationCode)
        throw new PurchaseInputError("missing_variation", "data needs a bundle");
      // VTpass prices data by variation_code and ignores amount.
      return {
        ...base,
        billersCode: p.customerRef,
        variation_code: p.variationCode,
        amount,
        phone: p.customerRef,
      };
    case "electricity": {
      const meterType = (p.variationCode ?? "prepaid") as MeterType;
      if (!METER_TYPES.includes(meterType)) {
        throw new PurchaseInputError("bad_meter_type", `meter type must be prepaid or postpaid`);
      }
      return { ...base, billersCode: p.customerRef, variation_code: meterType, amount };
    }
    case "tv":
      if (!p.variationCode) throw new PurchaseInputError("missing_variation", "TV needs a bouquet");
      // No amount: VTpass charges the bouquet's own price, which the quote
      // already matched. Sending one would top the decoder up instead.
      return {
        ...base,
        billersCode: p.customerRef,
        variation_code: p.variationCode,
        subscription_type: "change",
        quantity: 1,
      };
  }
}

/**
 * Buys one bill. Sends /pay, then requeries until VTpass gives a final
 * answer or the schedule runs out.
 *
 * Returns pending when time runs out: the order stays `purchasing`, and the
 * webhook or a later requery finishes it. Never refund a pending order.
 */
export async function purchaseBill(
  client: VtpassClient,
  p: BillPurchase,
  opts: PurchaseOptions = {},
): Promise<Outcome> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const req = buildPayRequest(p, now());
  let resends = opts.maxResends ?? 1;

  let outcome = await pay(client, req);
  if (outcome.kind !== "pending") return outcome;

  for (const wait of opts.requerySchedule ?? DEFAULT_SCHEDULE) {
    await sleep(wait);
    outcome = await requery(client, req.request_id);
    if (outcome.kind !== "pending") return outcome;
    if (outcome.notFound && resends > 0 && requestIdIsToday(req.request_id, now())) {
      resends -= 1;
      outcome = await pay(client, req);
      if (outcome.kind !== "pending") return outcome;
    }
  }
  return outcome;
}

/** One requery, for the webhook and the reconciler. */
export async function checkPurchase(client: VtpassClient, orderId: string): Promise<Outcome> {
  return requery(client, orderId);
}

async function pay(client: VtpassClient, req: PayRequest): Promise<Outcome> {
  try {
    const res = await client.pay(req);
    // 014: this request ID was already used. That's our earlier attempt;
    // requery says how it went. Never treat it as a refusal.
    if (res.code === "014") {
      return { kind: "pending", message: describeCode("014"), notFound: false, raw: res };
    }
    return classifyPay(res);
  } catch (e) {
    return transportPending(e);
  }
}

async function requery(client: VtpassClient, requestId: string): Promise<Outcome> {
  try {
    return classifyRequery(await client.requery(requestId));
  } catch (e) {
    return transportPending(e);
  }
}

function transportPending(e: unknown): Outcome {
  if (!(e instanceof VtpassTransportError)) throw e;
  return {
    kind: "pending",
    message: { ...describeCode(e.reason), operator: e.message },
    notFound: false,
    raw: null,
  };
}
