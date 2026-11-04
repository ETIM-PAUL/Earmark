import { lagosTimestamp } from "@earmark/shared";
import { describe, expect, it } from "vitest";
import {
  type BillPurchase,
  buildPayRequest,
  classifyPay,
  classifyRequery,
  cleanToken,
  describeCode,
  KNOWN_CODES,
  lookupCustomer,
  type PurchaseInputError,
  parseWebhook,
  purchaseBill,
  requestIdIsToday,
  type VtpassResponse,
} from "./index.js";
import { fakeVtpass } from "./testing/fake-vtpass.js";

const NOW = new Date("2026-11-04T10:00:00Z"); // 11:00 in Lagos
const ORDER_ID = `${lagosTimestamp(NOW)}abcdef123456`;

const delivered = (extra: Partial<VtpassResponse> = {}): VtpassResponse => ({
  code: "000",
  response_description: "TRANSACTION SUCCESSFUL",
  requestId: ORDER_ID,
  transaction_date: "2026-11-04T10:00:05.000000Z",
  content: { transactions: { status: "delivered", transactionId: "17416102247366731230557150" } },
  ...extra,
});
const withStatus = (code: string, status?: string): VtpassResponse => ({
  code,
  content: { transactions: status ? { status } : {} },
});

const airtime: BillPurchase = {
  orderId: ORDER_ID,
  category: "airtime",
  billerCode: "mtn",
  customerRef: "08011111111",
  amountNgnKobo: 10_000,
  contactPhone: "08011111111",
};
const opts = { now: () => NOW, sleep: async () => {}, requerySchedule: [1, 1, 1] };

describe("VtpassClient", () => {
  it("signs GETs with the public key and POSTs with the secret key", async () => {
    const { client, calls } = fakeVtpass({
      "/balance": [{ code: 1 } as unknown as VtpassResponse],
      "/requery": [delivered()],
    });
    await client.balance();
    await client.requery(ORDER_ID);
    expect(calls[0]?.headers).toEqual({ "api-key": "api", "public-key": "PK_pub" });
    expect(calls[1]?.headers).toMatchObject({ "api-key": "api", "secret-key": "SK_sec" });
    expect(calls[1]?.headers).not.toHaveProperty("public-key");
    expect(calls[1]?.body).toEqual({ request_id: ORDER_ID });
  });

  it("turns timeouts, network errors and non-JSON into transport errors", async () => {
    const { client } = fakeVtpass({
      "/requery": ["timeout", "network", { status: 502, text: "<html>bad gateway</html>" }],
    });
    await expect(client.requery(ORDER_ID)).rejects.toMatchObject({ reason: "timeout" });
    await expect(client.requery(ORDER_ID)).rejects.toMatchObject({ reason: "network" });
    await expect(client.requery(ORDER_ID)).rejects.toMatchObject({ reason: "http", status: 502 });
  });
});

describe("buildPayRequest", () => {
  it("uses the order ID as request_id and the topped-up number as phone for airtime", () => {
    expect(buildPayRequest(airtime, NOW)).toEqual({
      request_id: ORDER_ID,
      serviceID: "mtn",
      amount: 100,
      phone: "08011111111",
    });
  });

  it("sends the meter type as variation_code for electricity", () => {
    const req = buildPayRequest(
      {
        ...airtime,
        category: "electricity",
        billerCode: "ikeja-electric",
        customerRef: "1111111111111",
        amountNgnKobo: 100_000,
        contactPhone: "08030000000",
      },
      NOW,
    );
    expect(req).toEqual({
      request_id: ORDER_ID,
      serviceID: "ikeja-electric",
      billersCode: "1111111111111",
      variation_code: "prepaid",
      amount: 1000,
      phone: "08030000000",
    });
  });

  it("sends a bouquet change with no amount for TV", () => {
    const req = buildPayRequest(
      {
        ...airtime,
        category: "tv",
        billerCode: "dstv",
        variationCode: "dstv-padi",
        customerRef: "1212121212",
        amountNgnKobo: 185_000,
      },
      NOW,
    );
    expect(req).toMatchObject({
      subscription_type: "change",
      quantity: 1,
      variation_code: "dstv-padi",
    });
    expect(req).not.toHaveProperty("amount");
  });

  it("refuses bad input before anything is sent", () => {
    const reason = (p: Partial<BillPurchase>) => {
      try {
        buildPayRequest({ ...airtime, ...p }, NOW);
        return "accepted";
      } catch (e) {
        return (e as PurchaseInputError).reason;
      }
    };
    expect(reason({ billerCode: "foreign-airtime" })).toBe("unknown_service");
    expect(reason({ amountNgnKobo: 10_050 })).toBe("bad_amount");
    expect(reason({ amountNgnKobo: 0 })).toBe("bad_amount");
    expect(reason({ category: "data", billerCode: "mtn-data" })).toBe("missing_variation");
    expect(
      reason({ category: "electricity", billerCode: "ikeja-electric", variationCode: "x" }),
    ).toBe("bad_meter_type");
    expect(reason({ orderId: "not-an-order" })).toBe("bad_order_id");
  });

  it("refuses an order ID from yesterday, because VTpass would answer 085", () => {
    const yesterday = `${lagosTimestamp(new Date(NOW.getTime() - 86_400_000))}abcdef123456`;
    expect(requestIdIsToday(yesterday, NOW)).toBe(false);
    expect(() => buildPayRequest({ ...airtime, orderId: yesterday }, NOW)).toThrow(
      /not dated today/,
    );
  });

  it("dates request IDs in Lagos time, not UTC", () => {
    // 23:30 UTC on Nov 3 is 00:30 on Nov 4 in Lagos.
    const lateUtc = new Date("2026-11-03T23:30:00Z");
    expect(requestIdIsToday("202611040030abcdef123456", lateUtc)).toBe(true);
    expect(requestIdIsToday("202611032330abcdef123456", lateUtc)).toBe(false);
  });
});

