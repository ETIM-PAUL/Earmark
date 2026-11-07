import { Quoter } from "@earmark/billers";
import { FUNDS_HELD_STATUSES, type Order, type ReceiptInput } from "@earmark/shared";
import { describe, expect, it } from "vitest";
import { type Bot, createBot } from "./app.js";
import { type Payer, PaymentRefused, wireDemo } from "./demo.js";
import type { Extraction } from "./extract.js";
import { RateLimiter } from "./limits.js";
import type { ChatModel } from "./model.js";
import { Monitor } from "./monitor.js";
import { type SimState, simVtpass } from "./testing/sim-vtpass.js";

/**
 * Phase 16 failure drills, end to end: the bot core, the demo wiring, the
 * order executor and the float guard, against a simulated VTpass, payer
 * and chain. No keys, no network.
 *
 * Every drill must end in a clear message plus a refund or a retry, and
 * never a lost payment: money that left the family is either a delivered
 * bill or a refund, each with a receipt, and no bill is bought twice.
 */

const CHAT = "tg:1";
const LIGHT = "buy 5k light for my meter";
const WRONG_METER = "buy 5k ikeja light for meter 22222222222";

const EXTRACTIONS: Record<string, Partial<Extraction>> = {
  [LIGHT]: { category: "electricity", amountNaira: 5000, customerRef: "SELF" },
  [WRONG_METER]: {
    category: "electricity",
    provider: "ikeja",
    amountNaira: 5000,
    customerRef: "22222222222",
  },
  hi: { intent: "help" },
};

const model: ChatModel = {
  async json(messages) {
    const text = messages.at(-1)?.content ?? "";
    const row = EXTRACTIONS[text];
    if (!row) throw new Error(`unscripted: ${text}`);
    return JSON.stringify({
      intent: "pay_bill",
      language: "en",
      category: null,
      provider: null,
      customerRef: null,
      amountNaira: null,
      bundle: null,
      meterType: null,
      choice: null,
      ...row,
    });
  },
};

function rig(
  opts: {
    sim?: Partial<SimState>;
    payer?: Payer;
    receiptFailures?: number;
    limiter?: RateLimiter;
  } = {},
) {
  const sim = simVtpass(opts.sim);
  const outbox: string[] = [];
  const alerts: string[] = [];
  const refunds: string[] = [];
  const receipts: ReceiptInput[] = [];
  let receiptFailures = opts.receiptFailures ?? 0;
  let bot: Bot | null = null;

  const demo = wireDemo({
    vtpass: sim.client,
    quoter: new Quoter({
      sources: [{ name: "fixed", fetch: async () => 1346 }],
      spreadBps: 150,
      warn: () => {},
    }),
    receipts: {
      record: async (r) => {
        if (receiptFailures > 0) {
          receiptFailures -= 1;
          throw new Error("NEAR RPC unreachable");
        }
        receipts.push(r);
        return { txHash: `tx${receipts.length}` };
      },
    },
    contractId: null,
    floatFloorNgn: 50_000,
    model,
    receiptsPageUrl: "http://localhost/receipt.html",
    onOrderUpdate: (o) => bot?.onOrderUpdate(o),
    onOrderWaiting: (o) => bot?.onOrderWaiting(o),
    alert: (m) => alerts.push(m),
    ...(opts.payer ? { payer: opts.payer } : {}),
    refunds: {
      refund: async (o) => {
        refunds.push(o.id);
        return { txHash: `refund-${o.id}` };
      },
    },
    floatCacheMs: 0,
    executor: { purchase: { sleep: async () => {}, requerySchedule: [0, 0] }, sameBillGapMs: 0 },
    tickMs: 0,
  });
  const live = createBot({
    demo,
    send: async (_chat, text) => {
      outbox.push(text);
    },
    monitor: new Monitor({ send: (m) => alerts.push(m) }),
    ...(opts.limiter ? { limiter: opts.limiter } : {}),
  });
  bot = live;

  const since = async (work: () => Promise<unknown>) => {
    const from = outbox.length;
    await work();
    await live.idle();
    return outbox.slice(from).join("\n");
  };

  return {
    sim,
    demo,
    bot: live,
    alerts,
    refunds,
    receipts,
    outbox,
    /** Open an invite, so the chat belongs to a demo family. */
    join: () => since(() => live.onMessage(CHAT, `/start ${live.newInvite("Ada").code}`)),
    say: (text: string, id?: string) => since(() => live.onMessage(CHAT, text, id)),
    tick: () => since(() => demo.tick()),
    orders: () => demo.orders(),
    /** The invariant every drill ends on. */
    async noLostMoney(): Promise<Order[]> {
      const orders = await demo.orders();
      for (const o of orders) {
        expect(FUNDS_HELD_STATUSES, `${o.id} still holds money`).not.toContain(o.status);
        expect(o.status, `${o.id} stuck paying`).not.toBe("paying");
        if (o.status === "fulfilled") {
          expect(sim.delivered.has(o.id)).toBe(true);
          expect(refunds).not.toContain(o.id);
        }
        if (o.status === "refunded") {
          expect(sim.delivered.has(o.id), `${o.id} refunded but bought`).toBe(false);
          expect(refunds.filter((id) => id === o.id)).toHaveLength(1);
        }
        if (o.status === "fulfilled" || o.status === "refunded") {
          expect(o.receiptTxHash).toBeTruthy();
          expect(receipts.filter((r) => r.orderId === o.id)).toHaveLength(1);
        }
        if (o.status === "rejected") expect(sim.delivered.has(o.id)).toBe(false);
      }
      // Every bill VTpass delivered belongs to exactly one fulfilled order.
      expect(sim.delivered.size).toBe(orders.filter((o) => o.status === "fulfilled").length);
      return orders;
    },
  };
}

