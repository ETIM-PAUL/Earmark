import { hashCustomerRef, type Order, receiptFromOrder } from "@earmark/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReceiptCard } from "./receipt-card.js";

const order: Order = {
  id: "202611061000abcdefabcdef",
  familyId: "fam_abcdefgh12345678",
  category: "electricity",
  billerCode: "ikeja-electric",
  variationCode: "prepaid",
  customerRef: "45031234567",
  customerRefHash: await hashCustomerRef("s".repeat(64), "electricity", "45031234567"),
  customerName: "MAMA NGOZI ADEYEMI",
  amountNgnKobo: 1_000_000,
  quote: {
    rateNgnPerUsd: "1325.87",
    amountUsdcAtomic: "7542218",
    quotedAt: "2026-11-06T09:00:00.000Z",
    expiresAt: "2026-11-06T09:10:00.000Z",
  },
  status: "fulfilled",
  paymentTxHash: "payTx11111111",
  fulfillment: {
    billerTransactionId: "1793748675108",
    token: "2636 2054 4059 8275 7802",
    completedAt: "2026-11-06T09:01:00.000Z",
  },
  createdAt: "2026-11-06T09:00:00.000Z",
  updatedAt: "2026-11-06T09:01:00.000Z",
};

describe("public receipt card", () => {
  it("shows amount, bill type, time and the on-chain link, and no personal data", () => {
    const receipt = {
      ...receiptFromOrder(order),
      recordedAtMs: Date.parse("2026-11-06T09:01:05Z"),
    };
    const html = renderToStaticMarkup(
      <ReceiptCard
        r={receipt}
        network="testnet"
        txHash="J7T2YEm5wdwXtyjEGboo2kCfR5LqtUDYyZCxfe1hrwyV"
        check={{ verified: true, blockHash: "x" }}
      />,
    );
    expect(html).toContain("Electricity");
    expect(html).toContain("₦10,000");
    expect(html).toContain("$7.54 USDC");
    expect(html).toContain("6 Nov 2026");
    expect(html).toContain(
      "https://testnet.nearblocks.io/txns/J7T2YEm5wdwXtyjEGboo2kCfR5LqtUDYyZCxfe1hrwyV",
    );
    expect(html).toContain("verified on NEAR testnet");
    for (const secret of [
      "45031234567",
      "MAMA",
      "NGOZI",
      "2636",
      order.customerRefHash,
      "ikeja",
      "1793748675108",
    ]) {
      expect(html).not.toContain(secret);
    }
  });

  it("says plainly when a bill was refunded", () => {
    const refunded = { ...order, status: "refunded" as const, refundTxHash: "refundTx1111" };
    const html = renderToStaticMarkup(
      <ReceiptCard r={{ ...receiptFromOrder(refunded), recordedAtMs: 0 }} network="testnet" />,
    );
    expect(html).toContain("Refunded");
    expect(html).toContain("went back to the family account");
  });
});