describe("classify", () => {
  it("reads 000 + delivered as delivered, with the token cleaned", () => {
    const o = classifyPay(
      delivered({ token: "Token : 26362054405982757802", units: "79.9 kWh", purchased_code: "x" }),
    );
    expect(o.kind).toBe("delivered");
    if (o.kind !== "delivered") return;
    expect(o.fulfillment).toEqual({
      billerTransactionId: "17416102247366731230557150",
      token: "26362054405982757802",
      units: "79.9 kWh",
      completedAt: "2026-11-04T10:00:05.000Z",
    });
  });

  it("leaves token and units off airtime", () => {
    const o = classifyPay(delivered({ purchased_code: "", units: "N/A" }));
    expect(o.kind === "delivered" && o.fulfillment).toEqual({
      billerTransactionId: "17416102247366731230557150",
      completedAt: "2026-11-04T10:00:05.000Z",
    });
  });

  it.each([
    ["000", "initiated", "pending"],
    ["000", "pending", "pending"],
    ["000", "failed", "failed"],
    ["000", "reversed", "failed"],
    ["040", "reversed", "failed"],
    ["016", undefined, "failed"],
    ["099", undefined, "pending"],
    ["089", undefined, "pending"],
    ["083", undefined, "pending"],
    ["030", undefined, "pending"],
    ["999", undefined, "pending"],
    ["018", undefined, "refused"],
    ["087", undefined, "refused"],
    ["091", undefined, "refused"],
  ])("pay %s/%s → %s", (code, status, kind) => {
    expect(classifyPay(withStatus(code, status)).kind).toBe(kind);
  });

  it("never calls a delivered status without a transaction ID delivered", () => {
    expect(
      classifyPay({ code: "000", content: { transactions: { status: "delivered" } } }).kind,
    ).toBe("pending");
  });

  it("labels 000 + pending as still processing, not as an unexpected answer", () => {
    expect(classifyPay(withStatus("000", "pending"))).toMatchObject({
      kind: "pending",
      message: { code: "099" },
    });
    expect(classifyPay(withStatus("999")).kind === "pending").toBe(true);
    expect(classifyPay(withStatus("999"))).toMatchObject({ message: { code: "999" } });
  });

  it("treats requery 015 as not found, and a requery never refuses", () => {
    const o = classifyRequery({ code: "015" });
    expect(o).toMatchObject({ kind: "pending", notFound: true });
    expect(classifyRequery({ code: "087" }).kind).toBe("pending");
  });

  it("marks only fixable-later refusals as retryable", () => {
    expect(classifyPay({ code: "018" })).toMatchObject({ retryable: true });
    expect(classifyPay({ code: "013" })).toMatchObject({ retryable: false });
  });
});

