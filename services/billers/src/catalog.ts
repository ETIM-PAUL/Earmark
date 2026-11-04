import type { Category } from "@earmark/shared";

/**
 * VTpass serviceIDs we sell, per category. Anything else is refused before
 * a call goes out, so an order can't reach foreign airtime, Smile or JAMB.
 * Minimums and maximums come from `GET /services` at quote time (Phase 9);
 * on sandbox, electricity starts at ₦500–₦2,000 depending on the disco.
 */
export const SERVICES: Record<Category, readonly string[]> = {
  electricity: [
    "ikeja-electric",
    "eko-electric",
    "abuja-electric",
    "kano-electric",
    "portharcourt-electric",
    "jos-electric",
    "kaduna-electric",
    "enugu-electric",
    "ibadan-electric",
    "benin-electric",
    "aba-electric",
    "yola-electric",
  ],
  airtime: ["mtn", "airtel", "glo", "etisalat"],
  data: ["mtn-data", "airtel-data", "glo-data", "etisalat-data"],
  tv: ["dstv", "gotv", "startimes", "showmax"],
};

/** VTpass `identifier` for `GET /services`, per category. */
export const SERVICE_IDENTIFIERS: Record<Category, string> = {
  electricity: "electricity-bill",
  airtime: "airtime",
  data: "data",
  tv: "tv-subscription",
};

export function isKnownService(category: Category, serviceId: string): boolean {
  return SERVICES[category].includes(serviceId);
}

/** Electricity's variation_code is the meter type. */
export const METER_TYPES = ["prepaid", "postpaid"] as const;
export type MeterType = (typeof METER_TYPES)[number];
