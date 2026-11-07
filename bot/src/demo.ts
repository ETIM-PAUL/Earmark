import { readFile } from "node:fs/promises";
import {
  DEFAULT_RATE_SOURCES,
  type ExecutorDeps,
  FloatGuard,
  lookupCustomer,
  MemoryOrderStore,
  NearReceiptWriter,
  OrderExecutor,
  Quoter,
  type ReceiptWriter,
  type Refunds,
  VtpassClient,
} from "@earmark/billers";
import {
  advance,
  CATEGORIES,
  type FamilyRules,
  FUNDS_HELD_STATUSES,
  lagosMonth,
  newFamilyId,
  newFamilySalt,
  type Order,
} from "@earmark/shared";
import type { KeyPairString } from "near-api-js";
import type { BotPorts, Family } from "./dialog.js";
import type { ChatModel } from "./model.js";
import { isPlainDataBundle, type Option } from "./variations.js";

/**
 * Demo wiring until the order service lands (Phases 8 and 11). Real: VTpass
 * sandbox lookups and purchases, live quotes, the float guard, the Phase 9
 * executor and receipts on the testnet contract. Simulated: the family's
 * transfer to settlement and the refund, and the sender's approval card.
 *
 * Each demo family is wired to the VTpass sandbox's test meter, smartcard
 * and phone; a chat joins one through its invite link. Refuses to run
 * against live VTpass.
 *
 * `wireDemo` takes every outside piece as a port, so the failure drills can
 * run the same wiring against a simulated VTpass, payer and chain.
 */

export interface DemoConfig {
  vtpass: { baseUrl: string; apiKey: string; publicKey: string; secretKey: string };
  spreadBps: number;
  floatFloorNgn: number;
  model: ChatModel;
  /** .earmark/receipts-testnet.json from pnpm deploy:receipts:testnet, if present. */
  testnetStateFile: string;
  /** e.g. http://localhost:5173/receipt.html */
  receiptsPageUrl: string;
  /** Tells a chat that its order moved. */
  onOrderUpdate: (order: Order) => void;
  /** Tells a chat that its order is taking a while. */
  onOrderWaiting?: (order: Order) => void;
  alert?: (msg: string) => void;
}

/**
 * The family account paying settlement for one order (Phase 8, through the
 * Agent API). Throw PaymentRefused when no money moved; any other error
 * means "try again", and the order waits in `paying`.
 */
export interface Payer {
  pay(order: Order): Promise<{ txHash: string }>;
}

export class PaymentRefused extends Error {
  constructor(readonly detail: string) {
    super(`payment refused: ${detail}`);
    this.name = "PaymentRefused";
  }
}

/** What the recipient hears when the family account can't pay settlement. */
export const PAYMENT_REFUSED =
  "We couldn't move the money for this bill. Nothing left the account. Please try again later.";

export interface DemoDeps {
  vtpass: VtpassClient;
  quoter: Pick<Quoter, "quote">;
  receipts: ReceiptWriter;
  /** For receipt links; null when receipts aren't on-chain. */
  contractId: string | null;
  floatFloorNgn: number;
  model: ChatModel;
  receiptsPageUrl: string;
  onOrderUpdate: (order: Order) => void;
  onOrderWaiting?: (order: Order) => void;
  alert?: (msg: string) => void;
  /** Default: a simulated transfer that always lands. */
  payer?: Payer;
  /** Default: a simulated refund that always lands. */
  refunds?: Refunds;
  /** Reuse a float reading this long. Default 30 s. */
  floatCacheMs?: number;
  executor?: Pick<ExecutorDeps, "purchase" | "sameBillGapMs" | "unknownAfterMs">;
  /** Run tick() on a timer this often. 0: only when called. Default 15 s. */
  tickMs?: number;
}

export interface DemoWiring {
  ports: BotPorts;
  executor: OrderExecutor;
  store: MemoryOrderStore;
  float: FloatGuard;
  receiptLink: (o: Order) => string | null;
  createFamily: (senderName?: string) => Family;
  connect: (chat: string, familyId: string) => boolean;
  contractId: string | null;
  /** Retry payments to settlement, then sweep the executor. */
  tick: () => Promise<void>;
  /** Every order, newest first. */
  orders: () => Promise<Order[]>;
  floorKobo: number;
  /** Resolves when no payment or purchase is running in the background. */
  settled: () => Promise<void>;
}

const SANDBOX = { phone: "08011111111", meter: "1111111111111", smartcard: "1212121212" };

const rule = (): FamilyRules["categories"]["airtime"] => ({
  enabled: true,
  monthlyCapNgnKobo: null,
  allowedCustomerRefs: [],
});

function demoRules(familyId: string, at: Date): FamilyRules {
  return {
    familyId,
    version: 1,
    frozen: false,
    hardLimits: {
      settlementAccountId: "earmark-settle.near",
      monthlyBudgetUsd: "100",
      perTransactionMaxUsdcAtomic: "50000000",
    },
    approvalAboveNgnKobo: 20_000_00,
    categories: Object.fromEntries(
      CATEGORIES.map((c) => [c, rule()]),
    ) as unknown as FamilyRules["categories"],
    updatedAt: at.toISOString(),
  };
}

