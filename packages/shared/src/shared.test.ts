import { describe, expect, it } from "vitest";
import {
  FamilyRules,
  formatNaira,
  formatUsdc,
  hashCustomerRef,
  lagosTimestamp,
  newFamilyId,
  newFamilySalt,
  newOrderId,
  normalizeCustomerRef,
  Order,
  OrderId,
  Receipt,
  receiptFromOrder,
} from "./index.js";

const salt = "a".repeat(64);
const now = "2026-11-03T09:00:00.000Z";

async function fulfilledOrder(): Promise<Order> {
  return Order.parse({
    id: newOrderId(new Date(now)),
    familyId: newFamilyId(),
    category: "electricity",
    billerCode: "ikeja-electric",
    customerRef: "45031234567",
    customerRefHash: await hashCustomerRef(salt, "electricity", "45031234567"),
    customerName: "ADEBAYO FOLAKE",
    amountNgnKobo: 1_000_000,
    quote: {
      rateNgnPerUsd: "1612.50",
      amountUsdcAtomic: "6201550",
      quotedAt: now,
      expiresAt: "2026-11-03T09:10:00.000Z",
    },
    status: "fulfilled",
    paymentTxHash: "8Tq3",
    fulfillment: {
      billerTransactionId: "17301234",
      token: "1234-5678-9012-3456-7890",
      completedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  });
}

describe("order id", () => {
  it("starts with the Lagos date and time, as VTpass requires", () => {
    // 23:30 UTC is 00:30 the next day in Lagos
    expect(lagosTimestamp(new Date("2026-11-03T23:30:00Z"))).toBe("202611040030");
    const id = newOrderId(new Date("2026-11-03T23:30:00Z"));
    expect(id.startsWith("202611040030")).toBe(true);
    expect(OrderId.safeParse(id).success).toBe(true);
  });

  it("is unique", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newOrderId()));
    expect(ids.size).toBe(1000);
  });
});

describe("money", () => {
  it("formats naira from kobo and USDC from atomic units", () => {
    expect(formatNaira(1_000_000)).toBe("₦10,000");
    expect(formatUsdc("6201550")).toBe("$6.20");
    expect(formatUsdc("50000000")).toBe("$50.00");
  });
});

describe("customer reference hashing", () => {
  it("treats every way of writing one phone number as the same", async () => {
    const a = await hashCustomerRef(salt, "airtime", "+234 803 123 4567");
    const b = await hashCustomerRef(salt, "airtime", "08031234567");
    expect(normalizeCustomerRef("airtime", "8031234567")).toBe("08031234567");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the family salt", async () => {
    const a = await hashCustomerRef(newFamilySalt(), "airtime", "08031234567");
    const b = await hashCustomerRef(newFamilySalt(), "airtime", "08031234567");
    expect(a).not.toBe(b);
  });

  it("rejects short salts", async () => {
    await expect(hashCustomerRef("short", "tv", "123")).rejects.toThrow();
  });
});

describe("order", () => {
  it("requires a variation code for data and tv", async () => {
    const order = await fulfilledOrder();
    const res = Order.safeParse({ ...order, category: "data", billerCode: "mtn-data" });
    expect(res.success).toBe(false);
  });
});

describe("receipt", () => {
  it("carries no personal data", async () => {
    const order = await fulfilledOrder();
    const receipt = Receipt.parse({ ...receiptFromOrder(order), recordedAtMs: 0 });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(order.customerRef);
    expect(serialized).not.toContain("ADEBAYO");
    expect(serialized).not.toContain(order.fulfillment?.token);
  });

  it("rejects extra fields", async () => {
    const order = await fulfilledOrder();
    const res = Receipt.safeParse({
      ...receiptFromOrder(order),
      recordedAtMs: 0,
      customerRef: order.customerRef,
    });
    expect(res.success).toBe(false);
  });

  it("is only written for fulfilled or refunded orders", async () => {
    const order = await fulfilledOrder();
    expect(() => receiptFromOrder({ ...order, status: "paying" })).toThrow();
  });
});

describe("family rules", () => {
  it("needs a rule for every category", () => {
    const rule = { enabled: true, monthlyCapNgnKobo: null, allowedCustomerRefs: [] };
    const base = {
      familyId: newFamilyId(),
      version: 1,
      frozen: false,
      hardLimits: {
        settlementAccountId: "earmark-settle.near",
        monthlyBudgetUsdcAtomic: "62000000",
        approvalThresholdUsdcAtomic: "30000000",
      },
      approvalAboveNgnKobo: 5_000_000,
      updatedAt: now,
    };
    expect(
      FamilyRules.safeParse({
        ...base,
        categories: { electricity: rule, airtime: rule, data: rule, tv: rule },
      }).success,
    ).toBe(true);
    expect(FamilyRules.safeParse({ ...base, categories: { electricity: rule } }).success).toBe(
      false,
    );
  });
});
