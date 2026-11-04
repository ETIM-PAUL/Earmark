import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_RATE_SOURCES,
  FloatGuard,
  MemoryOrderStore,
  NearReceiptWriter,
  OrderExecutor,
  QUEUED_NOTE,
  Quoter,
  type Variation,
  VtpassClient,
} from "@earmark/billers";
import { billersEnv, readEnv, vtpassEnv } from "@earmark/config";
import {
  type Category,
  formatNaira,
  formatUsdc,
  hashCustomerRef,
  newFamilyId,
  newFamilySalt,
  newOrderId,
  type Order,
} from "@earmark/shared";
import type { KeyPairString } from "near-api-js";

// Phase 9 drill: 20 paid orders in a row through the order executor.
//
//   pnpm deploy:receipts:testnet   once, for the testnet receipts contract
//   pnpm drill:billers
//
// Real: VTpass sandbox purchases, live NGN/USD quotes, the float guard and
// on-chain receipts on the testnet contract. Simulated: the family's payment
// to settlement and the refund (Phase 8), recorded as drill-pay:/drill-refund:
// references. Two orders are forced to fail: a wrong meter (caught before
// /pay) and a wrong phone number (VTpass fails it). Both must refund.
//
// Sandbox only. The report, with tokens, goes to .earmark/billers-drill-report.json.

const ROOT = resolve(import.meta.dirname, "../../..");
const STATE_DIR = resolve(ROOT, ".earmark");
const REPORT_FILE = resolve(STATE_DIR, "billers-drill-report.json");
const TESTNET_STATE = resolve(STATE_DIR, "receipts-testnet.json");
const TESTNET_RPC = "https://rpc.testnet.fastnear.com";
const CONCURRENCY = 4;

try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  // fall back to the process environment
}

const SANDBOX = {
  phoneOk: "08011111111",
  phoneFail: "08099999999",
  meterOk: "1111111111111",
  meterFail: "1234567890123",
  smartcardOk: "1212121212",
};

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

interface Case {
  name: string;
  want: "fulfilled" | "refunded";
  category: Category;
  billerCode: string;
  variationCode?: string;
  customerRef: string;
  amountNgnKobo: number;
}