/** The demo against the VTpass sandbox, live rates and the testnet contract. */
export async function demoPorts(cfg: DemoConfig): Promise<DemoWiring> {
  if (!cfg.vtpass.baseUrl.includes("sandbox")) {
    throw new Error("demo mode runs against the VTpass sandbox only");
  }
  let receipts: ReceiptWriter;
  let contractId: string | null = null;
  try {
    const t = JSON.parse(await readFile(cfg.testnetStateFile, "utf8")) as {
      contract: { accountId: string };
      service: { accountId: string; privateKey: string };
    };
    contractId = t.contract.accountId;
    receipts = new NearReceiptWriter({
      rpcUrl: "https://rpc.testnet.fastnear.com",
      contractId,
      serviceAccountId: t.service.accountId,
      servicePrivateKey: t.service.privateKey as KeyPairString,
    });
  } catch {
    console.warn(
      "no testnet receipts contract (pnpm deploy:receipts:testnet); receipts are skipped",
    );
    receipts = { record: async (r) => ({ txHash: `not-recorded:${r.orderId}` }) };
  }
  return wireDemo({
    vtpass: new VtpassClient(cfg.vtpass),
    quoter: new Quoter({ sources: DEFAULT_RATE_SOURCES, spreadBps: cfg.spreadBps }),
    receipts,
    contractId,
    floatFloorNgn: cfg.floatFloorNgn,
    model: cfg.model,
    receiptsPageUrl: cfg.receiptsPageUrl,
    onOrderUpdate: cfg.onOrderUpdate,
    ...(cfg.onOrderWaiting ? { onOrderWaiting: cfg.onOrderWaiting } : {}),
    ...(cfg.alert ? { alert: cfg.alert } : {}),
  });
}

