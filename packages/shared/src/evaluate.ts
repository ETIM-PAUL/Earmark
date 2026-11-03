import type { Category } from "./category.js";
import { lagosTimestamp } from "./ids.js";
import { formatNaira, formatUsdc, type NgnKobo, type UsdcAtomic } from "./money.js";
import type { Order } from "./order.js";
import { normalizeCustomerRef } from "./privacy.js";
import type { FamilyRules } from "./rules.js";

/**
 * What a family has already spent this month, from fulfilled orders plus
 * orders whose money is in flight. Months follow Lagos time.
 */
export interface MonthUsage {
  /** YYYYMM in Lagos time, from lagosMonth(). */
  month: string;
  spentNgnKoboByCategory: Record<Category, NgnKobo>;
  spentUsdcAtomic: UsdcAtomic;
}

export function lagosMonth(now: Date = new Date()): string {
  return lagosTimestamp(now).slice(0, 6);
}

/**
 * hard: layer 1, mirrored in the signed Agent API policy. Nobody can
 *       override it per order; the sender must change the policy.
 * soft: layer 2, our category rules. The sender can approve an exception.
 */
export interface RuleBreach {
  layer: "hard" | "soft";
  code:
    | "frozen"
    | "per_transaction_max"
    | "monthly_budget"
    | "category_disabled"
    | "category_monthly_cap"
    | "customer_not_allowed"
    | "approval_above_amount";
  /** Plain words, safe for the sender's approval card and the recipient. */
  message: string;
}

export type Evaluation =
  | { outcome: "allow" }
  | { outcome: "needs_approval"; breaches: RuleBreach[] }
  | { outcome: "reject"; breaches: RuleBreach[] };

const LABEL: Record<Category, string> = {
  electricity: "Electricity",
  airtime: "Airtime",
  data: "Data",
  tv: "TV",
};

/**
 * Check an order against both rule layers. Hard breaches reject; soft
 * breaches need the sender's approval unless `senderApproved` is set.
 * The AI never calls this with senderApproved: only the owner's signed
 * approval vote does.
 */
export function evaluateOrder(
  order: Pick<Order, "category" | "customerRef" | "amountNgnKobo" | "quote">,
  rules: FamilyRules,
  usage: MonthUsage,
  opts: { senderApproved?: boolean } = {},
): Evaluation {
  if (!order.quote) throw new Error("evaluateOrder needs a quoted order");
  const hard: RuleBreach[] = [];
  const soft: RuleBreach[] = [];
  const usdc = BigInt(order.quote.amountUsdcAtomic);

  if (rules.frozen) {
    hard.push({ layer: "hard", code: "frozen", message: "The account is frozen by the sender." });
  }
  const perTxMax = BigInt(rules.hardLimits.perTransactionMaxUsdcAtomic);
  if (usdc > perTxMax) {
    hard.push({
      layer: "hard",
      code: "per_transaction_max",
      message: `${formatUsdc(order.quote.amountUsdcAtomic)} is above the ${formatUsdc(String(perTxMax))} per-payment maximum.`,
    });
  }
  const budget = usdBudgetToAtomic(rules.hardLimits.monthlyBudgetUsd);
  const after = BigInt(usage.spentUsdcAtomic) + usdc;
  if (after > budget) {
    const left =
      budget > BigInt(usage.spentUsdcAtomic) ? budget - BigInt(usage.spentUsdcAtomic) : 0n;
    hard.push({
      layer: "hard",
      code: "monthly_budget",
      message: `Only ${formatUsdc(String(left))} of the $${rules.hardLimits.monthlyBudgetUsd} monthly budget is left.`,
    });
  }

  const rule = rules.categories[order.category];
  const label = LABEL[order.category];
  if (!rule.enabled) {
    soft.push({
      layer: "soft",
      code: "category_disabled",
      message: `${label} is not switched on.`,
    });
  }
  if (rule.monthlyCapNgnKobo !== null) {
    const spent = usage.spentNgnKoboByCategory[order.category];
    if (spent + order.amountNgnKobo > rule.monthlyCapNgnKobo) {
      soft.push({
        layer: "soft",
        code: "category_monthly_cap",
        message: `${label} would reach ${formatNaira(spent + order.amountNgnKobo)} this month; the cap is ${formatNaira(rule.monthlyCapNgnKobo)}.`,
      });
    }
  }
  if (rule.allowedCustomerRefs.length > 0) {
    const ref = normalizeCustomerRef(order.category, order.customerRef);
    const allowed = rule.allowedCustomerRefs.map((r) => normalizeCustomerRef(order.category, r));
    if (!allowed.includes(ref)) {
      soft.push({
        layer: "soft",
        code: "customer_not_allowed",
        message: `This ${order.category === "electricity" ? "meter" : order.category === "tv" ? "smartcard" : "phone number"} is not on the approved list.`,
      });
    }
  }
  if (rules.approvalAboveNgnKobo !== null && order.amountNgnKobo > rules.approvalAboveNgnKobo) {
    soft.push({
      layer: "soft",
      code: "approval_above_amount",
      message: `${formatNaira(order.amountNgnKobo)} is above the ${formatNaira(rules.approvalAboveNgnKobo)} that needs approval.`,
    });
  }

  if (hard.length > 0) return { outcome: "reject", breaches: [...hard, ...soft] };
  if (soft.length > 0 && !opts.senderApproved) return { outcome: "needs_approval", breaches: soft };
  return { outcome: "allow" };
}

function usdBudgetToAtomic(usd: string): bigint {
  const [whole = "0", frac = ""] = usd.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6));
}
