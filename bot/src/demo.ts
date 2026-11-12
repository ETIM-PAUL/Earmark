import { randomBytes } from "node:crypto";
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
  requestIdIsToday,
  VtpassClient,
} from "@earmark/billers";
import {
  advance,
  applyPreset,
  CATEGORIES,
  evaluateOrder,
  type FamilyRules,
  FUNDS_HELD_STATUSES,
  formatNaira,
  formatUsdc,
  setFrozen as freezeRules,
  lagosMonth,
  newFamilyId,
  newFamilySalt,
  newOrderId,
  type Order,
  type PresetName,
  type Quote,
  type SoftRulesChange,
  updateSoftRules,
} from "@earmark/shared";
import type { KeyPairString } from "near-api-js";
import {
  APPROVAL_TTL_MS,
  type ApprovalCard,
  approvalCard,
  checkProof,
  type DecideResult,
  type Decision,
  declinedMessage,
  expiredMessage,
  FROZEN_STOPPED,
  NOTHING_PAID,
  ownerProof,
} from "./approvals.js";
import type { BotPorts, Family } from "./dialog.js";
import type { ChatModel } from "./model.js";
import { LABELS, maskRef } from "./providers.js";
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
  verifyOwner?: DemoDeps["verifyOwner"];
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
  /** The clock, for drills that need a later day. Default: the real one. */
  now?: () => Date;
  /**
   * Checks the owner's signature on a decision (a passkey assertion, from
   * passkeys.ts). The demo owner's HMAC is always accepted too, for the
   * judge page.
   */
  verifyOwner?: (order: Order, decision: Decision, proof: string) => Promise<boolean>;
}

/** What a sender gives when creating a family. */
export interface NewFamily {
  senderName?: string;
  preset?: PresetName;
  recipientPhone?: string;
  saved?: Family["saved"];
}

export interface DemoWiring {
  ports: BotPorts;
  executor: OrderExecutor;
  store: MemoryOrderStore;
  float: FloatGuard;
  receiptLink: (o: Order) => string | null;
  createFamily: (input?: NewFamily | string) => Family;
  connect: (chat: string, familyId: string) => boolean;
  contractId: string | null;
  /** Retry payments to settlement, then sweep the executor. */
  tick: () => Promise<void>;
  /** Every order, newest first. */
  orders: () => Promise<Order[]>;
  floorKobo: number;
  /** Resolves when no payment or purchase is running in the background. */
  settled: () => Promise<void>;
  /** The sender's side: the approval inbox, decisions, freeze and presets. */
  sender: SenderSide;
}

/** What the sender's app (Phase 12) will call, behind the owner's sign-in. */
export interface SenderSide {
  overview: (familyId: string) => Promise<SenderOverview | null>;
  approvals: (familyId: string) => Promise<ApprovalCard[]>;
  /** `proof` is the owner's signature over this order and decision. */
  decide: (orderId: string, decision: Decision, proof: string) => Promise<DecideResult>;
  /** Signs as the demo owner. The real owner signs in their own wallet. */
  signAsDemoOwner: (orderId: string, decision: Decision) => Promise<string | null>;
  setFrozen: (familyId: string, frozen: boolean) => Promise<boolean>;
  applyPreset: (familyId: string, preset: PresetName) => boolean;
  /** Change single category rules or the approval threshold. Hard limits can't change here. */
  updateRules: (familyId: string, change: SoftRulesChange) => boolean;
  senderName: (familyId: string) => string | null;
  /** The order behind an approval, to build what the sender signs. */
  pendingOrder: (orderId: string) => Promise<Order | null>;
  /** Safe summaries of a family's latest orders, newest first. */
  orders: (familyId: string, n: number) => Promise<OrderSummary[]>;
}

export interface OrderSummary {
  id: string;
  category: string;
  /** "Ikeja Electric" */
  label: string;
  who: string;
  amountNgn: string;
  amountUsd: string;
  status: string;
  /** What the recipient would be told, if it ended badly. */
  note: string | null;
  createdAt: string;
  receiptTxHash: string | null;
}

