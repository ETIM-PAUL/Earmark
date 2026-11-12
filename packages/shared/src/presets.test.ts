import { describe, expect, it } from "vitest";
import {
  applyPreset,
  evaluateOrder,
  type FamilyRules,
  type MonthUsage,
  newFamilyId,
  PRESET_NAMES,
  PRESETS,
  setFrozen,
  updateSoftRules,
} from "./index.js";

const rules = (): FamilyRules => ({
  familyId: newFamilyId(),
  version: 1,
  frozen: false,
  hardLimits: {
    settlementAccountId: "earmark-settle.near",
    monthlyBudgetUsd: "200",
    perTransactionMaxUsdcAtomic: "150000000",
  },
  approvalAboveNgnKobo: null,
  categories: {
    electricity: { enabled: true, monthlyCapNgnKobo: null, allowedCustomerRefs: [] },
    airtime: { enabled: true, monthlyCapNgnKobo: null, allowedCustomerRefs: [] },
    data: { enabled: true, monthlyCapNgnKobo: null, allowedCustomerRefs: [] },
    tv: { enabled: true, monthlyCapNgnKobo: null, allowedCustomerRefs: [] },
  },
  updatedAt: "2026-11-03T09:00:00.000Z",
});
const usage: MonthUsage = {
  month: "202611",
  spentNgnKoboByCategory: { electricity: 0, airtime: 0, data: 0, tv: 0 },
  spentUsdcAtomic: "0",
};
const order = (category: "electricity" | "airtime" | "tv", ngn: number) => ({
  category,
  customerRef: "1111111111111",
  amountNgnKobo: ngn * 100,
  quote: {
    rateNgnPerUsd: "1325.00",
    amountUsdcAtomic: String(Math.ceil((ngn * 1_000_000) / 1325)),
    quotedAt: "2026-11-03T09:00:00.000Z",
    expiresAt: "2026-11-03T09:10:00.000Z",
  },
});

describe("rule presets", () => {
  it("only touch layer 2, and bump the version", () => {
    for (const name of PRESET_NAMES) {
      const next = applyPreset(rules(), name);
      expect(next.version).toBe(2);
      expect(next.hardLimits).toEqual(rules().hardLimits);
      expect(next.approvalAboveNgnKobo).toBe(PRESETS[name].approvalAboveNgnKobo);
    }
  });

  it("essentials turns TV off and asks before it, never refuses it", () => {
    const r = applyPreset(rules(), "essentials");
    const v = evaluateOrder(order("tv", 5_000), r, usage);
    expect(v.outcome).toBe("needs_approval");
    expect(evaluateOrder(order("electricity", 5_000), r, usage).outcome).toBe("allow");
  });

  it("caps and thresholds send exceptions to the sender", () => {
    const r = applyPreset(rules(), "strict");
    const v = evaluateOrder(order("electricity", 6_000), r, usage);
    expect(v.outcome).toBe("needs_approval");
    expect(
      evaluateOrder(order("electricity", 6_000), r, usage, { senderApproved: true }).outcome,
    ).toBe("allow");
  });

  it("freeze refuses even an approved order", () => {
    const r = setFrozen(applyPreset(rules(), "open"), true);
    expect(r.frozen).toBe(true);
    expect(evaluateOrder(order("airtime", 500), r, usage, { senderApproved: true }).outcome).toBe(
      "reject",
    );
    expect(setFrozen(r, false).frozen).toBe(false);
  });

  it("changes single rules without touching hard limits", () => {
    const r = updateSoftRules(rules(), {
      approvalAboveNgnKobo: 1_000_000,
      categories: { data: { enabled: false }, airtime: { monthlyCapNgnKobo: 500_000 } },
    });
    expect(r.categories.data.enabled).toBe(false);
    expect(r.categories.airtime.monthlyCapNgnKobo).toBe(500_000);
    expect(r.categories.electricity.enabled).toBe(true);
    expect(r.approvalAboveNgnKobo).toBe(1_000_000);
    expect(r.hardLimits).toEqual(rules().hardLimits);
    expect(updateSoftRules(r, { approvalAboveNgnKobo: null }).approvalAboveNgnKobo).toBeNull();
    expect(() =>
      updateSoftRules(rules(), { categories: { tv: { monthlyCapNgnKobo: -1 } } }),
    ).toThrow();
  });
});
