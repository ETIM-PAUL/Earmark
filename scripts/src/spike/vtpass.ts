import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BillPurchase,
  lookupCustomer,
  type Outcome,
  purchaseBill,
  SERVICE_IDENTIFIERS,
  SERVICES,
  type Variation,
  VtpassClient,
} from "@earmark/billers";
import { readEnv, vtpassEnv } from "@earmark/config";
import { CATEGORIES, type Category, newOrderId } from "@earmark/shared";

// Phase 6 spike: every bill type through the VTpass sandbox, end to end.
//
//   pnpm spike:vtpass                        everything, about 3 minutes
//   SPIKE_SKIP_SLOW=true pnpm spike:vtpass   skip the no-response and timeout cases
//
// Sandbox only: it refuses to run against live VTpass. Tokens and the full
// report go to .earmark/vtpass-spike-report.json (gitignored).

const ROOT = resolve(import.meta.dirname, "../../..");
const STATE_DIR = resolve(ROOT, ".earmark");
const REPORT_FILE = resolve(STATE_DIR, "vtpass-spike-report.json");

try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  // fall back to the process environment
}

/** VTpass sandbox fixtures, from each product's documentation page. */
const SANDBOX = {
  phoneOk: "08011111111",
  phoneFail: "08099999999",
  meterOk: "1111111111111",
  meterFail: "1234567890123",
  smartcardOk: "1212121212",
  smartcardFail: "1234567890",
  pending: "201000000000",
  unexpected: "500000000000",
  noResponse: "400000000000",
  timeout: "300000000000",
};

type Expect = "delivered" | "failed_or_refused" | "not_failed";

interface Step {
  name: string;
  expect: Expect;
  pass: boolean;
  orderId?: string;
  outcome?: string;
  detail: string;
  fulfillment?: unknown;
  raw?: unknown;
}

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const steps: Step[] = [];

function judge(expect: Expect, o: Outcome): boolean {
  if (expect === "delivered") return o.kind === "delivered";
  // A refusal caused by our own setup (keys, whitelisting, wallet) proves
  // nothing about the bad number, so it doesn't count.
  if (expect === "failed_or_refused") {
    return o.kind === "failed" || (o.kind === "refused" && !o.message.alert);
  }
  // Anomalies must never be read as failure: that would refund a bill that may be paid.
  return o.kind !== "failed" && o.kind !== "refused";
}

function describe(o: Outcome): string {
  switch (o.kind) {
    case "delivered":
      return `delivered, VTpass ${o.fulfillment.billerTransactionId}${o.fulfillment.token ? `, token ${o.fulfillment.token}` : ""}`;
    case "failed":
    case "refused":
      return `${o.kind} ${o.message.code}: "${o.message.recipient}"`;
    case "pending":
      return `pending${o.notFound ? " (not found)" : ""}: ${o.message.operator}`;
  }
}

