import { lagosTimestamp, type Order, Receipt, type ReceiptInput } from "@earmark/shared";
import { describe, expect, it } from "vitest";
import {
  balanceKoboOf,
  FloatGuard,
  MemoryOrderStore,
  OrderExecutor,
  Quoter,
  QuoteUnavailableError,
  quoteFor,
  quoteIsFresh,
  type RateSource,
  type VtpassResponse,
} from "./index.js";
import { fakeVtpass, type Reply } from "./testing/fake-vtpass.js";

const NOW = new Date("2026-11-04T10:00:00Z"); // 11:00 in Lagos
const now = () => NOW;
const PHONE = "08011111111";
const METER = "1111111111111";

const source = (name: string, value: number | Error): RateSource => ({
  name,
  fetch: async () => {
    if (value instanceof Error) throw value;
    return value;
  },
});

describe("quoteFor", () => {
  it("takes the spread off the rate and rounds USDC up", () => {
    const q = quoteFor(1_000_000, 1346.07, 150, NOW); // ₦10,000
    // 134607 kobo/USD × 0.985 = 132587.89 → 132587
    expect(q.rateNgnPerUsd).toBe("1325.87");
    // 10,000 / 1325.87 = 7.5422175… USD → rounded up to the atomic unit
    expect(q.amountUsdcAtomic).toBe("7542218");
    expect(q.quotedAt).toBe(NOW.toISOString());
    expect(Date.parse(q.expiresAt) - NOW.getTime()).toBe(10 * 60 * 1000);
  });

  it("never charges less than the naira is worth at our rate", () => {
    for (const kobo of [100, 10_000, 99_999_900, 123_456_700]) {
      for (const rate of [1300.5, 1346.07, 1599.99]) {
        const q = quoteFor(kobo, rate, 150, NOW);
        const rateKobo = BigInt(q.rateNgnPerUsd.replace(".", ""));
        const atomic = BigInt(q.amountUsdcAtomic);
        expect(atomic * rateKobo).toBeGreaterThanOrEqual(BigInt(kobo) * 1_000_000n);
        expect((atomic - 1n) * rateKobo).toBeLessThan(BigInt(kobo) * 1_000_000n);
      }
    }
  });

  it("refuses nonsense", () => {
    expect(() => quoteFor(0, 1346, 150)).toThrow();
    expect(() => quoteFor(150.5, 1346, 150)).toThrow();
    expect(() => quoteFor(100, Number.NaN, 150)).toThrow();
    expect(() => quoteFor(100, 1346, -1)).toThrow();
    expect(() => quoteFor(100, 1346, 10_000)).toThrow();
  });

  it("expires after 10 minutes", () => {
    const q = quoteFor(100_000, 1346, 150, NOW);
    expect(quoteIsFresh(q, new Date(NOW.getTime() + 9 * 60_000))).toBe(true);
    expect(quoteIsFresh(q, new Date(NOW.getTime() + 10 * 60_000))).toBe(false);
  });
});

describe("Quoter", () => {
  const warn = () => {};

  it("uses the lower of the sources", async () => {
    const q = new Quoter({
      sources: [source("a", 1346.07), source("b", 1344.77)],
      spreadBps: 0,
      now,
      warn,
    });
    expect(await q.marketRate()).toBe(1344.77);
    expect((await q.quote(134_477_00)).amountUsdcAtomic).toBe("100000000"); // exactly $100
  });

  it("quotes from the sources that answer", async () => {
    const warnings: string[] = [];
    const q = new Quoter({
      sources: [source("down", new Error("HTTP 503")), source("silly", 3), source("ok", 1350)],
      spreadBps: 150,
      now,
      warn: (m) => warnings.push(m),
    });
    expect(await q.marketRate()).toBe(1350);
    expect(warnings).toHaveLength(2);
  });

  it("refuses when every source fails or they disagree", async () => {
    const none = new Quoter({
      sources: [source("x", new Error("down"))],
      spreadBps: 150,
      now,
      warn,
    });
    await expect(none.quote(100_000)).rejects.toBeInstanceOf(QuoteUnavailableError);
    const split = new Quoter({
      sources: [source("a", 1346), source("b", 1500)],
      spreadBps: 150,
      now,
      warn,
    });
    await expect(split.quote(100_000)).rejects.toThrow(/disagree/);
  });

  it("caches the rate for a minute", async () => {
    let calls = 0;
    let t = NOW.getTime();
    const q = new Quoter({
      sources: [
        {
          name: "count",
          fetch: async () => {
            calls++;
            return 1346;
          },
        },
      ],
      spreadBps: 150,
      now: () => new Date(t),
      warn,
    });
    await q.marketRate();
    t += 59_000;
    await q.marketRate();
    expect(calls).toBe(1);
    t += 2_000;
    await q.marketRate();
    expect(calls).toBe(2);
  });
});

