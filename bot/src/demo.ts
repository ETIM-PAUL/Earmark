import { readFile } from "node:fs/promises";
import {
  DEFAULT_RATE_SOURCES,
  FloatGuard,
  lookupCustomer,
  MemoryOrderStore,
  NearReceiptWriter,
  OrderExecutor,
  Quoter,
  type ReceiptWriter,
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
 * Every chat gets its own demo family, wired to the VTpass sandbox's test
 * meter, smartcard and phone. Refuses to run against live VTpass.
 */

export interface DemoConfig {
  vtpass: { baseUrl: string; apiKey: string; publicKey: string; secretKey: string };
  spreadBps: number;
  floatFloorNgn: number;
  model: ChatModel;
  /** .earmark/receipts-testnet.json from pnpm deploy:receipts:testnet, if present. */
  testnetStateFile: string;
  /** Tells a chat that its order moved. */
  onOrderUpdate: (order: Order) => void;
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

export async function demoPorts(cfg: DemoConfig): Promise<{
  ports: BotPorts;
  executor: OrderExecutor;
  receiptLink: (o: Order) => string | null;
}> {
  if (!cfg.vtpass.baseUrl.includes("sandbox")) {
    throw new Error("demo mode runs against the VTpass sandbox only");
  }
  const vtpass = new VtpassClient(cfg.vtpass);
  const store = new MemoryOrderStore();
  const quoter = new Quoter({ sources: DEFAULT_RATE_SOURCES, spreadBps: cfg.spreadBps });
  const float = new FloatGuard({
    balance: () => vtpass.balance(),
    floorKobo: cfg.floatFloorNgn * 100,
  });

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

  const families = new Map<string, Family>();
  const executor = new OrderExecutor({
    store,
    vtpass,
    float,
    receipts,
    refunds: { refund: async (o) => ({ txHash: `demo-refund:${o.id}` }) },
    contactPhone: async () => SANDBOX.phone,
    notify: cfg.onOrderUpdate,
  });

  const familyOrders = async (familyId: string) =>
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
    )
      .filter((o) => o.familyId === familyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const variationCache = new Map<string, Option[]>();

  const ports: BotPorts = {
    model: cfg.model,
    family: async (chat) => {
      let f = families.get(chat);
      if (!f) {
        const familyId = newFamilyId();
        const at = new Date();
        f = {
          familyId,
          salt: newFamilySalt(),
          senderName: "Ada",
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
        families.set(chat, f);
      }
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
      // Simulated Phase 8: the family account pays settlement.
      const paying = advance(order, "paying");
      const paid = advance(paying, "paid", { paymentTxHash: `demo-pay:${order.id}` });
      store.put(paid);
      executor
        .execute(order.id)
        .catch((e) => console.error(`order ${order.id}: executor failed: ${String(e)}`));
    },
    recent: async (familyId, n) => (await familyOrders(familyId)).slice(0, n),
  };

  const receiptLink = (o: Order) =>
    contractId && o.receiptTxHash && !o.receiptTxHash.includes(":")
      ? `https://testnet.nearblocks.io/txns/${o.receiptTxHash}`
      : null;
  ports.receiptLink = receiptLink;

  // Finish anything pending (webhook-less local runs): sweep every 15 s.
  setInterval(() => {
    executor.sweep().catch((e) => console.error(`sweep failed: ${String(e)}`));
  }, 15_000).unref();

  return { ports, executor, receiptLink };
}