async function main() {
  const cfg = readEnv(vtpassEnv);
  const client = new VtpassClient({
    baseUrl: cfg.VTPASS_BASE_URL,
    apiKey: cfg.VTPASS_API_KEY,
    publicKey: cfg.VTPASS_PUBLIC_KEY,
    secretKey: cfg.VTPASS_SECRET_KEY,
    payTimeoutMs: 20_000,
  });
  if (!client.isSandbox)
    throw new Error(`refusing to run against live VTpass (${cfg.VTPASS_BASE_URL})`);
  const skipSlow = process.env.SPIKE_SKIP_SLOW === "true";

  // ── Preflight ───────────────────────────────────────────────────────
  const bal = await client.balance();
  if ((bal.code as unknown) !== 1) {
    throw new Error(
      `sandbox keys refused: ${JSON.stringify(bal)}. Regenerate the public and secret keys at ` +
        "https://sandbox.vtpass.com/account (API Keys tab, authentication type 'all' or 'API keys').",
    );
  }
  log(`sandbox keys ok; wallet ₦${(bal.contents as { balance?: number })?.balance ?? "?"}`);

  const limits: Record<string, { min: string; max: string }> = {};
  for (const c of CATEGORIES) {
    for (const s of await client.services(SERVICE_IDENTIFIERS[c])) {
      if (SERVICES[c].includes(s.serviceID)) {
        limits[s.serviceID] = { min: s.minimium_amount, max: s.maximum_amount };
      }
    }
  }
  const missing = CATEGORIES.flatMap((c) => SERVICES[c].filter((id) => !limits[id]));
  log(
    `catalog: ${Object.keys(limits).length} services listed${missing.length ? `; missing ${missing.join(", ")}` : ""}`,
  );

  const cheapest = (vs: Variation[]) =>
    [...vs].sort((a, b) => Number(a.variation_amount) - Number(b.variation_amount))[0];
  const bundle = cheapest(await client.variations("mtn-data"));
  const bouquet = cheapest(await client.variations("dstv"));
  if (!bundle || !bouquet) throw new Error("no variations for mtn-data or dstv");
  log(
    `cheapest MTN bundle ${bundle.variation_code} (₦${bundle.variation_amount}); DStv ${bouquet.variation_code} (₦${bouquet.variation_amount})`,
  );
  const kobo = (naira: string) => Math.round(Number(naira) * 100);

  // ── Lookups ─────────────────────────────────────────────────────────
  const lookups: [string, Category, string, string, boolean][] = [
    ["lookup prepaid meter", "electricity", "ikeja-electric", SANDBOX.meterOk, true],
    ["lookup wrong meter", "electricity", "ikeja-electric", SANDBOX.meterFail, false],
    ["lookup smartcard", "tv", "dstv", SANDBOX.smartcardOk, true],
    ["lookup wrong smartcard", "tv", "dstv", SANDBOX.smartcardFail, false],
  ];
  for (const [name, category, billerCode, customerRef, want] of lookups) {
    const r = await lookupCustomer(client, { category, billerCode, customerRef });
    const pass = r.ok === want && (r.ok || r.reason === "not_found");
    const detail = r.ok
      ? `found ${r.customerName ?? "(no name)"}`
      : `${r.reason}: "${r.recipient}"`;
    steps.push({
      name,
      expect: want ? "delivered" : "failed_or_refused",
      pass,
      detail,
      raw: r.raw,
    });
    log(`${pass ? "✓" : "✗"} ${name}: ${detail}`);
  }

  // ── Purchases ───────────────────────────────────────────────────────
  const order = (p: Omit<BillPurchase, "orderId" | "contactPhone">): BillPurchase => ({
    orderId: newOrderId(),
    contactPhone: SANDBOX.phoneOk,
    ...p,
  });
  const airtimeOk = order({
    category: "airtime",
    billerCode: "mtn",
    customerRef: SANDBOX.phoneOk,
    amountNgnKobo: 10_000,
  });
  const purchases: [string, Expect, BillPurchase][] = [
    ["airtime", "delivered", airtimeOk],
    [
      "electricity token",
      "delivered",
      order({
        category: "electricity",
        billerCode: "ikeja-electric",
        variationCode: "prepaid",
        customerRef: SANDBOX.meterOk,
        amountNgnKobo: 100_000,
      }),
    ],
    [
      "TV bouquet",
      "delivered",
      order({
        category: "tv",
        billerCode: "dstv",
        variationCode: bouquet.variation_code,
        customerRef: SANDBOX.smartcardOk,
        amountNgnKobo: kobo(bouquet.variation_amount),
      }),
    ],
    [
      "data bundle",
      "delivered",
      order({
        category: "data",
        billerCode: "mtn-data",
        variationCode: bundle.variation_code,
        customerRef: SANDBOX.phoneOk,
        amountNgnKobo: kobo(bundle.variation_amount),
      }),
    ],
    [
      "airtime, wrong number",
      "failed_or_refused",
      order({
        category: "airtime",
        billerCode: "mtn",
        customerRef: SANDBOX.phoneFail,
        amountNgnKobo: 10_000,
      }),
    ],
    [
      "electricity, wrong meter",
      "failed_or_refused",
      order({
        category: "electricity",
        billerCode: "ikeja-electric",
        variationCode: "prepaid",
        customerRef: SANDBOX.meterFail,
        amountNgnKobo: 100_000,
      }),
    ],
    [
      "TV, wrong smartcard",
      "failed_or_refused",
      order({
        category: "tv",
        billerCode: "dstv",
        variationCode: bouquet.variation_code,
        customerRef: SANDBOX.smartcardFail,
        amountNgnKobo: kobo(bouquet.variation_amount),
      }),
    ],
    [
      "data, wrong number",
      "failed_or_refused",
      order({
        category: "data",
        billerCode: "mtn-data",
        variationCode: bundle.variation_code,
        customerRef: SANDBOX.phoneFail,
        amountNgnKobo: kobo(bundle.variation_amount),
      }),
    ],
    ["replay of the airtime order (must not buy twice)", "delivered", airtimeOk],
    [
      "airtime, VTpass pending",
      "not_failed",
      order({
        category: "airtime",
        billerCode: "mtn",
        customerRef: SANDBOX.pending,
        amountNgnKobo: 10_000,
      }),
    ],
    [
      "airtime, unexpected response",
      "not_failed",
      order({
        category: "airtime",
        billerCode: "mtn",
        customerRef: SANDBOX.unexpected,
        amountNgnKobo: 10_000,
      }),
    ],
  ];
  if (!skipSlow) {
    purchases.push(
      [
        "airtime, no response",
        "not_failed",
        order({
          category: "airtime",
          billerCode: "mtn",
          customerRef: SANDBOX.noResponse,
          amountNgnKobo: 10_000,
        }),
      ],
      [
        "airtime, timeout",
        "not_failed",
        order({
          category: "airtime",
          billerCode: "mtn",
          customerRef: SANDBOX.timeout,
          amountNgnKobo: 10_000,
        }),
      ],
    );
  }

  const firstAirtime: { id?: string } = {};
  for (const [name, expect, p] of purchases) {
    const o = await purchaseBill(client, p, { requerySchedule: [3_000, 5_000, 8_000] });
    let pass = judge(expect, o);
    let detail = describe(o);
    if (p === airtimeOk && o.kind === "delivered") {
      if (!firstAirtime.id) firstAirtime.id = o.fulfillment.billerTransactionId;
      else if (o.fulfillment.billerTransactionId !== firstAirtime.id) {
        pass = false;
        detail += ` — DIFFERENT transaction from ${firstAirtime.id}: bought twice`;
      } else detail += " — same transaction, not bought twice";
    }
    steps.push({
      name,
      expect,
      pass,
      orderId: p.orderId,
      outcome: o.kind,
      detail,
      ...(o.kind === "delivered" ? { fulfillment: o.fulfillment } : {}),
      raw: o.raw,
    });
    log(`${pass ? "✓" : "✗"} ${name}: ${detail}`);
  }

  // ── Report ──────────────────────────────────────────────────────────
  const failed = steps.filter((s) => !s.pass);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    REPORT_FILE,
    JSON.stringify(
      { finishedAt: new Date().toISOString(), limits, bundle, bouquet, steps },
      null,
      2,
    ),
  );
  await chmod(REPORT_FILE, 0o600);
  log(`done: ${steps.length - failed.length}/${steps.length} as expected`);
  log(`report: ${REPORT_FILE}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`spike stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
