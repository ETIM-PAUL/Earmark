import { describe, expect, it } from "vitest";
import { naira, statusLabel, timeLeft, usdNumber, usdToNaira } from "./format.js";

describe("money, side by side", () => {
  it("shows naira next to dollars at the quoted rate", () => {
    expect(usdNumber("$18.85")).toBe(18.85);
    expect(usdToNaira("$100.00", "1325.81")).toBe("₦132,581");
    expect(usdToNaira("$0.00", "1325.81")).toBe("₦0");
    expect(naira(25_000)).toBe("₦25,000");
  });

  it("says nothing rather than guess when there is no rate", () => {
    expect(usdToNaira("$100.00", null)).toBeNull();
    expect(usdToNaira("?", "1325.81")).toBeNull();
    expect(usdToNaira("$100.00", "abc")).toBeNull();
  });
});

describe("what an order's status means to a sender", () => {
  it("labels every status the server can send", () => {
    const all = [
      "fulfilled",
      "refunded",
      "awaiting_approval",
      "approved",
      "paying",
      "paid",
      "purchasing",
      "failed",
      "refunding",
      "declined",
      "rejected",
      "expired",
    ];
    for (const s of all) expect(statusLabel(s).text, s).not.toBe(s);
    expect(statusLabel("fulfilled")).toEqual({ text: "Paid", tone: "ok" });
    expect(statusLabel("awaiting_approval")).toEqual({ text: "Needs you", tone: "wait" });
    expect(statusLabel("refunded").tone).toBe("bad");
  });
});

describe("time left on a request", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  it("counts down in plain words", () => {
    expect(timeLeft("2026-11-12T10:12:00Z", now)).toBe("in 12 min");
    expect(timeLeft("2026-11-12T13:20:00Z", now)).toBe("in 3 h 20 min");
    expect(timeLeft("2026-11-12T09:59:00Z", now)).toBe("now");
  });
});