describe("FloatGuard", () => {
  const bal = (naira: number) => async () =>
    ({ code: 1, contents: { balance: naira } }) as unknown as VtpassResponse;

  it("reads the VTpass balance shape", () => {
    expect(balanceKoboOf({ code: 1, contents: { balance: 1234.5 } } as never)).toBe(123_450);
    expect(balanceKoboOf({ code: 1, contents: { balance: "1996088.70" } } as never)).toBe(
      199_608_870,
    );
    expect(balanceKoboOf({ code: 1, contents: { balance: "lots" } } as never)).toBeNull();
    expect(balanceKoboOf({ code: "087" })).toBeNull();
  });

  it("stops orders that would cross the floor, alerting once", async () => {
    const alerts: string[] = [];
    const g = new FloatGuard({
      balance: bal(60_000),
      floorKobo: 50_000_00,
      alert: (m) => alerts.push(m),
      now,
    });
    expect((await g.check(5_000_00)).ok).toBe(true);
    const r = await g.check(20_000_00);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("below_floor");
      expect(r.recipient).toMatch(/paused/);
    }
    await g.check(20_000_00);
    expect(alerts).toHaveLength(1);
  });

  it("counts purchases against the cached balance", async () => {
    const g = new FloatGuard({ balance: bal(60_000), floorKobo: 50_000_00, alert: () => {}, now });
    expect((await g.check(8_000_00)).ok).toBe(true);
    g.spent(8_000_00);
    expect((await g.check(8_000_00)).ok).toBe(false);
  });

  it("fails closed when the balance can't be read", async () => {
    const g = new FloatGuard({
      balance: async () => {
        throw new Error("down");
      },
      floorKobo: 0,
      alert: () => {},
      now,
    });
    const r = await g.check(100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unreadable");
  });
});

// ── Executor ──────────────────────────────────────────────────────────

const ORDER_ID = `${lagosTimestamp(NOW)}exec00000001`;

function paidOrder(patch: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    familyId: "fam_abcdefgh12345678",
    category: "airtime",
    billerCode: "mtn",
    customerRef: PHONE,
    customerRefHash: "c".repeat(64),
    amountNgnKobo: 50_000,
    quote: quoteFor(50_000, 1346, 150, NOW),
    status: "paid",
    paymentTxHash: "payTx11111111",
    createdAt: "2026-11-04T09:58:00.000Z",
    updatedAt: "2026-11-04T09:59:00.000Z",
    ...patch,
  };
}

const deliveredReply = (token?: string): VtpassResponse => ({
  code: "000",
  requestId: ORDER_ID,
  transaction_date: "2026-11-04T10:00:05.000000Z",
  content: { transactions: { status: "delivered", transactionId: "1793748675108" } },
  ...(token ? { purchased_code: `Token : ${token}` } : {}),
});
const failedReply: VtpassResponse = {
  code: "016",
  content: { transactions: { status: "failed", transactionId: "1793748675109" } },
};
const pendingReply: VtpassResponse = {
  code: "099",
  content: { transactions: { status: "pending" } },
};
const notFoundReply: VtpassResponse = { code: "015" };
const meterFound: VtpassResponse = { code: "000", content: { Customer_Name: "TESTMETER1" } };
const meterMissing: VtpassResponse = {
  code: "000",
  content: { error: "wrong meter", WrongBillersCode: true },
};

