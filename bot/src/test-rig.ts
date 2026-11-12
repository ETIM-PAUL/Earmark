import { Quoter } from "@earmark/billers";
import { FUNDS_HELD_STATUSES, type Order, type ReceiptInput } from "@earmark/shared";
import { expect } from "vitest";
import { type Bot, createBot } from "./app.js";
import { type Payer, wireDemo } from "./demo.js";
import type { Extraction } from "./extract.js";
import type { RateLimiter } from "./limits.js";
import { type SimState, simVtpass } from "./mock/sim-vtpass.js";
import type { ChatModel } from "./model.js";
import { Monitor } from "./monitor.js";

// Shared by the failure drills and the approval drills: the bot core, the
// demo wiring, the executor and the float guard, against a simulated
// VTpass, payer and chain. Not part of the build.

export const CHAT = "tg:1";
export const LIGHT = "buy 5k light for my meter";
export const BIG = "buy 25k light for my meter";
export const BIG_PCM = "abeg buy 25k light for my meter";
export const WRONG_METER = "buy 5k ikeja light for meter 22222222222";

export const EXTRACTIONS: Record<string, Partial<Extraction>> = {
  [BIG]: { category: "electricity", amountNaira: 25_000, customerRef: "SELF" },
  [BIG_PCM]: { category: "electricity", amountNaira: 25_000, customerRef: "SELF", language: "pcm" },
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

export function rig(
  opts: {
    sim?: Partial<SimState>;
    payer?: Payer;
    receiptFailures?: number;
    limiter?: RateLimiter;
    /** A clock the drill moves; omit for the real one. */
    clock?: { now: Date };
  } = {},
) {
  const sim = simVtpass(opts.sim);
  const now = () => opts.clock?.now ?? new Date();
  let quoteCalls = 0;
  const realQuoter = new Quoter({
    sources: [{ name: "fixed", fetch: async () => 1346 }],
    spreadBps: 150,
    warn: () => {},
    now,
  });
  const outbox: string[] = [];
  const alerts: string[] = [];
  const refunds: string[] = [];
  const receipts: ReceiptInput[] = [];
  let receiptFailures = opts.receiptFailures ?? 0;
  let bot: Bot | null = null;

  const demo = wireDemo({
    vtpass: sim.client,
    quoter: {
      quote: async (kobo) => {
        quoteCalls += 1;
        return realQuoter.quote(kobo);
      },
    },
    now,
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
    executor: {
      purchase: { sleep: async () => {}, requerySchedule: [0, 0], now },
      sameBillGapMs: 0,
    },
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

  const handle = {
    sim,
    demo,
    bot: live,
    alerts,
    refunds,
    receipts,
    outbox,
    quoteCalls: () => quoteCalls,
    /** Open an invite, so the chat belongs to a demo family. */
    familyId: "",
    join: async () => {
      const invite = live.newInvite("Ada");
      handle.familyId = invite.familyId;
      return since(() => live.onMessage(CHAT, `/start ${invite.code}`));
    },
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
  return handle;
}
