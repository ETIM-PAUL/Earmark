import type { Category } from "@earmark/shared";
import { isKnownService, METER_TYPES, type MeterType } from "./catalog.js";
import { type VtpassClient, type VtpassResponse, VtpassTransportError } from "./client.js";
import { describeCode, describeVerifyFailure } from "./messages.js";

export type Lookup =
  /** customerName is shown in the confirmation; it never goes on-chain. */
  | { ok: true; customerName?: string; raw: VtpassResponse | null }
  | {
      ok: false;
      reason: "not_found" | "unavailable";
      recipient: string;
      raw: VtpassResponse | null;
    };

/**
 * Checks a meter or smartcard before the recipient confirms. Airtime and
 * data have no lookup on VTpass, so they pass straight through.
 */
export async function lookupCustomer(
  client: VtpassClient,
  input: { category: Category; billerCode: string; customerRef: string; meterType?: MeterType },
): Promise<Lookup> {
  if (input.category === "airtime" || input.category === "data") return { ok: true, raw: null };
  if (!isKnownService(input.category, input.billerCode)) {
    throw new Error(`${input.billerCode} is not a ${input.category} biller we sell`);
  }
  const meterType = input.meterType ?? "prepaid";
  if (input.category === "electricity" && !METER_TYPES.includes(meterType)) {
    throw new Error("meter type must be prepaid or postpaid");
  }
  const kind = input.category === "electricity" ? "meter" : "smartcard";

  let res: VtpassResponse;
  try {
    res = await client.verify({
      serviceID: input.billerCode,
      billersCode: input.customerRef,
      ...(input.category === "electricity" ? { type: meterType } : {}),
    });
  } catch (e) {
    if (!(e instanceof VtpassTransportError)) throw e;
    return {
      ok: false,
      reason: "unavailable",
      recipient: "We couldn't reach the biller just now. Please try again in a minute.",
      raw: null,
    };
  }

  const content = (res.content ?? {}) as Record<string, unknown>;
  const name = typeof content.Customer_Name === "string" ? content.Customer_Name.trim() : "";
  const wrong = content.WrongBillersCode === true || typeof content.error === "string";
  if (res.code === "000" && name && !wrong) {
    return { ok: true, customerName: name, raw: res };
  }
  // A VTpass code we know (e.g. 087) means our side is broken, not the number.
  if (res.code && res.code !== "000") {
    const msg = describeCode(res.code);
    if (msg.alert) {
      return {
        ok: false,
        reason: "unavailable",
        recipient: "We couldn't reach the biller just now. Please try again in a minute.",
        raw: res,
      };
    }
  }
  return { ok: false, reason: "not_found", recipient: describeVerifyFailure(kind), raw: res };
}