describe("Phase 16 failure drills", () => {
  it("baseline: a bill is paid once, with a token and a receipt", async () => {
    const r = rig();
    await r.join();
    expect(await r.say(LIGHT)).toMatch(/MAMA NGOZI[\s\S]*₦5,000[\s\S]*Reply YES/);
    const out = await r.say("yes");
    expect(out).toMatch(/Paying now[\s\S]*Done! Light ₦5,000 paid[\s\S]*1234 5678 9012 3456 7890/);
    const [o] = await r.noLostMoney();
    expect(o?.status).toBe("fulfilled");
    expect(r.sim.pays.get(o?.id ?? "")).toBe(1);
  });

  it("VTpass down when the recipient asks: a clear message, no order", async () => {
    const r = rig();
    await r.join();
    r.sim.state.down = true;
    expect(await r.say(LIGHT)).toBe(
      "We couldn't reach the biller just now. Please try again in a minute.",
    );
    expect(await r.orders()).toHaveLength(0);
  });

  it("VTpass down at YES: the float check fails closed and the money comes back", async () => {
    const r = rig();
    await r.join();
    await r.say(LIGHT);
    // Down between the summary and the purchase: the float reading fails closed.
    r.sim.state.down = true;
    const out = await r.say("yes");
    expect(out).toMatch(/Paying now/);
    expect(out).toMatch(/Bill payments are paused[\s\S]*money is coming back/);
    const [o] = await r.noLostMoney();
    expect(o?.status).toBe("refunded");
    expect(r.alerts.join("\n")).toMatch(/VTpass balance unreadable/);
  });

  it("VTpass drops mid-purchase: we wait, requery, and buy exactly once", async () => {
    const r = rig();
    await r.join();
    await r.say(LIGHT);
    // The float check passes, then VTpass vanishes before /pay lands.
    const realPay = r.sim.client.pay.bind(r.sim.client);
    r.sim.client.pay = async (req) => {
      r.sim.state.down = true;
      return realPay(req);
    };
    const out = await r.say("yes");
    expect(out).toMatch(
      /Paying now[\s\S]*We're checking this payment\. Please don't send it again/,
    );
    let [o] = await r.orders();
    expect(o?.status).toBe("purchasing");

    // Still down: the sweep retries and stays quiet.
    expect(await r.tick()).toBe("");
    r.sim.state.down = false;
    r.sim.client.pay = realPay;
    expect(await r.tick()).toMatch(/Done! Light ₦5,000 paid/);
    [o] = await r.noLostMoney();
    expect(o?.status).toBe("fulfilled");
  });

  it("VTpass pays the bill but times out: requery finds it, never bought twice", async () => {
    const r = rig({ sim: { payTimeouts: 1 } });
    await r.join();
    await r.say(LIGHT);
    expect(await r.say("yes")).toMatch(/Done! Light ₦5,000 paid/);
    const [o] = await r.noLostMoney();
    expect(r.sim.pays.get(o?.id ?? "")).toBe(1);
  });

  it("float empty: no price is offered", async () => {
    const r = rig({ sim: { balanceNgn: 40_000 } });
    await r.join();
    expect(await r.say(LIGHT)).toBe(
      "Bill payments are paused for a short while. Please try again later.",
    );
    expect(await r.orders()).toHaveLength(0);
    expect(r.alerts.join("\n")).toMatch(/floor; new orders stopped/);
  });

  it("float drains between the price and YES: refunded with a clear message", async () => {
    const r = rig();
    await r.join();
    await r.say(LIGHT);
    r.sim.state.balanceNgn = 52_000;
    expect(await r.say("yes")).toMatch(/Bill payments are paused[\s\S]*money is coming back/);
    const [o] = await r.noLostMoney();
    expect(o?.status).toBe("refunded");
    expect(r.sim.pays.size).toBe(0);
  });

  it("wrong meter: asked again, nothing charged", async () => {
    const r = rig();
    await r.join();
    expect(await r.say(WRONG_METER)).toMatch(/couldn't find that meter number/);
    expect(await r.orders()).toHaveLength(0);
  });

  it("the biller fails the bill: refunded once, with a receipt", async () => {
    const r = rig({ sim: { failNextPay: ["016"] } });
    await r.join();
    await r.say(LIGHT);
    expect(await r.say("yes")).toMatch(/couldn't complete this payment[\s\S]*coming back/);
    const [o] = await r.noLostMoney();
    expect(o?.status).toBe("refunded");
  });

  it("double tap on YES: one bill, and the second YES is told so", async () => {
    const r = rig();
    await r.join();
    await r.say(LIGHT);
    const from = r.outbox.length;
    await Promise.all([r.bot.onMessage(CHAT, "yes"), r.bot.onMessage(CHAT, "YES")]);
    await r.bot.idle();
    const out = r.outbox.slice(from).join("\n");
    expect(out).toMatch(/already on its way \(Light ₦5,000\)/);
    expect(out.match(/Done!/g)).toHaveLength(1);
    const orders = await r.noLostMoney();
    expect(orders).toHaveLength(1);
  });

  it("a redelivered webhook is handled once", async () => {
    const r = rig();
    await r.join();
    await r.say(LIGHT);
    await r.say("yes", "wa:SM1");
    expect(await r.say("yes", "wa:SM1")).toBe("");
    expect(await r.orders()).toHaveLength(1);
    expect(r.bot.monitor.counters.duplicates).toBe(1);
  });

  it("Agent API refuses the payment: nothing bought, nothing moved, a clear message", async () => {
    const r = rig({
      payer: {
        pay: async () => {
          throw new PaymentRefused("policy: monthly budget exceeded");
        },
      },
    });
    await r.join();
    await r.say(LIGHT);
    expect(await r.say("yes")).toMatch(
      /Paying now[\s\S]*couldn't move the money for this bill\. Nothing left the account/,
    );
    const [o] = await r.noLostMoney();
    expect(o?.status).toBe("rejected");
    expect(r.sim.pays.size).toBe(0);
  });

  it("Agent API errors, then recovers: retried, bought once", async () => {
    let calls = 0;
    const r = rig({
      payer: {
        pay: async (o) => {
          calls += 1;
          if (calls === 1) throw new Error("Agent API HTTP 503");
          return { txHash: `pay-${o.id}` };
        },
      },
    });
    await r.join();
    await r.say(LIGHT);
    expect(await r.say("yes")).toMatch(/Paying now[\s\S]*We're checking this payment/);
    expect((await r.orders())[0]?.status).toBe("paying");
    expect(await r.tick()).toMatch(/Done! Light ₦5,000 paid/);
    const [o] = await r.noLostMoney();
    expect(o?.paymentTxHash).toBe(`pay-${o?.id}`);
    expect(calls).toBe(2);
  });

  it("NEAR RPC down when writing the receipt: the bill stands, the receipt follows", async () => {
    const r = rig({ receiptFailures: 1 });
    await r.join();
    await r.say(LIGHT);
    expect(await r.say("yes")).toMatch(/Done!/);
    expect((await r.orders())[0]?.receiptTxHash).toBeUndefined();
    // Left that way, the monitor says so.
    const late = new Monitor({
      send: (m) => r.alerts.push(m),
      now: () => Date.now() + 11 * 60_000,
    });
    late.check({ orders: await r.orders(), floatKobo: 900_000_00, floorKobo: 50_000_00 });
    expect(r.alerts.join("\n")).toMatch(/no receipt on-chain/);
    await r.tick();
    await r.noLostMoney();
    expect(r.alerts.join("\n")).toMatch(/receipt failed, will retry/);
  });

  it("a chat flooding the bot is slowed down, told once", async () => {
    const r = rig({ limiter: new RateLimiter({ burst: 3, refillMs: 60_000 }) });
    await r.join(); // 1
    await r.say("hi"); // 2
    await r.say("hi"); // 3
    expect(await r.say("hi")).toMatch(/too fast/);
    expect(await r.say("hi")).toBe("");
    expect(r.bot.monitor.counters.rateLimited).toBe(2);
  });

  it("the monitor flags stuck orders and a low float", async () => {
    const r = rig({ sim: { balanceNgn: 90_000 } });
    await r.join();
    await r.say(LIGHT);
    const realPay = r.sim.client.pay.bind(r.sim.client);
    r.sim.client.pay = async (req) => {
      r.sim.state.down = true;
      return realPay(req);
    };
    await r.say("yes");
    r.sim.state.down = false;
    const late = new Monitor({
      send: (m) => r.alerts.push(m),
      now: () => Date.now() + 20 * 60_000 + 5_000,
    });
    const [o] = await r.orders();
    const sum = late.check({
      orders: await r.orders(),
      floatKobo: 90_000_00,
      floorKobo: 50_000_00,
    });
    expect(sum.stuck).toEqual([{ id: o?.id, step: "purchasing", minutes: 20 }]);
    expect(r.alerts.join("\n")).toMatch(/has been purchasing for 20 min/);
    expect(r.alerts.join("\n")).toMatch(/under twice the ₦50,000 floor/);
  });
});

describe("rate limit", () => {
  it("refills over time", () => {
    let t = 0;
    const l = new RateLimiter({ burst: 2, refillMs: 1_000, now: () => t });
    expect([l.admit("a"), l.admit("a"), l.admit("a"), l.admit("a")]).toEqual([
      "ok",
      "ok",
      "warn",
      "drop",
    ]);
    expect(l.admit("b")).toBe("ok");
    t = 1_000;
    expect(l.admit("a")).toBe("ok");
    expect(l.admit("a")).toBe("warn");
    t = 10_000;
    expect([l.admit("a"), l.admit("a"), l.admit("a")]).toEqual(["ok", "ok", "warn"]);
  });
});
