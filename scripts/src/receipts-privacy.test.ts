import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { plainHashes, problems, type Receipt } from "./receipts-privacy.js";

// The audit has to catch personal data, not just pass clean receipts. The
// clean one is a real receipt from the testnet contract.

const REAL: Receipt = {
  orderId: "2026110412508o9ztieplsnb",
  familyId: "fam_t3mfwun3di9h0v5n",
  category: "airtime",
  amountNgnKobo: 75000,
  amountUsdcAtomic: "566243",
  customerRefHash: "8fe8a859c831707d3d0ed4e576b1ef6a7c40c54a5b848e75af9f1d6715a44d37",
  status: "fulfilled",
  paymentTxHash: "drill-pay:2026110412508o9ztieplsnb",
  refundTxHash: null,
  recordedAtMs: 1793793154801,
};
const plain = plainHashes();
const issues = (patch: Receipt) => problems({ ...REAL, ...patch }, plain);

describe("receipts privacy audit", () => {
  it("passes a real receipt", () => {
    expect(issues({})).toEqual([]);
  });

  it("catches a phone number in a reference", () => {
    expect(issues({ paymentTxHash: "pay-08031234567" }).join()).toMatch(/phone/);
  });

  it("catches a meter number", () => {
    expect(issues({ refundTxHash: "refund:45031234567x" }).join()).toMatch(/10\+ digits/);
  });

  it("catches a name", () => {
    expect(issues({ paymentTxHash: "MAMA NGOZI" }).join()).toMatch(/space/);
  });

  it("catches an extra field", () => {
    expect(issues({ customerName: "NGOZI" }).join()).toMatch(/fields are/);
  });

  it("catches an unsalted hash of a known number", () => {
    const unsalted = createHash("sha256").update("08011111111").digest("hex");
    expect(issues({ customerRefHash: unsalted }).join()).toMatch(/unsalted/);
  });

  it("catches an order ID whose digits aren't a timestamp", () => {
    expect(issues({ orderId: "080312345670abcdefghijkl" }).join()).toMatch(/timestamp/);
  });
});
