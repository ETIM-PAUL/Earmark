import { describe, expect, it } from "vitest";
import {
  type CategoryRule,
  evaluateOrder,
  type FamilyRules,
  lagosMonth,
  type MonthUsage,
  newFamilyId,
} from "./index.js";

const on: CategoryRule = { enabled: true, monthlyCapNgnKobo: null, allowedCustomerRefs: [] };
const off: CategoryRule = { ...on, enabled: false };

// The demo family: electricity, airtime and data only, up to ₦100,000 a month each.
function demoRules(over: Partial<FamilyRules> = {}): FamilyRules {
  const capped = { ...on, monthlyCapNgnKobo: 10_000_000 };
  return {
    familyId: newFamilyId(),
    version: 1,
    frozen: false,
    hardLimits: {
      settlementAccountId: "earmark-settle.near",
      monthlyBudgetUsd: "200",
      perTransactionMaxUsdcAtomic: "150000000",
    },
    approvalAboveNgnKobo: 5_000_000,
    categories: { electricity: capped, airtime: capped, data: capped, tv: off },
    updatedAt: "2026-11-03T09:00:00.000Z",
    ...over,
  };
}

const empty: MonthUsage = {
  month: "202611",
  spentNgnKoboByCategory: { electricity: 0, airtime: 0, data: 0, tv: 0 },
  spentUsdcAtomic: "0",
};

// ₦1,612.50 per $1
function order(category: "electricity" | "tv", naira: number, customerRef = "45031234567") {
  const usdc = Math.ceil((naira / 1612.5) * 1e6);
  return {
    category,
    customerRef,
    amountNgnKobo: naira * 100,
    quote: {
      rateNgnPerUsd: "1612.50",
      amountUsdcAtomic: String(usdc),
      quotedAt: "2026-11-03T09:00:00.000Z",
      expiresAt: "2026-11-03T09:10:00.000Z",
    },
  };
}

describe("evaluateOrder", () => {
  it("demo step 3: ₦10,000 of light goes straight through", () => {
    expect(evaluateOrder(order("electricity", 10_000), demoRules(), empty)).toEqual({
      outcome: "allow",
    });
  });

  it("demo step 5: ₦200,000 'for business' asks the sender", () => {
    const res = evaluateOrder(order("electricity", 200_000), demoRules(), empty);
    expect(res.outcome).toBe("needs_approval");
    if (res.outcome !== "needs_approval") return;
    expect(res.breaches.map((b) => b.code).sort()).toEqual([
      "approval_above_amount",
      "category_monthly_cap",
    ]);
    expect(res.breaches[0]?.message).toMatch(/₦/);
  });

  it("the sender's approval clears soft rules", () => {
    const res = evaluateOrder(order("electricity", 200_000), demoRules(), empty, {
      senderApproved: true,
    });
    expect(res.outcome).toBe("allow");
  });

  it("a switched-off category needs approval", () => {
    const res = evaluateOrder(order("tv", 5_000), demoRules(), empty);
    expect(res).toMatchObject({
      outcome: "needs_approval",
      breaches: [{ code: "category_disabled" }],
    });
  });

  it("counts what was already spent this month", () => {
    const usage = {
      ...empty,
      spentNgnKoboByCategory: { ...empty.spentNgnKoboByCategory, electricity: 9_500_000 },
    };
    const res = evaluateOrder(order("electricity", 10_000), demoRules(), usage);
    expect(res).toMatchObject({ breaches: [{ code: "category_monthly_cap" }] });
  });

  it("only pays allowed meters when a list is set", () => {
    const rules = demoRules();
    rules.categories.electricity = { ...on, allowedCustomerRefs: ["4503-1234-567"] };
    expect(evaluateOrder(order("electricity", 1_000), rules, empty).outcome).toBe("allow");
    expect(evaluateOrder(order("electricity", 1_000, "99999999999"), rules, empty)).toMatchObject({
      breaches: [{ code: "customer_not_allowed" }],
    });
  });

  it("freeze rejects, even with approval", () => {
    const res = evaluateOrder(order("electricity", 1_000), demoRules({ frozen: true }), empty, {
      senderApproved: true,
    });
    expect(res).toMatchObject({ outcome: "reject", breaches: [{ code: "frozen" }] });
  });

  it("hard limits reject, even with approval", () => {
    // ₦300,000 ≈ $186: above the $150 per-payment max
    const res = evaluateOrder(order("electricity", 300_000), demoRules(), empty, {
      senderApproved: true,
    });
    expect(res).toMatchObject({ outcome: "reject" });
    if (res.outcome !== "reject") return;
    expect(res.breaches.filter((b) => b.layer === "hard").map((b) => b.code)).toEqual([
      "per_transaction_max",
    ]);
  });

  it("the USD monthly budget rejects", () => {
    const res = evaluateOrder(order("electricity", 10_000), demoRules(), {
      ...empty,
      spentUsdcAtomic: "199000000",
    });
    expect(res).toMatchObject({ outcome: "reject", breaches: [{ code: "monthly_budget" }] });
    if (res.outcome === "reject") expect(res.breaches[0]?.message).toContain("$1.00");
  });

  it("months follow Lagos time", () => {
    expect(lagosMonth(new Date("2026-11-30T23:30:00Z"))).toBe("202612");
  });
});