describe("purchaseBill", () => {
  it("returns delivered straight from /pay", async () => {
    const { client, calls } = fakeVtpass({ "/pay": [delivered()] });
    expect((await purchaseBill(client, airtime, opts)).kind).toBe("delivered");
    expect(calls.map((c) => c.path)).toEqual(["/pay"]);
  });

  it("requeries a pending purchase until it is delivered", async () => {
    const { client, calls } = fakeVtpass({
      "/pay": [withStatus("099")],
      "/requery": [withStatus("000", "pending"), delivered()],
    });
    expect((await purchaseBill(client, airtime, opts)).kind).toBe("delivered");
    expect(calls.map((c) => c.path)).toEqual(["/pay", "/requery", "/requery"]);
  });

  it("after a timeout, resends /pay with the same request_id only if VTpass never saw it", async () => {
    const { client, calls } = fakeVtpass({
      "/pay": ["timeout", delivered()],
      "/requery": [{ code: "015" }],
    });
    expect((await purchaseBill(client, airtime, opts)).kind).toBe("delivered");
    expect(calls.map((c) => c.path)).toEqual(["/pay", "/requery", "/pay"]);
    expect(calls[0]?.body).toEqual(calls[2]?.body);
  });

  it("treats 014 on a resend as our earlier attempt, never as a refusal", async () => {
    const { client } = fakeVtpass({
      "/pay": ["timeout", { code: "014" }],
      "/requery": [{ code: "015" }, delivered()],
    });
    expect((await purchaseBill(client, airtime, opts)).kind).toBe("delivered");
  });

  it("stays pending when time runs out, and never reports failure on silence", async () => {
    const { client, calls } = fakeVtpass({
      "/pay": ["timeout"],
      "/requery": ["timeout", "network", withStatus("000", "initiated")],
    });
    expect((await purchaseBill(client, airtime, opts)).kind).toBe("pending");
    expect(calls.filter((c) => c.path === "/pay")).toHaveLength(1);
  });

  it("resends at most maxResends times", async () => {
    const { client, calls } = fakeVtpass({
      "/pay": ["timeout", "timeout"],
      "/requery": [{ code: "015" }, { code: "015" }, { code: "015" }],
    });
    const o = await purchaseBill(client, airtime, opts);
    expect(o).toMatchObject({ kind: "pending", notFound: true });
    expect(calls.filter((c) => c.path === "/pay")).toHaveLength(2);
  });

  it("does not resend once Lagos midnight has passed", async () => {
    let t = NOW;
    const { client, calls } = fakeVtpass({
      "/pay": ["timeout"],
      "/requery": [{ code: "015" }],
    });
    await purchaseBill(client, airtime, {
      ...opts,
      requerySchedule: [1],
      now: () => t,
      sleep: async () => {
        t = new Date(NOW.getTime() + 86_400_000);
      },
    });
    expect(calls.filter((c) => c.path === "/pay")).toHaveLength(1);
  });

  it("returns failed and refused with a plain message", async () => {
    const failed = fakeVtpass({ "/pay": [withStatus("016")] });
    const o1 = await purchaseBill(failed.client, airtime, opts);
    expect(o1.kind === "failed" && o1.message.recipient).toMatch(/money is coming back/);

    const refused = fakeVtpass({ "/pay": [{ code: "018" }] });
    const o2 = await purchaseBill(refused.client, airtime, opts);
    expect(o2).toMatchObject({ kind: "refused", message: { code: "018", alert: true } });
  });
});

describe("lookupCustomer", () => {
  const meter = {
    category: "electricity" as const,
    billerCode: "ikeja-electric",
    customerRef: "1111111111111",
  };

  it("returns the customer name for a good meter", async () => {
    const { client, calls } = fakeVtpass({
      "/merchant-verify": [
        { code: "000", content: { Customer_Name: "TESTMETER1", WrongBillersCode: false } },
      ],
    });
    expect(await lookupCustomer(client, meter)).toMatchObject({
      ok: true,
      customerName: "TESTMETER1",
    });
    expect(calls[0]?.body).toEqual({
      serviceID: "ikeja-electric",
      billersCode: "1111111111111",
      type: "prepaid",
    });
  });

  it("says not found for a wrong meter", async () => {
    const { client } = fakeVtpass({
      "/merchant-verify": [{ code: "000", content: { error: "Meter not found" } }],
    });
    expect(await lookupCustomer(client, meter)).toMatchObject({
      ok: false,
      reason: "not_found",
      recipient: expect.stringMatching(/meter number/),
    });
  });

  it("blames the biller, not the number, when our credentials fail", async () => {
    const { client } = fakeVtpass({ "/merchant-verify": [{ code: "087" }] });
    expect(await lookupCustomer(client, meter)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("sends no type for TV and skips the call for airtime", async () => {
    const { client, calls } = fakeVtpass({
      "/merchant-verify": [{ code: "000", content: { Customer_Name: "TEST METER" } }],
    });
    await lookupCustomer(client, { category: "tv", billerCode: "dstv", customerRef: "1212121212" });
    expect(calls[0]?.body).toEqual({ serviceID: "dstv", billersCode: "1212121212" });
    expect(await lookupCustomer(client, { ...airtime })).toEqual({ ok: true, raw: null });
    expect(calls).toHaveLength(1);
  });
});

describe("parseWebhook", () => {
  it("takes only the request ID from a transaction update", () => {
    expect(
      parseWebhook({ type: "transaction-update", data: { code: "000", requestId: ORDER_ID } }),
    ).toEqual({ type: "transaction-update", requestId: ORDER_ID });
  });

  it("ignores other types and foreign request IDs", () => {
    expect(parseWebhook({ type: "variations-update", data: {} }).type).toBe("ignored");
    expect(
      parseWebhook({ type: "transaction-update", data: { requestId: "ELAET1RA7PC06250" } }).type,
    ).toBe("ignored");
    expect(parseWebhook(null).type).toBe("ignored");
  });
});

describe("messages", () => {
  it("has a recipient line and an operator line for every known code", () => {
    for (const code of KNOWN_CODES) {
      const m = describeCode(code);
      expect(m.recipient.length).toBeGreaterThan(10);
      expect(m.operator.length).toBeGreaterThan(5);
    }
  });

  it("never claims a refund for an unknown code", () => {
    expect(describeCode("777").recipient).not.toMatch(/coming back/);
  });

  it("cleans tokens", () => {
    expect(cleanToken("TOKEN: 1234")).toBe("1234");
    expect(cleanToken("N/A")).toBeUndefined();
    expect(cleanToken(undefined)).toBeUndefined();
  });
});