async function main() {
  const cfg = readEnv(vtpassEnv);
  const knobs = readEnv(billersEnv);
  if (!cfg.VTPASS_BASE_URL.includes("sandbox")) {
    throw new Error("the drill runs against the VTpass sandbox only");
  }
  let payCalls = 0;
  const vtpass = new VtpassClient({
    baseUrl: cfg.VTPASS_BASE_URL,
    apiKey: cfg.VTPASS_API_KEY,
    publicKey: cfg.VTPASS_PUBLIC_KEY,
    secretKey: cfg.VTPASS_SECRET_KEY,
    fetch: (url, init) => {
      if (String(url).endsWith("/pay")) payCalls++;
      return fetch(url, init);
    },
  });

  let testnet: {
    contract: { accountId: string };
    service: { accountId: string; privateKey: string };
  };
  try {
    testnet = JSON.parse(await readFile(TESTNET_STATE, "utf8"));
  } catch {
    throw new Error("no testnet receipts contract yet. Run: pnpm deploy:receipts:testnet");
  }
  const receipts = new NearReceiptWriter({
    rpcUrl: TESTNET_RPC,
    contractId: testnet.contract.accountId,
    serviceAccountId: testnet.service.accountId,
    servicePrivateKey: testnet.service.privateKey as KeyPairString,
  });

  const alerts: string[] = [];
  const alert = (m: string) => {
    alerts.push(m);
    log(`  alert: ${m}`);
  };
  const quoter = new Quoter({ sources: DEFAULT_RATE_SOURCES, spreadBps: knobs.QUOTE_SPREAD_BPS });
  const float = new FloatGuard({
    balance: () => vtpass.balance(),
    floorKobo: knobs.VTPASS_FLOAT_FLOOR_NGN * 100,
    alert,
  });
  const store = new MemoryOrderStore();
  const executor = new OrderExecutor({
    store,
    vtpass,
    float,
    receipts,
    refunds: { refund: async (o) => ({ txHash: `drill-refund:${o.id}` }) },
    contactPhone: async () => SANDBOX.phoneOk,
    alert,
  });

  // ── Preflight ───────────────────────────────────────────────────────
  const rate = await quoter.marketRate();
  const fl = await float.check(0);
  if (!fl.ok) throw new Error(`float guard says no: ${fl.reason}`);
  log(
    `VTpass sandbox float ${formatNaira(fl.balanceKobo)}; market ₦${rate}/USD, spread ${knobs.QUOTE_SPREAD_BPS} bps`,
  );
  const cheapest = (vs: Variation[]) =>
    [...vs].sort((a, b) => Number(a.variation_amount) - Number(b.variation_amount));
  // Plain data bundles only: combo products (e.g. xtratalk) need fields we don't send (011).
  const bundles = cheapest(
    (await vtpass.variations("mtn-data")).filter((v) => /^mtn-\d+(mb|gb)/i.test(v.variation_code)),
  );
  const bouquets = cheapest(await vtpass.variations("dstv"));
  // Distinct variations and amounts: VTpass may refuse a repeat of the same bill (019).
  if (bundles.length < 4 || bouquets.length < 4) {
    throw new Error("need 4 mtn-data bundles and 4 dstv bouquets");
  }
  const kobo = (v: Variation) => Math.round(Number(v.variation_amount) * 100);
  log(`receipts to testnet contract ${testnet.contract.accountId}`);

  // ── 20 orders ───────────────────────────────────────────────────────
  const elec = (naira: number): Case => ({
    name: `electricity ₦${naira}`,
    want: "fulfilled",
    category: "electricity",
    billerCode: "ikeja-electric",
    variationCode: "prepaid",
    customerRef: SANDBOX.meterOk,
    amountNgnKobo: naira * 100,
  });
  const airtime = (naira: number): Case => ({
    name: `airtime ₦${naira}`,
    want: "fulfilled",
    category: "airtime",
    billerCode: "mtn",
    customerRef: SANDBOX.phoneOk,
    amountNgnKobo: naira * 100,
  });
  const data = (v: Variation): Case => ({
    name: `data ${v.variation_code}`,
    want: "fulfilled",
    category: "data",
    billerCode: "mtn-data",
    variationCode: v.variation_code,
    customerRef: SANDBOX.phoneOk,
    amountNgnKobo: kobo(v),
  });
  const tv = (v: Variation): Case => ({
    name: `TV ${v.variation_code}`,
    want: "fulfilled",
    category: "tv",
    billerCode: "dstv",
    variationCode: v.variation_code,
    customerRef: SANDBOX.smartcardOk,
    amountNgnKobo: kobo(v),
  });
  const [b0, b1, b2, b3] = bundles as [Variation, Variation, Variation, Variation];
  const [t0, t1, t2, t3] = bouquets as [Variation, Variation, Variation, Variation];
  const cases: Case[] = [
    elec(1_000),
    airtime(100),
    data(b0),
    tv(t0),
    {
      ...elec(2_000),
      name: "FORCED: wrong meter",
      want: "refunded",
      customerRef: SANDBOX.meterFail,
    },
    elec(1_500),
    airtime(200),
    data(b1),
    tv(t1),
    airtime(500),
    elec(5_000),
    data(b2),
    tv(t2),
    airtime(1_000),
    {
      ...airtime(300),
      name: "FORCED: wrong phone",
      want: "refunded",
      customerRef: SANDBOX.phoneFail,
    },
    elec(3_000),
    airtime(50),
    data(b3),
    tv(t3),
    airtime(750),
  ];

  const familyId = newFamilyId();
  const salt = newFamilySalt();
  const orders: { c: Case; id: string }[] = [];
  for (const c of cases) {
    const quote = await quoter.quote(c.amountNgnKobo);
    const id = newOrderId();
    const at = new Date().toISOString();
    const order: Order = {
      id,
      familyId,
      category: c.category,
      billerCode: c.billerCode,
      ...(c.variationCode ? { variationCode: c.variationCode } : {}),
      customerRef: c.customerRef,
      customerRefHash: await hashCustomerRef(salt, c.category, c.customerRef),
      amountNgnKobo: c.amountNgnKobo,
      quote,
      status: "paid",
      paymentTxHash: `drill-pay:${id}`,
      createdAt: at,
      updatedAt: at,
    };
    store.put(order);
    orders.push({ c, id });
  }
  log(`${orders.length} paid orders for ${familyId}; running ${CONCURRENCY} at a time`);

  const started = Date.now();
  const queue = [...orders.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [i, { c, id }] = next;
      const t = Date.now();
      const r = await executor.execute(id);
      const o = await store.get(id);
      const ok = r.status === c.want && !r.waiting;
      if (r.note === QUEUED_NOTE) {
        log(`…  ${String(i + 1).padStart(2)} ${c.name}: queued behind a bill for the same number`);
        continue;
      }
      log(
        `${ok ? "✓" : "✗"} ${String(i + 1).padStart(2)} ${c.name}: ${r.status}${r.waiting ? ` (waiting: ${r.note})` : ""} in ${((Date.now() - t) / 1000).toFixed(0)} s${o?.fulfillment?.token ? `, token ${o.fulfillment.token}` : ""}`,
      );
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Bills for the same number queue (VTpass refuses a repeat within 30 s);
  // the sweeper runs them, as it would on its timer in production.
  const deadline = Date.now() + 25 * 60_000;
  for (;;) {
    const open = await store.listByStatus(["paid", "purchasing", "failed", "refunding"]);
    if (open.length === 0 || Date.now() > deadline) break;
    log(`sweep: ${open.length} still queued or in flight`);
    await new Promise((r) => setTimeout(r, 10_000));
    for (const r of await executor.sweep()) {
      if (r.waiting) continue;
      const c = orders.find((o) => o.id === r.orderId)?.c;
      const o = await store.get(r.orderId);
      log(
        `${r.status === c?.want ? "✓" : "✗"} ${c?.name}: ${r.status}${o?.fulfillment?.token ? `, token ${o.fulfillment.token}` : ""}`,
      );
    }
  }

  // ── Replay: nothing may be bought or written twice ──────────────────
  const paysBefore = payCalls;
  for (const { id } of orders) await executor.execute(id);
  await executor.sweep();
  const replayPays = payCalls - paysBefore;
  log(`${replayPays === 0 ? "✓" : "✗"} replay of all 20: ${replayPays} new /pay calls`);

  // ── Judge against the chain ─────────────────────────────────────────
  const rows = [];
  let pass = replayPays === 0;
  for (const { c, id } of orders) {
    const o = await store.get(id);
    const onChain = await receipts.get(id);
    const leaks = onChain
      ? [c.customerRef, o?.fulfillment?.token].filter(
          (s): s is string => !!s && JSON.stringify(onChain).includes(s),
        )
      : [];
    const ok =
      o?.status === c.want &&
      !!o.receiptTxHash &&
      onChain?.status === c.want &&
      onChain.amountUsdcAtomic === o.quote?.amountUsdcAtomic &&
      (c.want === "refunded") === !!onChain.refundTxHash &&
      leaks.length === 0;
    if (!ok) pass = false;
    rows.push({
      name: c.name,
      orderId: id,
      want: c.want,
      status: o?.status,
      ok,
      naira: formatNaira(c.amountNgnKobo),
      usdc: o?.quote ? formatUsdc(o.quote.amountUsdcAtomic) : null,
      token: o?.fulfillment?.token ?? null,
      failureReason: o?.failureReason ?? null,
      receiptTx: o?.receiptTxHash ?? null,
      onChain,
      leaks,
    });
  }
  const fulfilled = rows.filter((r) => r.status === "fulfilled").length;
  const refunded = rows.filter((r) => r.status === "refunded").length;
  const good = rows.filter((r) => r.ok).length;
  log(
    `${pass ? "PASS" : "FAIL"}: ${good}/20 as expected (${fulfilled} fulfilled, ${refunded} refunded), every receipt on-chain, in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  for (const r of rows.filter((r) => !r.ok)) log(`  ✗ ${r.name}: ${JSON.stringify(r)}`);
  const sample = rows.find((r) => r.status === "refunded")?.receiptTx;
  if (sample) log(`refund receipt: https://testnet.nearblocks.io/txns/${sample}`);
  const page = rows[0];
  if (page)
    log(
      `page: http://localhost:5173/receipt.html?network=testnet&contract=${testnet.contract.accountId}&order=${page.orderId}`,
    );

  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    REPORT_FILE,
    JSON.stringify(
      { finishedAt: new Date().toISOString(), pass, familyId, replayPays, alerts, rows },
      null,
      2,
    ),
  );
  await chmod(REPORT_FILE, 0o600);
  log(`report: ${REPORT_FILE}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`drill stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
