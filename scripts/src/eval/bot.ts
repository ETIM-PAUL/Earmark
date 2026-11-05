import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BotPorts,
  Dialog,
  type Family,
  NearAiModel,
  newSession,
  type Option,
  type Slot,
} from "@earmark/bot";
import { nearAiEnv, readEnv } from "@earmark/config";
import { CATEGORIES, type Category, type FamilyRules, type Order } from "@earmark/shared";

// Phase 10 eval: 15 English and Pidgin phrasings through the real model
// (NEAR AI Cloud) and the full dialog engine. Each must reach the right
// summary, or ask the right question. Billers are fixtures, so only the
// language understanding varies. Nothing is bought.
//
//   pnpm eval:bot
//
// Report: .earmark/bot-eval-report.json

const ROOT = resolve(import.meta.dirname, "../../..");
try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  // fall back to the process environment
}

const MY_PHONE = "08031234567";
const MY_METER = "45031234567";
const MY_CARD = "7023456789";

const VARIATIONS: Record<string, Option[]> = {
  "mtn-data": [
    { code: "mtn-10mb-100", name: "N100 100MB - 24 hrs", amountNgnKobo: 10_000 },
    { code: "mtn-50mb-200", name: "N200 200MB - 2 days", amountNgnKobo: 20_000 },
    { code: "mtn-100mb-1000", name: "N1000 1.5GB - 30 days", amountNgnKobo: 100_000 },
    { code: "mtn-20hrs-1500", name: "N1500 6GB - 7 days", amountNgnKobo: 150_000 },
    { code: "mtn-500mb-2000", name: "N2000 4.5GB - 30 days", amountNgnKobo: 200_000 },
    { code: "mtn-3gb-2500", name: "N2500 6GB - 30 days", amountNgnKobo: 250_000 },
    { code: "mtn-1gb-3500", name: "N3500 10GB - 30 days", amountNgnKobo: 350_000 },
  ],
  dstv: [
    { code: "dstv-padi", name: "DStv Padi N1,850", amountNgnKobo: 185_000 },
    { code: "dstv-yanga", name: "DStv Yanga N2,565", amountNgnKobo: 256_500 },
    { code: "dstv-confam", name: "Dstv Confam N4,615", amountNgnKobo: 461_500 },
    { code: "dstv79", name: "DStv Compact N7900", amountNgnKobo: 790_000 },
    { code: "dstv7", name: "DStv Compact Plus N12,400", amountNgnKobo: 1_240_000 },
  ],
  gotv: [
    { code: "gotv-lite", name: "GOtv Lite N410", amountNgnKobo: 41_000 },
    { code: "gotv-jinja", name: "GOtv Jinja N1,640", amountNgnKobo: 164_000 },
    { code: "gotv-jolli", name: "GOtv Jolli N2,460", amountNgnKobo: 246_000 },
    { code: "gotv-max", name: "GOtv Max N3,600", amountNgnKobo: 360_000 },
  ],
  startimes: [
    { code: "nova", name: "Nova - 900 Naira - 1 Month", amountNgnKobo: 90_000 },
    { code: "basic", name: "Basic - 1,700 Naira - 1 Month", amountNgnKobo: 170_000 },
  ],
};

type Want =
  | {
      summary: {
        category: Category;
        billerCode: string;
        customerRef: string;
        amountNgnKobo: number;
        variationCode?: string;
      };
    }
  | { asks: Slot; category?: Category }
  | { reply: RegExp };

const CASES: [string, Want][] = [
  // English
  [
    "Please buy 5,000 naira electricity for meter 45031234567 on Ikeja Electric",
    {
      summary: {
        category: "electricity",
        billerCode: "ikeja-electric",
        customerRef: MY_METER,
        amountNgnKobo: 500_000,
        variationCode: "prepaid",
      },
    },
  ],
  [
    "send 500 airtime to 0802 123 4567",
    {
      summary: {
        category: "airtime",
        billerCode: "airtel",
        customerRef: "08021234567",
        amountNgnKobo: 50_000,
      },
    },
  ],
  [
    "Buy 2k airtime for my line",
    {
      summary: {
        category: "airtime",
        billerCode: "mtn",
        customerRef: MY_PHONE,
        amountNgnKobo: 200_000,
      },
    },
  ],
  [
    "1.5GB data for 08031234567",
    {
      summary: {
        category: "data",
        billerCode: "mtn-data",
        customerRef: MY_PHONE,
        amountNgnKobo: 100_000,
        variationCode: "mtn-100mb-1000",
      },
    },
  ],
  [
    "renew my DStv compact",
    {
      summary: {
        category: "tv",
        billerCode: "dstv",
        customerRef: MY_CARD,
        amountNgnKobo: 790_000,
        variationCode: "dstv79",
      },
    },
  ],
  [
    "Pay GOtv Jolli for smartcard 7023456789",
    {
      summary: {
        category: "tv",
        billerCode: "gotv",
        customerRef: MY_CARD,
        amountNgnKobo: 246_000,
        variationCode: "gotv-jolli",
      },
    },
  ],
  ["buy 3k glo airtime", { asks: "customerRef", category: "airtime" }],
  [
    "how much is left in my budget this month?",
    { reply: /Budget left this month: \$87\.50 of \$100/ },
  ],
  // Pidgin
  [
    "abeg buy 10k light for my meter",
    {
      summary: {
        category: "electricity",
        billerCode: "ikeja-electric",
        customerRef: MY_METER,
        amountNgnKobo: 1_000_000,
        variationCode: "prepaid",
      },
    },
  ],
  [
    "I wan recharge 1k MTN for 08031234567",
    {
      summary: {
        category: "airtime",
        billerCode: "mtn",
        customerRef: MY_PHONE,
        amountNgnKobo: 100_000,
      },
    },
  ],
  [
    "my data don finish, abeg buy 1k data for my line",
    {
      summary: {
        category: "data",
        billerCode: "mtn-data",
        customerRef: MY_PHONE,
        amountNgnKobo: 100_000,
        variationCode: "mtn-100mb-1000",
      },
    },
  ],
  ["light don finish o", { asks: "amount", category: "electricity" }],
  [
    "Abeg buy NEPA light 20k for EKEDC meter 04123456789",
    {
      summary: {
        category: "electricity",
        billerCode: "eko-electric",
        customerRef: "04123456789",
        amountNgnKobo: 2_000_000,
        variationCode: "prepaid",
      },
    },
  ],
  ["abeg I need data", { asks: "customerRef", category: "data" }],
  ["make you pay my startimes", { asks: "customerRef", category: "tv" }],
];