export function wireDemo(deps: DemoDeps): DemoWiring {
  const { vtpass, quoter, receipts, contractId } = deps;
  if (!vtpass.isSandbox) throw new Error("demo mode runs against the VTpass sandbox only");
  const alert = deps.alert ?? ((m: string) => console.error(`ALERT ${m}`));
  const store = new MemoryOrderStore();
  const float = new FloatGuard({
    balance: () => vtpass.balance(),
    floorKobo: deps.floatFloorNgn * 100,
    alert,
    ...(deps.floatCacheMs !== undefined ? { cacheMs: deps.floatCacheMs } : {}),
  });
  const payer: Payer = deps.payer ?? { pay: async (o) => ({ txHash: `demo-pay:${o.id}` }) };
  const inflight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
  };

  const families = new Map<string, Family>();
  /** chat → familyId, set when the recipient opens their invite link. */
  const chats = new Map<string, string>();

  /** A demo family on the VTpass sandbox's test meter, smartcard and phone. */
  const createFamily = (senderName = "Ada"): Family => {
    const familyId = newFamilyId();
    const at = new Date();
    const f: Family = {
      familyId,
      salt: newFamilySalt(),
      senderName,
      recipientPhone: SANDBOX.phone,
      saved: [
        {
          category: "electricity",
          billerCode: "ikeja-electric",
          ref: SANDBOX.meter,
          label: "home meter",
          meterType: "prepaid",
        },
        { category: "tv", billerCode: "dstv", ref: SANDBOX.smartcard, label: "house DStv" },
      ],
      rules: demoRules(familyId, at),
      usage: {
        month: lagosMonth(at),
        spentNgnKoboByCategory: { electricity: 0, airtime: 0, data: 0, tv: 0 },
        spentUsdcAtomic: "0",
      },
    };
    families.set(familyId, f);
    return f;
  };
  const connect = (chat: string, familyId: string): boolean => {
    if (!families.has(familyId)) return false;
    chats.set(chat, familyId);
    return true;
  };
  const executor = new OrderExecutor({
    store,
    vtpass,
    float,
    receipts,
    refunds: deps.refunds ?? { refund: async (o) => ({ txHash: `demo-refund:${o.id}` }) },
    contactPhone: async () => SANDBOX.phone,
    notify: deps.onOrderUpdate,
    alert,
    ...deps.executor,
  });

  /** Tell the chat once a bill is taking a while; the update follows when it moves. */
  const waited = (status: Order["status"], id: string) => {
    if (status !== "purchasing" && status !== "paying") return;
    track(
      store
        .get(id)
        .then((o) => o && deps.onOrderWaiting?.(o))
        .catch(() => {}),
    );
  };
  const run = (id: string) =>
    executor
      .execute(id)
      .then((r) => r.waiting && waited(r.status as Order["status"], id))
      .catch((e) => alert(`order ${id}: executor failed: ${String(e)}`));

  /**
   * paying ─► paid, or ─► rejected when the payment is refused (no money
   * moved). Any other error leaves it in paying for the next tick: the
   * Agent API call is idempotent per order ID (Phase 8), so a retry can't
   * pay twice.
   */
  const payOut = async (paying: Order): Promise<void> => {
    let next: Order;
    try {
      const { txHash } = await payer.pay(paying);
      next = advance(paying, "paid", { paymentTxHash: txHash });
    } catch (e) {
      if (!(e instanceof PaymentRefused)) {
        alert(`order ${paying.id}: payment to settlement failed, will retry: ${String(e)}`);
        waited("paying", paying.id);
        return;
      }
      alert(`order ${paying.id}: ${e.message}`);
      next = advance(paying, "rejected", { failureReason: PAYMENT_REFUSED });
    }
    if (!(await store.replace(paying, next))) return; // someone else moved it
    deps.onOrderUpdate(next);
    if (next.status === "paid") await run(next.id);
  };

  const allOrders = async () =>
    (
      await store.listByStatus([
        "approved",
        "awaiting_approval",
        "rejected",
        "paying",
        "paid",
        "purchasing",
        "fulfilled",
        "failed",
        "refunding",
        "refunded",
      ])
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const familyOrders = async (familyId: string) =>
    (await allOrders()).filter((o) => o.familyId === familyId);

  const variationCache = new Map<string, Option[]>();

  const ports: BotPorts = {
    model: deps.model,
    family: async (chat) => {
      const id = chats.get(chat);
      const f = id ? families.get(id) : undefined;
      if (!f) return null;
      // Usage counts what's paid plus money in flight, this Lagos month.
      const month = lagosMonth();
      const counted = (await familyOrders(f.familyId)).filter(
        (o) =>
          (o.status === "fulfilled" ||
            FUNDS_HELD_STATUSES.includes(o.status) ||
            o.status === "paying") &&
          o.id.startsWith(month),
      );
      f.usage = {
        month,
        spentNgnKoboByCategory: Object.fromEntries(
          CATEGORIES.map((c) => [
            c,
            counted.filter((o) => o.category === c).reduce((n, o) => n + o.amountNgnKobo, 0),
          ]),
        ) as Family["usage"]["spentNgnKoboByCategory"],
        spentUsdcAtomic: counted
          .reduce((n, o) => n + BigInt(o.quote?.amountUsdcAtomic ?? "0"), 0n)
          .toString(),
      };
      return f;
    },
    lookup: (input) => lookupCustomer(vtpass, input),
    quote: async (kobo) => {
      const guard = await float.check(kobo);
      if (!guard.ok) throw Object.assign(new Error(guard.reason), { recipient: guard.recipient });
      return quoter.quote(kobo);
    },
    variations: async (serviceId) => {
      const hit = variationCache.get(serviceId);
      if (hit) return hit;
      const list = (await vtpass.variations(serviceId))
        .filter((v) => !serviceId.endsWith("-data") || isPlainDataBundle(v.name, v.variation_code))
        .map((v) => ({
          code: v.variation_code,
          name: v.name.replace(/\s+/g, " ").trim(),
          amountNgnKobo: Math.round(Number(v.variation_amount) * 100),
        }));
      variationCache.set(serviceId, list);
      return list;
    },
    submit: async (order) => {
      store.put(order);
      if (order.status === "awaiting_approval") {
        console.log(
          `order ${order.id}: approval card for the sender (Phase 11): ${order.approval?.reason}`,
        );
        return;
      }
      if (order.status !== "approved") return;
      // Phase 8 stand-in: the family account pays settlement, then the executor buys.
      const paying = advance(order, "paying");
      if (!(await store.replace(order, paying))) return;
      track(payOut(paying).catch((e) => alert(`order ${order.id}: ${String(e)}`)));
    },
    recent: async (familyId, n) => (await familyOrders(familyId)).slice(0, n),
  };

  // The public receipts page: amount, bill type, time and the on-chain proof.
  const receiptLink = (o: Order) =>
    contractId && o.receiptTxHash && !o.receiptTxHash.includes(":")
      ? `${deps.receiptsPageUrl}?network=testnet&contract=${contractId}&order=${o.id}&tx=${o.receiptTxHash}`
      : null;
  ports.receiptLink = receiptLink;

  const tick = async () => {
    for (const o of await store.listByStatus(["paying"])) await payOut(o);
    for (const r of await executor.sweep())
      if (r.waiting) waited(r.status as Order["status"], r.orderId);
  };

  // Finish anything pending (webhook-less local runs).
  const tickMs = deps.tickMs ?? 15_000;
  if (tickMs > 0) {
    setInterval(() => {
      tick().catch((e) => alert(`tick failed: ${String(e)}`));
    }, tickMs).unref();
  }

  return {
    ports,
    executor,
    store,
    float,
    receiptLink,
    createFamily,
    connect,
    contractId,
    tick,
    orders: allOrders,
    floorKobo: deps.floatFloorNgn * 100,
    settled: async () => {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