export interface SenderOverview {
  senderName: string;
  frozen: boolean;
  rulesVersion: number;
  approvalAboveNaira: number | null;
  categories: {
    category: string;
    enabled: boolean;
    capNaira: number | null;
    spentNaira: number;
  }[];
  /** The monthly budget in the signed policy, and what's gone this Lagos month. */
  budget: { monthlyUsd: string; spentUsd: string; leftUsd: string; perPaymentMaxUsd: string };
  recipientPhone: string;
  saved: { category: string; label: string; ref: string }[];
  /** NGN per USD in a fresh quote, or null when no price is available. */
  rateNgnPerUsd: string | null;
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
    ...(cfg.verifyOwner ? { verifyOwner: cfg.verifyOwner } : {}),
  });
}

export function wireDemo(deps: DemoDeps): DemoWiring {
  const { vtpass, quoter, receipts, contractId } = deps;
  if (!vtpass.isSandbox) throw new Error("demo mode runs against the VTpass sandbox only");
  const alert = deps.alert ?? ((m: string) => console.error(`ALERT ${m}`));
  const now = deps.now ?? (() => new Date());
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
  const createFamily = (input: NewFamily | string = {}): Family => {
    const opts: NewFamily = typeof input === "string" ? { senderName: input } : input;
    const { senderName = "Ada", preset } = opts;
    const familyId = newFamilyId();
    const at = now();
    const f: Family = {
      familyId,
      salt: newFamilySalt(),
      senderName,
      recipientPhone: opts.recipientPhone ?? SANDBOX.phone,
      saved: opts.saved ?? [
        {
          category: "electricity",
          billerCode: "ikeja-electric",
          ref: SANDBOX.meter,
          label: "home meter",
          meterType: "prepaid",
        },
        { category: "tv", billerCode: "dstv", ref: SANDBOX.smartcard, label: "house DStv" },
      ],
      rules: preset ? applyPreset(demoRules(familyId, at), preset, at) : demoRules(familyId, at),
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
    now,
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
    // Frozen before any money moved: stop here.
    if (families.get(paying.familyId)?.rules.frozen) {
      next = advance(paying, "rejected", { failureReason: FROZEN_STOPPED }, now());
      if (await store.replace(paying, next)) deps.onOrderUpdate(next);
      return;
    }
    try {
      const { txHash } = await payer.pay(paying);
      next = advance(paying, "paid", { paymentTxHash: txHash }, now());
    } catch (e) {
      if (!(e instanceof PaymentRefused)) {
        alert(`order ${paying.id}: payment to settlement failed, will retry: ${String(e)}`);
        waited("paying", paying.id);
        return;
      }
      alert(`order ${paying.id}: ${e.message}`);
      next = advance(paying, "rejected", { failureReason: PAYMENT_REFUSED }, now());
    }
    if (!(await store.replace(paying, next))) return; // someone else moved it
    deps.onOrderUpdate(next);
    if (next.status === "paid") await run(next.id);
  };

  const familyOf = (o: Order): Family => {
    const f = families.get(o.familyId);
    if (!f) throw new Error(`order ${o.id}: no family ${o.familyId}`);
    return f;
  };

  /** Phase 8 stand-in: the family account pays settlement, then the executor buys. */
  const startPaying = async (order: Order): Promise<void> => {
    const paying = advance(order, "paying", {}, now());
    if (!(await store.replace(order, paying))) return;
    track(payOut(paying).catch((e) => alert(`order ${order.id}: ${String(e)}`)));
  };

  // ── The sender's side: approvals, freeze, presets ──────────────────────

  const ownerSecret = randomBytes(32).toString("hex");

  const pending = async (familyId: string) =>
    (await store.listByStatus(["awaiting_approval"]))
      .filter((o) => o.familyId === familyId && o.approval)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  /** Move an order to a final status and tell the chat. False if someone else moved it first. */
  const finish = async (order: Order, next: Order): Promise<boolean> => {
    if (!(await store.replace(order, next))) return false;
    deps.onOrderUpdate(next);
    return true;
  };

  const expire = async (order: Order): Promise<Order | null> => {
    const next = advance(
      order,
      "expired",
      { failureReason: expiredMessage(familyOf(order).senderName) },
      now(),
    );
    return (await finish(order, next)) ? next : null;
  };

  /** Cancel approval requests nobody answered in time. */
  const expireStale = async (): Promise<void> => {
    const t = now().getTime();
    for (const o of await store.listByStatus(["awaiting_approval"])) {
      if (o.approval && t - Date.parse(o.approval.requestedAt) >= APPROVAL_TTL_MS) await expire(o);
    }
  };

  const decide = async (
    orderId: string,
    decision: Decision,
    proof: string,
  ): Promise<DecideResult> => {
    const order = await store.get(orderId);
    if (!order) return { ok: false, reason: "not_found" };
    if (order.status !== "awaiting_approval" || !order.approval) {
      return { ok: false, reason: "not_pending" };
    }
    const signed =
      checkProof(ownerSecret, order, decision, proof) ||
      (await deps.verifyOwner?.(order, decision, proof).catch(() => false)) === true;
    if (!signed) return { ok: false, reason: "bad_proof" };
    const family = familyOf(order);
    const at = now();
    if (at.getTime() - Date.parse(order.approval.requestedAt) >= APPROVAL_TTL_MS) {
      const gone = await expire(order);
      return { ok: false, reason: "expired", ...(gone ? { order: gone } : {}) };
    }
    const decided = { ...order.approval, decision, decidedAt: at.toISOString() };

    if (decision === "declined") {
      const next = advance(
        order,
        "declined",
        { approval: decided, failureReason: declinedMessage(family.senderName) },
        at,
      );
      return (await finish(order, next))
        ? { ok: true, order: next }
        : { ok: false, reason: "not_pending" };
    }

    // Approved. The price may be hours old: a 10-minute-old price is never paid.
    let quote: Quote | undefined = order.quote;
    if (!quote || at.getTime() >= Date.parse(quote.expiresAt)) {
      try {
        quote = await quoter.quote(order.amountNgnKobo);
      } catch {
        return { ok: false, reason: "no_price" }; // still pending; the sender can retry
      }
    }
    // Hard limits and a freeze can still refuse after the sender's yes.
    await refreshUsage(family);
    const verdict = evaluateOrder({ ...order, quote }, family.rules, family.usage, {
      senderApproved: true,
    });
    if (verdict.outcome !== "allow") {
      const why = verdict.breaches
        .filter((b) => b.layer === "hard")
        .map((b) => b.message)
        .join(" ");
      const next = advance(
        order,
        "rejected",
        { approval: decided, quote, failureReason: `${why} ${NOTHING_PAID}` },
        at,
      );
      return (await finish(order, next))
        ? { ok: true, order: next }
        : { ok: false, reason: "not_pending" };
    }

    let next: Order;
    if (requestIdIsToday(order.id, at)) {
      next = advance(order, "approved", { approval: decided, quote }, at);
      if (!(await store.replace(order, next))) return { ok: false, reason: "not_pending" };
    } else {
      // VTpass refuses a request ID from an earlier day. No money has moved, so
      // carry the approval onto a fresh order and retire this one quietly.
      const { approval: _drop, ...rest } = order;
      const draft: Order = {
        ...rest,
        id: newOrderId(at),
        status: "draft",
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
      };
      const confirmed = advance(draft, "awaiting_confirmation", { quote }, at);
      next = advance(confirmed, "approved", { approval: decided }, at);
      const old = advance(
        order,
        "expired",
        { approval: decided, failureReason: "Approved after midnight; carried onto a new order." },
        at,
      );
      if (!(await store.replace(order, old))) return { ok: false, reason: "not_pending" };
      store.put(next);
    }
    deps.onOrderUpdate(next);
    await startPaying(next);
    return { ok: true, order: next };
  };

  /** Freeze stops everything: new orders, requests waiting for approval, and payments not yet sent. */
  const setFrozen = async (familyId: string, frozen: boolean): Promise<boolean> => {
    const f = families.get(familyId);
    if (!f) return false;
    f.rules = freezeRules(f.rules, frozen);
    if (frozen) {
      for (const o of await pending(familyId)) {
        await finish(o, advance(o, "rejected", { failureReason: FROZEN_STOPPED }, now()));
      }
      for (const o of await store.listByStatus(["paying"])) {
        if (o.familyId === familyId) await payOut(o);
      }
    }
    return true;
  };

  const allOrders = async () =>
    (
      await store.listByStatus([
        "approved",
        "awaiting_approval",
        "declined",
        "expired",
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

  /** Usage counts what's paid plus money in flight, this Lagos month. */
  const refreshUsage = async (f: Family): Promise<void> => {
    const month = lagosMonth(now());
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
  };

  const variationCache = new Map<string, Option[]>();

  const ports: BotPorts = {
    now,
    model: deps.model,
    family: async (chat) => {
      const id = chats.get(chat);
      const f = id ? families.get(id) : undefined;
      if (!f) return null;
      await refreshUsage(f);
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
        console.log(`order ${order.id}: waiting for ${familyOf(order).senderName}'s approval`);
        return;
      }
      if (order.status !== "approved") return;
      await startPaying(order);
    },
    recent: async (familyId, n) => (await familyOrders(familyId)).slice(0, n),
  };

  // The public receipts page: amount, bill type, time and the on-chain proof.
  const receiptLink = (o: Order) =>
    contractId && o.receiptTxHash && !o.receiptTxHash.includes(":")
      ? `${deps.receiptsPageUrl}?network=testnet&contract=${contractId}&order=${o.id}&tx=${o.receiptTxHash}`
      : null;
  ports.receiptLink = receiptLink;

  const sender: SenderSide = {
    senderName: (familyId) => families.get(familyId)?.senderName ?? null,
    approvals: async (familyId) => {
      await expireStale();
      return (await pending(familyId)).map(approvalCard);
    },
    decide,
    signAsDemoOwner: async (orderId, decision) => {
      const o = await store.get(orderId);
      return o?.approval ? ownerProof(ownerSecret, o, decision) : null;
    },
    setFrozen,
    applyPreset: (familyId, preset) => {
      const f = families.get(familyId);
      if (!f) return false;
      f.rules = applyPreset(f.rules, preset);
      return true;
    },
    overview: async (familyId) => {
      const f = families.get(familyId);
      if (!f) return null;
      await refreshUsage(f);
      const budget = BigInt(Math.round(Number(f.rules.hardLimits.monthlyBudgetUsd) * 1e6));
      const spent = BigInt(f.usage.spentUsdcAtomic);
      const rate = await quoter
        .quote(1_000_00)
        .then((q) => q.rateNgnPerUsd)
        .catch(() => null);
      return {
        senderName: f.senderName,
        frozen: f.rules.frozen,
        rulesVersion: f.rules.version,
        approvalAboveNaira:
          f.rules.approvalAboveNgnKobo === null ? null : f.rules.approvalAboveNgnKobo / 100,
        categories: CATEGORIES.map((c) => ({
          category: c,
          enabled: f.rules.categories[c].enabled,
          capNaira:
            f.rules.categories[c].monthlyCapNgnKobo === null
              ? null
              : (f.rules.categories[c].monthlyCapNgnKobo as number) / 100,
          spentNaira: f.usage.spentNgnKoboByCategory[c] / 100,
        })),
        budget: {
          monthlyUsd: f.rules.hardLimits.monthlyBudgetUsd,
          spentUsd: formatUsdc(spent.toString()),
          leftUsd: formatUsdc((budget > spent ? budget - spent : 0n).toString()),
          perPaymentMaxUsd: formatUsdc(f.rules.hardLimits.perTransactionMaxUsdcAtomic),
        },
        recipientPhone: maskRef(f.recipientPhone),
        saved: f.saved.map((r) => ({ category: r.category, label: r.label, ref: maskRef(r.ref) })),
        rateNgnPerUsd: rate,
      };
    },
    updateRules: (familyId, change) => {
      const f = families.get(familyId);
      if (!f) return false;
      f.rules = updateSoftRules(f.rules, change, now());
      return true;
    },
    pendingOrder: async (orderId) => {
      const o = await store.get(orderId);
      return o?.status === "awaiting_approval" && o.approval ? o : null;
    },
    orders: async (familyId, n) =>
      (await familyOrders(familyId)).slice(0, n).map((o) => ({
        id: o.id,
        category: o.category,
        label: LABELS[o.billerCode] ?? o.billerCode,
        who: maskRef(o.customerRef),
        amountNgn: formatNaira(o.amountNgnKobo),
        amountUsd: o.quote ? formatUsdc(o.quote.amountUsdcAtomic) : "?",
        status: o.status,
        note: o.failureReason ?? null,
        createdAt: o.createdAt,
        receiptTxHash: o.receiptTxHash && !o.receiptTxHash.includes(":") ? o.receiptTxHash : null,
      })),
  };

  const tick = async () => {
    await expireStale();
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
    sender,
    settled: async () => {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