function harness(
  script: Record<string, Reply[]>,
  opts: {
    balanceNaira?: number;
    failRefunds?: number;
    failReceipts?: number;
    now?: () => Date;
  } = {},
) {
  const { client, calls } = fakeVtpass(script);
  const store = new MemoryOrderStore();
  const receipts: ReceiptInput[] = [];
  const refunds: string[] = [];
  const alerts: string[] = [];
  const seen: string[] = [];
  let failRefunds = opts.failRefunds ?? 0;
  let failReceipts = opts.failReceipts ?? 0;
  const executor = new OrderExecutor({
    store,
    vtpass: client,
    float: new FloatGuard({
      balance: async () =>
        ({ code: 1, contents: { balance: opts.balanceNaira ?? 1_000_000 } }) as never,
      floorKobo: 10_000_00,
      alert: (m) => alerts.push(m),
      now,
    }),
    receipts: {
      record: async (r) => {
        if (failReceipts-- > 0) throw new Error("RPC timeout");
        receipts.push(r);
        return { txHash: `rcptTx${receipts.length}` };
      },
    },
    refunds: {
      refund: async (o) => {
        if (failRefunds-- > 0) throw new Error("Agent API 503");
        refunds.push(o.id);
        return { txHash: `refundTx${refunds.length}` };
      },
    },
    contactPhone: async () => PHONE,
    notify: (o) => seen.push(o.status),
    alert: (m) => alerts.push(m),
    purchase: { requerySchedule: [], sleep: async () => {}, now: opts.now ?? now },
    now: opts.now ?? now,
  });
  const paths = () => calls.map((c) => c.path);
  return { executor, store, receipts, refunds, alerts, seen, paths };
}

