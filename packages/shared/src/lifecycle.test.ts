import { describe, expect, it } from "vitest";
import {
  advance,
  canTransition,
  FUNDS_HELD_STATUSES,
  isTerminal,
  newFamilyId,
  newOrderId,
  type Order,
  OrderStatus,
  orderStateDiagram,
  TERMINAL_STATUSES,
  TRANSITIONS,
  TransitionError,
} from "./index.js";

const now = "2026-11-03T09:00:00.000Z";

function draft(): Order {
  return {
    id: newOrderId(new Date(now)),
    familyId: newFamilyId(),
    category: "electricity",
    billerCode: "ikeja-electric",
    customerRef: "45031234567",
    customerRefHash: "a".repeat(64),
    amountNgnKobo: 1_000_000,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

const quote = {
  rateNgnPerUsd: "1612.50",
  amountUsdcAtomic: "6201550",
  quotedAt: now,
  expiresAt: "2026-11-03T09:10:00.000Z",
};

function reachable(from: OrderStatus): Set<OrderStatus> {
  const seen = new Set<OrderStatus>([from]);
  const queue = [from];
  while (queue.length) {
    for (const next of TRANSITIONS[queue.shift() as OrderStatus]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe("transition table", () => {
  it("covers every status", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...OrderStatus.options].sort());
  });

  it("reaches every status from draft", () => {
    expect([...reachable("draft")].sort()).toEqual([...OrderStatus.options].sort());
  });

  it("never strands money: every funds-held status ends in fulfilled or refunded", () => {
    for (const s of FUNDS_HELD_STATUSES) {
      const ends = [...reachable(s)].filter(isTerminal);
      expect(
        ends.every((e) => e === "fulfilled" || e === "refunded"),
        s,
      ).toBe(true);
    }
  });

  it("cannot refund money we never received", () => {
    for (const s of ["draft", "awaiting_confirmation", "awaiting_approval", "approved", "paying"]) {
      expect(canTransition(s as OrderStatus, "refunding")).toBe(false);
      expect(canTransition(s as OrderStatus, "failed")).toBe(false);
    }
  });

  it("has six terminal statuses", () => {
    expect(TERMINAL_STATUSES.sort()).toEqual(
      ["cancelled", "declined", "expired", "fulfilled", "refunded", "rejected"].sort(),
    );
  });

  it("renders a mermaid diagram", () => {
    expect(orderStateDiagram()).toContain("paid --> purchasing");
  });
});

describe("advance", () => {
  it("walks the happy path to fulfilled", () => {
    let o = advance(draft(), "awaiting_confirmation", { quote, customerName: "ADEBAYO FOLAKE" });
    o = advance(o, "approved");
    o = advance(o, "paying");
    o = advance(o, "paid", { paymentTxHash: "8Tq3" });
    o = advance(o, "purchasing");
    o = advance(o, "fulfilled", {
      fulfillment: { billerTransactionId: "1730", token: "1234", completedAt: now },
    });
    expect(o.status).toBe("fulfilled");
  });

  it("walks a biller failure to refunded", () => {
    let o: Order = { ...draft(), status: "purchasing", quote, paymentTxHash: "8Tq3" };
    o = advance(o, "failed", { failureReason: "The meter could not be credited." });
    o = advance(o, "refunding");
    o = advance(o, "refunded", { refundTxHash: "9Ab" });
    expect(o.status).toBe("refunded");
  });

  it("goes through the sender's approval", () => {
    let o = advance(draft(), "awaiting_confirmation", { quote, customerName: "ADEBAYO" });
    o = advance(o, "awaiting_approval", {
      approval: { reason: "Above ₦50,000", requestedAt: now },
    });
    expect(() => advance(o, "approved")).toThrow(/approval decision/);
    o = advance(o, "approved", {
      approval: { reason: "Above ₦50,000", requestedAt: now, decision: "approved", decidedAt: now },
    });
    expect(o.status).toBe("approved");
  });

  it("refuses moves outside the table", () => {
    expect(() => advance(draft(), "paid", { paymentTxHash: "x" })).toThrow(TransitionError);
  });

  it("refuses a confirmation without the looked-up customer name", () => {
    expect(() => advance(draft(), "awaiting_confirmation", { quote })).toThrow(/customer name/);
  });

  it("needs a reason for every unhappy ending", () => {
    const o = { ...draft(), status: "awaiting_confirmation" as const, quote };
    expect(() => advance(o, "rejected")).toThrow(/failureReason/);
  });

  it("does not mutate the input", () => {
    const o = draft();
    advance(o, "cancelled");
    expect(o.status).toBe("draft");
  });
});