function family(): Family {
  const rule = { enabled: true, monthlyCapNgnKobo: null, allowedCustomerRefs: [] as string[] };
  return {
    familyId: "fam_evalevalevaleval",
    salt: "e".repeat(64),
    senderName: "Ada",
    recipientPhone: MY_PHONE,
    saved: [
      {
        category: "electricity",
        billerCode: "ikeja-electric",
        ref: MY_METER,
        label: "home meter",
        meterType: "prepaid",
      },
      { category: "tv", billerCode: "dstv", ref: MY_CARD, label: "house DStv" },
    ],
    rules: {
      familyId: "fam_evalevalevaleval",
      version: 1,
      frozen: false,
      hardLimits: {
        settlementAccountId: "earmark-settle.near",
        monthlyBudgetUsd: "100",
        perTransactionMaxUsdcAtomic: "50000000",
      },
      approvalAboveNgnKobo: 50_000_00,
      categories: Object.fromEntries(
        CATEGORIES.map((c) => [c, { ...rule }]),
      ) as unknown as FamilyRules["categories"],
      updatedAt: new Date().toISOString(),
    },
    usage: {
      month: "202611",
      spentNgnKoboByCategory: { electricity: 0, airtime: 0, data: 0, tv: 0 },
      spentUsdcAtomic: "12500000",
    },
  };
}

async function main() {
  const ai = readEnv(nearAiEnv);
  const model = new NearAiModel({
    baseUrl: ai.NEAR_AI_BASE_URL,
    apiKey: ai.NEAR_AI_API_KEY,
    model: ai.NEAR_AI_MODEL,
  });
  const ports: BotPorts = {
    model,
    family: async () => family(),
    lookup: async () => ({ ok: true, customerName: "TEST CUSTOMER", raw: null }),
    quote: async (kobo) => {
      const at = new Date();
      return {
        rateNgnPerUsd: "1325.00",
        amountUsdcAtomic: String(Math.ceil((kobo * 1_000_000) / 132_500)),
        quotedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + 600_000).toISOString(),
      };
    },
    variations: async (id) => VARIATIONS[id] ?? [],
    submit: async () => {
      throw new Error("the eval never submits");
    },
    recent: async (): Promise<Order[]> => [],
  };
  const dialog = new Dialog(ports);

  console.log(`model ${ai.NEAR_AI_MODEL}, ${CASES.length} phrasings`);
  const rows = [];
  for (const [text, want] of CASES) {
    const t = Date.now();
    const turn = await dialog.handle("eval", newSession(), text);
    const reply = turn.replies.join("\n");
    const s = turn.session;
    const p = s.pending;
    let ok: boolean;
    let got: string;
    if ("summary" in want) {
      const w = want.summary;
      ok =
        s.asking === "confirm" &&
        !!p &&
        p.category === w.category &&
        p.billerCode === w.billerCode &&
        p.customerRef === w.customerRef &&
        p.amountNgnKobo === w.amountNgnKobo &&
        (w.variationCode === undefined || p.variationCode === w.variationCode);
      got = p
        ? `summary ${p.category} ${p.billerCode} ${p.customerRef} ${p.amountNgnKobo / 100} ${p.variationCode ?? ""}`
        : `asks ${s.asking}: ${reply.split("\n")[0]}`;
    } else if ("asks" in want) {
      ok = s.asking === want.asks && (!want.category || s.draft.category === want.category);
      got = `asks ${s.asking} (${s.draft.category ?? "no category"}): ${reply.split("\n")[0]}`;
    } else {
      ok = want.reply.test(reply);
      got = reply.split("\n")[0] ?? "";
    }
    const ms = Date.now() - t;
    console.log(`${ok ? "✓" : "✗"} [${s.lang}] "${text}" → ${got} (${(ms / 1000).toFixed(1)} s)`);
    rows.push({
      text,
      want: JSON.parse(JSON.stringify(want, (_, v) => (v instanceof RegExp ? String(v) : v))),
      ok,
      got,
      reply,
      lang: s.lang,
      ms,
    });
  }
  const passed = rows.filter((r) => r.ok).length;
  console.log(`${passed === rows.length ? "PASS" : "FAIL"}: ${passed}/${rows.length}`);
  const dir = resolve(ROOT, ".earmark");
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, "bot-eval-report.json");
  await writeFile(
    file,
    JSON.stringify(
      { finishedAt: new Date().toISOString(), model: ai.NEAR_AI_MODEL, passed, rows },
      null,
      2,
    ),
  );
  await chmod(file, 0o600);
  if (passed !== rows.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`eval stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