describe("OrderExecutor", () => {
  it("buys a paid order and writes a receipt with no personal data", async () => {
    const h = harness({ "/pay": [deliveredReply()] });
    h.store.put(paidOrder());
    const r = await h.executor.execute(ORDER_ID);
    expect(r).toMatchObject({ status: "fulfilled", waiting: false });
    expect(h.seen).toEqual(["purchasing", "fulfilled", "fulfilled"]);
    const o = await h.store.get(ORDER_ID);
    expect(o?.fulfillment?.billerTransactionId).toBe("1793748675108");
    expect(o?.receiptTxHash).toBe("rcptTx1");
    expect(h.receipts).toHaveLength(1);
    const receipt = Receipt.parse({ ...h.receipts[0], recordedAtMs: 1 });
    expect(receipt).toMatchObject({ status: "fulfilled", paymentTxHash: "payTx11111111" });
    expect(JSON.stringify(h.receipts[0])).not.toContain(PHONE);
  });

  it("checks the meter, buys, and saves the token", async () => {
    const h = harness({ "/merchant-verify": [meterFound], "/pay": [deliveredReply("2636 2054")] });
    h.store.put(
      paidOrder({
        category: "electricity",
        billerCode: "ikeja-electric",
        variationCode: "prepaid",
        customerRef: METER,
      }),
    );
    await h.executor.execute(ORDER_ID);
    expect(h.paths()).toEqual(["/merchant-verify", "/pay"]);
    expect((await h.store.get(ORDER_ID))?.fulfillment?.token).toBe("2636 2054");
  });

  it("refunds a bill VTpass failed, then writes a refund receipt", async () => {
    const h = harness({ "/pay": [failedReply] });
    h.store.put(paidOrder());
    const r = await h.executor.execute(ORDER_ID);
    expect(r.status).toBe("refunded");
    expect(h.seen).toEqual(["purchasing", "failed", "refunding", "refunded", "refunded"]);
    expect(h.refunds).toEqual([ORDER_ID]);
    const o = await h.store.get(ORDER_ID);
    expect(o?.failureReason).toMatch(/coming back/);
    expect(h.receipts[0]).toMatchObject({ status: "refunded", refundTxHash: "refundTx1" });
  });

  it("refunds without calling /pay when the meter is wrong", async () => {
    const h = harness({ "/merchant-verify": [meterMissing] });
    h.store.put(
      paidOrder({
        category: "electricity",
        billerCode: "ikeja-electric",
        customerRef: "1234567890123",
      }),
    );
    expect((await h.executor.execute(ORDER_ID)).status).toBe("refunded");
    expect(h.paths()).toEqual(["/merchant-verify"]);
    expect((await h.store.get(ORDER_ID))?.failureReason).toMatch(/meter number.*coming back/);
  });

  it("refunds without calling /pay when the float is low, and alerts", async () => {
    const h = harness({}, { balanceNaira: 10_200 });
    h.store.put(paidOrder()); // ₦500 would leave ₦9,700 < ₦10,000 floor
    expect((await h.executor.execute(ORDER_ID)).status).toBe("refunded");
    expect(h.paths()).toEqual([]);
    expect(h.alerts.some((a) => a.includes("floor"))).toBe(true);
  });

  it("refunds an order dated yesterday without calling VTpass", async () => {
    const h = harness({});
    const id = `${lagosTimestamp(new Date(NOW.getTime() - 86_400_000))}exec00000002`;
    h.store.put(paidOrder({ id }));
    expect((await h.executor.execute(id)).status).toBe("refunded");
    expect(h.paths()).toEqual([]);
  });

  it("leaves a pending bill in purchasing, then finishes it on the webhook", async () => {
    const h = harness({ "/pay": [pendingReply], "/requery": [deliveredReply()] });
    h.store.put(paidOrder());
    expect(await h.executor.execute(ORDER_ID)).toMatchObject({
      status: "purchasing",
      waiting: true,
    });
    expect(h.refunds).toEqual([]);
    expect((await h.executor.settle(ORDER_ID)).status).toBe("fulfilled");
    expect(h.paths()).toEqual(["/pay", "/requery"]);
  });

  it("never buys twice: re-running a finished order calls nothing", async () => {
    const h = harness({ "/pay": [deliveredReply()] });
    h.store.put(paidOrder());
    await h.executor.execute(ORDER_ID);
    await h.executor.execute(ORDER_ID);
    await h.executor.sweep();
    expect(h.paths()).toEqual(["/pay"]);
    expect(h.receipts).toHaveLength(1);
  });

  it("lets only one of two concurrent workers call /pay", async () => {
    const h = harness({ "/pay": [deliveredReply(), deliveredReply()] });
    h.store.put(paidOrder());
    const [a, b] = await Promise.all([h.executor.execute(ORDER_ID), h.executor.execute(ORDER_ID)]);
    expect(h.paths().filter((p) => p === "/pay")).toHaveLength(1);
    expect([a.waiting, b.waiting]).toContain(true);
  });

  it("queues a second bill for the same number instead of tripping VTpass's 019", async () => {
    let t = NOW.getTime();
    const h = harness({ "/pay": [deliveredReply(), deliveredReply()] }, { now: () => new Date(t) });
    const second = `${lagosTimestamp(NOW)}exec00000009`;
    h.store.put(paidOrder());
    h.store.put(paidOrder({ id: second, amountNgnKobo: 20_000 }));
    expect((await h.executor.execute(ORDER_ID)).status).toBe("fulfilled");
    expect(await h.executor.execute(second)).toMatchObject({ status: "paid", waiting: true });
    t += 36_000;
    expect((await h.executor.sweep()).find((r) => r.orderId === second)?.status).toBe("fulfilled");
    expect(h.paths()).toEqual(["/pay", "/pay"]);
  });

  it("queues data behind airtime to the same phone", async () => {
    const h = harness({ "/pay": [pendingReply] });
    const data = `${lagosTimestamp(NOW)}exec00000012`;
    h.store.put(paidOrder());
    h.store.put(
      paidOrder({
        id: data,
        category: "data",
        billerCode: "mtn-data",
        variationCode: "mtn-10mb-100",
      }),
    );
    expect((await h.executor.execute(ORDER_ID)).status).toBe("purchasing");
    expect(await h.executor.execute(data)).toMatchObject({ status: "paid", waiting: true });
  });

  it("queues behind a pending bill for the same number, but not a different number", async () => {
    const h = harness({ "/pay": [deliveredReply()] });
    const other = `${lagosTimestamp(NOW)}exec00000010`;
    const third = `${lagosTimestamp(NOW)}exec00000011`;
    h.store.put(paidOrder({ id: other, status: "purchasing" }));
    h.store.put(paidOrder());
    h.store.put(paidOrder({ id: third, customerRef: "08022222222" }));
    expect(await h.executor.execute(ORDER_ID)).toMatchObject({ status: "paid", waiting: true });
    expect((await h.executor.execute(third)).status).toBe("fulfilled");
  });

  it("re-sends /pay for a purchasing order VTpass never received (crash before /pay)", async () => {
    const h = harness({ "/requery": [notFoundReply], "/pay": [deliveredReply()] });
    h.store.put(paidOrder({ status: "purchasing" }));
    expect((await h.executor.sweep())[0]?.status).toBe("fulfilled");
    expect(h.paths()).toEqual(["/requery", "/pay"]);
  });

  it("past midnight, fails an unknown purchasing order only after an hour", async () => {
    const id = `${lagosTimestamp(new Date(NOW.getTime() - 86_400_000))}exec00000003`;
    const h = harness({ "/requery": [notFoundReply, notFoundReply] });
    h.store.put(paidOrder({ id, status: "purchasing", updatedAt: "2026-11-04T09:30:00.000Z" }));
    expect((await h.executor.execute(id)).status).toBe("purchasing");
    h.store.put(paidOrder({ id, status: "purchasing", updatedAt: "2026-11-04T08:30:00.000Z" }));
    expect((await h.executor.execute(id)).status).toBe("refunded");
    expect(h.paths()).toEqual(["/requery", "/requery"]);
  });

  it("keeps a failed refund in refunding, and the sweeper finishes it", async () => {
    const h = harness({ "/pay": [failedReply] }, { failRefunds: 1 });
    h.store.put(paidOrder());
    expect(await h.executor.execute(ORDER_ID)).toMatchObject({
      status: "refunding",
      waiting: true,
    });
    expect(h.alerts.some((a) => a.includes("refund failed"))).toBe(true);
    expect((await h.executor.sweep())[0]?.status).toBe("refunded");
    expect(h.refunds).toEqual([ORDER_ID]);
  });

  it("owes a receipt after a chain error, and the sweeper writes it", async () => {
    const h = harness({ "/pay": [deliveredReply()] }, { failReceipts: 1 });
    h.store.put(paidOrder());
    expect(await h.executor.execute(ORDER_ID)).toMatchObject({
      status: "fulfilled",
      waiting: true,
    });
    expect((await h.store.get(ORDER_ID))?.receiptTxHash).toBeUndefined();
    await h.executor.sweep();
    expect((await h.store.get(ORDER_ID))?.receiptTxHash).toBe("rcptTx1");
    expect(h.paths()).toEqual(["/pay"]);
  });

  it("ignores orders that aren't paid yet", async () => {
    const h = harness({});
    h.store.put(paidOrder({ status: "approved", paymentTxHash: undefined }));
    expect(await h.executor.execute(ORDER_ID)).toMatchObject({
      status: "approved",
      waiting: false,
    });
    expect(await h.executor.execute("nope")).toMatchObject({ status: "unknown_order" });
    expect(h.paths()).toEqual([]);
  });
});
