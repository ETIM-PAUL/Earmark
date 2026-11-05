import type { Lookup } from "@earmark/billers";
import { CATEGORIES, type FamilyRules, type Order, type Quote } from "@earmark/shared";
import { describe, expect, it } from "vitest";
import {
  type BotPorts,
  Dialog,
  type Family,
  isNo,
  isYes,
  newSession,
  type Session,
  updateMessage,
} from "./dialog.js";
import { type Extraction, extract } from "./extract.js";
import type { ChatModel } from "./model.js";
import { networkFromPhone, normalizePhone, resolveBiller } from "./providers.js";
import { isPlainDataBundle, type Option, pickVariation } from "./variations.js";

const NOW = new Date("2026-11-04T10:00:00Z");
const METER = "45031234567";
const CARD = "1212121212";

const rules = (patch: Partial<FamilyRules> = {}): FamilyRules => ({
  familyId: "fam_abcdefgh12345678",
  version: 1,
  frozen: false,
  hardLimits: {
    settlementAccountId: "earmark-settle.near",
    monthlyBudgetUsd: "100",
    perTransactionMaxUsdcAtomic: "50000000",
  },
  approvalAboveNgnKobo: 20_000_00,
  categories: Object.fromEntries(
    CATEGORIES.map((c) => [c, { enabled: true, monthlyCapNgnKobo: null, allowedCustomerRefs: [] }]),
  ) as FamilyRules["categories"],
  updatedAt: NOW.toISOString(),
  ...patch,
});

const family = (patch: Partial<Family> = {}): Family => ({
  familyId: "fam_abcdefgh12345678",
  salt: "s".repeat(64),
  senderName: "Ada",
  recipientPhone: "08031234567",
  saved: [
    {
      category: "electricity",
      billerCode: "ikeja-electric",
      ref: METER,
      label: "home meter",
      meterType: "prepaid",
    },
    { category: "tv", billerCode: "dstv", ref: CARD, label: "house DStv" },
  ],
  rules: rules(),
  usage: {
    month: "202611",
    spentNgnKoboByCategory: { electricity: 0, airtime: 0, data: 0, tv: 0 },
    spentUsdcAtomic: "0",
  },
  ...patch,
});

const DATA: Option[] = [
  { code: "mtn-10mb-100", name: "N100 100MB - 24 hrs", amountNgnKobo: 10_000 },
  { code: "mtn-100mb-1000", name: "N1000 1.5GB - 30 days", amountNgnKobo: 100_000 },
  { code: "mtn-500mb-2000", name: "N2000 4.5GB - 30 days", amountNgnKobo: 200_000 },
  { code: "mtn-20hrs-1500", name: "N1500 6GB - 7 days", amountNgnKobo: 150_000 },
  { code: "mtn-3gb-2500", name: "N2500 6GB - 30 days", amountNgnKobo: 250_000 },
];
const DSTV: Option[] = [
  { code: "dstv-padi", name: "DStv Padi N1,850", amountNgnKobo: 185_000 },
  { code: "dstv79", name: "DStv  Compact N7900", amountNgnKobo: 790_000 },
  { code: "dstv7", name: "DStv Compact Plus N12,400", amountNgnKobo: 1_240_000 },
];

const ex = (patch: Partial<Extraction>): Extraction => ({
  intent: "pay_bill",
  language: "en",
  category: null,
  provider: null,
  customerRef: null,
  amountNaira: null,
  bundle: null,
  meterType: null,
  choice: null,
  ...patch,
});

/** A model that answers from a table keyed by the user's message. */
function scriptedModel(
  table: Record<string, Partial<Extraction> | "fail">,
): ChatModel & { calls: number } {
  const m = {
    calls: 0,
    async json(messages: { role: string; content: string }[]) {
      m.calls++;
      const text = messages.at(-1)?.content ?? "";
      const row = table[text];
      if (row === undefined) throw new Error(`unscripted message: ${text}`);
      if (row === "fail") throw new Error("model down");
      return JSON.stringify(ex(row));
    },
  };
  return m;
}

function harness(
  table: Record<string, Partial<Extraction> | "fail">,
  opts: { family?: Family | null; lookup?: Lookup; now?: () => Date } = {},
) {
  const model = scriptedModel(table);
  const submitted: Order[] = [];
  let quotes = 0;
  const ports: BotPorts = {
    model,
    family: async () => (opts.family === undefined ? family() : opts.family),
    lookup: async () => opts.lookup ?? { ok: true, customerName: "MAMA NGOZI", raw: null },
    quote: async (kobo): Promise<Quote> => {
      quotes++;
      const at = (opts.now ?? (() => NOW))();
      return {
        rateNgnPerUsd: "1325.00",
        amountUsdcAtomic: String(Math.ceil((kobo * 1_000_000) / 132_500)),
        quotedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + 600_000).toISOString(),
      };
    },
    variations: async (id) => (id === "dstv" ? DSTV : DATA),
    submit: async (o) => {
      submitted.push(o);
    },
    recent: async () => submitted,
    now: opts.now ?? (() => NOW),
  };
  const dialog = new Dialog(ports);
  let session: Session = newSession();
  const send = async (text: string) => {
    const turn = await dialog.handle("chat-1", session, text);
    session = turn.session;
    return turn.replies.join("\n");
  };
  return { send, submitted, model, session: () => session, quotes: () => quotes };
}

describe("providers", () => {
  it("maps what people say to VTpass billers", () => {
    expect(resolveBiller("electricity", "IKEDC")).toBe("ikeja-electric");
    expect(resolveBiller("electricity", "eko disco")).toBe("eko-electric");
    expect(resolveBiller("electricity", "Port Harcourt")).toBe("portharcourt-electric");
    expect(resolveBiller("airtime", "9mobile")).toBe("etisalat");
    expect(resolveBiller("data", "airtel")).toBe("airtel-data");
    expect(resolveBiller("tv", "GOtv")).toBe("gotv");
    expect(resolveBiller("airtime", "vodafone")).toBeNull();
  });

  it("normalises phones and guesses the network", () => {
    expect(normalizePhone("+234 803 123 4567")).toBe("08031234567");
    expect(normalizePhone("8031234567")).toBe("08031234567");
    expect(normalizePhone("0123")).toBeNull();
    expect(networkFromPhone("08031234567")).toBe("mtn");
    expect(networkFromPhone("08021234567")).toBe("airtel");
    expect(networkFromPhone("08051234567")).toBe("glo");
    expect(networkFromPhone("08091234567")).toBe("etisalat");
  });
});

describe("pickVariation", () => {
  it("picks by size, by name, or by price", () => {
    expect(pickVariation(DATA, "1.5GB", null)).toMatchObject({
      option: { code: "mtn-100mb-1000" },
    });
    expect(pickVariation(DATA, "1.5 gb monthly", null).kind).not.toBe("one");
    expect(pickVariation(DSTV, "compact", null)).toMatchObject({ option: { code: "dstv79" } });
    expect(pickVariation(DSTV, "compact plus", null)).toMatchObject({ option: { code: "dstv7" } });
    expect(pickVariation(DATA, null, 200_000)).toMatchObject({
      option: { code: "mtn-500mb-2000" },
    });
  });

  it("asks when it's not sure, and never guesses", () => {
    const two = pickVariation(DATA, "6GB", null);
    expect(two.kind).toBe("choose");
    if (two.kind === "choose")
      expect(two.options.map((o) => o.code)).toEqual(["mtn-20hrs-1500", "mtn-3gb-2500"]);
    expect(pickVariation(DATA, "100GB", null).kind).toBe("none");
    expect(pickVariation(DATA, null, null).kind).toBe("choose");
  });

  it("drops combo products that fail on VTpass", () => {
    expect(isPlainDataBundle("N300 XtraTalk", "mtn-xtratalk-300")).toBe(false);
    expect(isPlainDataBundle("N1000 1.5GB - 30 days", "mtn-100mb-1000")).toBe(true);
  });
});

describe("yes and no", () => {
  it("needs a plain answer", () => {
    for (const y of ["yes", "YES", "Yes please", "ok", "oya", "yes abeg", "Yes!", "👍 yes"]) {
      if (y.startsWith("👍")) expect(isYes(y)).toBe(false);
      else expect(isYes(y)).toBe(true);
    }
    for (const n of [
      "yes but make am 5k",
      "yesterday",
      "is it ok?",
      "e dey alright send am sharp",
    ]) {
      expect(isYes(n)).toBe(false);
    }
    expect(isNo("no")).toBe(true);
    expect(isNo("leave am")).toBe(true);
    expect(isNo("no 5k")).toBe(false);
  });
});

describe("extract", () => {
  it("retries once on a bad reply, then gives up", async () => {
    let n = 0;
    const flaky: ChatModel = {
      json: async () => (n++ === 0 ? "not json" : '```json\n{"intent":"balance"}\n```'),
    };
    expect((await extract(flaky, "how much remain")).intent).toBe("balance");
    const broken: ChatModel = { json: async () => "nope" };
    await expect(extract(broken, "hi")).rejects.toThrow();
  });

  it("drops junk fields instead of trusting them", async () => {
    const m: ChatModel = {
      json: async () => '{"intent":"pay_bill","amountNaira":-5,"category":"cash","approve":true}',
    };
    const x = await extract(m, "x");
    expect(x.amountNaira).toBeNull();
    expect(x.category).toBeNull();
    expect("approve" in x).toBe(false);
  });
});

describe("Dialog", () => {
  it("buys light for the saved meter: summary, YES, rules in code", async () => {
    const h = harness({
      "abeg buy 10k light for my meter": {
        language: "pcm",
        category: "electricity",
        customerRef: "SELF",
        amountNaira: 10_000,
      },
    });
    const summary = await h.send("abeg buy 10k light for my meter");
    expect(summary).toContain("Ikeja Electric prepaid electricity");
    expect(summary).toContain(`Meter ${METER} (MAMA NGOZI)`);
    expect(summary).toContain("₦10,000");
    expect(summary).toContain("Send YES");
    expect(h.submitted).toHaveLength(0);
    const calls = h.model.calls;
    expect(await h.send("yes")).toMatch(/pay am now/);
    expect(h.model.calls).toBe(calls); // YES never goes to the model
    expect(h.submitted[0]).toMatchObject({
      status: "approved",
      billerCode: "ikeja-electric",
      variationCode: "prepaid",
      customerRef: METER,
      amountNgnKobo: 1_000_000,
    });
    expect(h.session().asking).toBeNull();
  });

  it("asks for what's missing, one thing at a time", async () => {
    const h = harness({
      "I want to buy airtime": { category: "airtime" },
      "08031234567": { customerRef: "08031234567" },
      "2k": { amountNaira: 2_000 },
    });
    expect(await h.send("I want to buy airtime")).toMatch(/Which phone number/);
    expect(await h.send("08031234567")).toMatch(/How much/);
    expect(await h.send("2k")).toMatch(/MTN airtime[\s\S]*Phone 08031234567[\s\S]*₦2,000/);
  });

  it("keeps a network said before the category", async () => {
    const h = harness({
      "1k glo": { provider: "glo", amountNaira: 1_000 },
      "airtime for 08031234567": { category: "airtime", customerRef: "08031234567" },
    });
    expect(await h.send("1k glo")).toMatch(/What would you like to pay/);
    expect(await h.send("airtime for 08031234567")).toMatch(/Glo airtime/);
  });

  it("guesses the network from the number and shows it to confirm", async () => {
    const h = harness({
      "send 500 recharge to 08021234567": {
        category: "airtime",
        customerRef: "08021234567",
        amountNaira: 500,
      },
    });
    expect(await h.send("send 500 recharge to 08021234567")).toMatch(/Airtel airtime/);
  });

  it("picks a data bundle by size", async () => {
    const h = harness({
      "1.5GB data for 08031234567": {
        category: "data",
        customerRef: "08031234567",
        bundle: "1.5GB",
      },
    });
    const r = await h.send("1.5GB data for 08031234567");
    expect(r).toMatch(/MTN data: N1000 1.5GB - 30 days[\s\S]*₦1,000/);
  });

  it("lists bundles when unsure, and takes a bare number without the model", async () => {
    const h = harness({ "data for my line": { category: "data", customerRef: "SELF" } });
    const list = await h.send("data for my line");
    expect(list).toMatch(/1\. N100 100MB/);
    const calls = h.model.calls;
    expect(await h.send("2")).toMatch(/N1500 6GB - 7 days|N1000 1.5GB/);
    expect(h.model.calls).toBe(calls);
  });

  it("renews DStv Compact on the saved smartcard, not Compact Plus", async () => {
    const h = harness({
      "renew my dstv compact": {
        category: "tv",
        provider: "dstv",
        bundle: "compact",
        customerRef: "SELF",
      },
    });
    const r = await h.send("renew my dstv compact");
    expect(r).toMatch(
      /DStv: DStv {2}Compact N7900[\s\S]*Smartcard 1212121212 \(MAMA NGOZI\)[\s\S]*₦7,900/,
    );
  });

  it("sends a bill above the threshold to the sender for approval", async () => {
    const h = harness({ "buy 25k light": { category: "electricity", amountNaira: 25_000 } });
    await h.send("buy 25k light");
    expect(await h.send("YES")).toMatch(/needs Ada's OK first.*above the ₦20,000/);
    expect(h.submitted[0]?.status).toBe("awaiting_approval");
    expect(h.submitted[0]?.approval?.reason).toMatch(/above/);
  });

  it("refuses when the sender has frozen the account", async () => {
    const h = harness(
      { "buy 5k light": { category: "electricity", amountNaira: 5_000 } },
      {
        family: family({ rules: rules({ frozen: true }) }),
      },
    );
    await h.send("buy 5k light");
    expect(await h.send("yes")).toMatch(/can't pay this one: The account is frozen/);
    expect(h.submitted[0]?.status).toBe("rejected");
  });

  it("an unclear answer to the summary pays nothing", async () => {
    const h = harness({
      "buy 5k light": { category: "electricity", amountNaira: 5_000 },
      "e dey alright send am sharp": { intent: "other", language: "pcm" },
    });
    await h.send("buy 5k light");
    expect(await h.send("e dey alright send am sharp")).toMatch(/send YES/i);
    expect(h.submitted).toHaveLength(0);
    expect(h.session().asking).toBe("confirm");
  });

  it("a change after the summary makes a new summary", async () => {
    const h = harness({
      "buy 5k light": { category: "electricity", amountNaira: 5_000 },
      "make am 7k": { language: "pcm", amountNaira: 7_000 },
    });
    await h.send("buy 5k light");
    expect(await h.send("make am 7k")).toMatch(/₦7,000/);
    await h.send("yes");
    expect(h.submitted[0]?.amountNgnKobo).toBe(700_000);
  });

  it("re-prices a summary older than 10 minutes instead of paying it", async () => {
    let t = NOW.getTime();
    const h = harness(
      { "buy 5k light": { category: "electricity", amountNaira: 5_000 } },
      { now: () => new Date(t) },
    );
    await h.send("buy 5k light");
    t += 11 * 60_000;
    expect(await h.send("yes")).toMatch(/price changed/);
    expect(h.submitted).toHaveLength(0);
    expect(h.quotes()).toBe(2);
    await h.send("yes");
    expect(h.submitted).toHaveLength(1);
  });

  it("NO cancels; a wrong meter or phone is caught in code", async () => {
    const h = harness({
      "buy 5k light": { category: "electricity", amountNaira: 5_000 },
      "1k airtime for 0123": { category: "airtime", customerRef: "0123", amountNaira: 1_000 },
      "light for meter 12": { category: "electricity", customerRef: "12" },
    });
    await h.send("buy 5k light");
    expect(await h.send("no")).toMatch(/cancelled/);
    expect(await h.send("1k airtime for 0123")).toMatch(/Nigerian phone number/);
    expect(await h.send("light for meter 12")).toMatch(/meter number \(11 to 13/);
    expect(h.submitted).toHaveLength(0);
  });

  it("asks for the meter again when the biller can't find it", async () => {
    const h = harness(
      { "buy 5k light": { category: "electricity", amountNaira: 5_000 } },
      {
        lookup: {
          ok: false,
          reason: "not_found",
          recipient: "We couldn't find that meter number.",
          raw: null,
        },
      },
    );
    expect(await h.send("buy 5k light")).toMatch(/couldn't find that meter/);
    expect(h.session().asking).toBe("customerRef");
  });

  it("rejects amounts outside the limits", async () => {
    const h = harness({ "buy 200 naira light": { category: "electricity", amountNaira: 200 } });
    expect(await h.send("buy 200 naira light")).toMatch(/smallest amount for this is ₦1,000/);
  });

  it("answers balance in the person's language", async () => {
    const h = harness(
      { "how much remain?": { intent: "balance", language: "pcm" } },
      {
        family: family({ usage: { ...family().usage, spentUsdcAtomic: "12500000" } }),
      },
    );
    expect(await h.send("how much remain?")).toMatch(
      /Wetin remain this month: \$87\.50 out of \$100/,
    );
  });

  it("says when the model is down, and when the chat isn't connected", async () => {
    expect(await harness({ hi: "fail" }).send("hi")).toMatch(/trouble/);
    expect(await harness({}, { family: null }).send("hi")).toMatch(/isn't connected/);
  });
});

describe("updateMessage", () => {
  it("sends the token and the receipt link", () => {
    const o = {
      category: "electricity",
      amountNgnKobo: 1_000_000,
      status: "fulfilled",
      fulfillment: { billerTransactionId: "1", token: "2636 2054", completedAt: NOW.toISOString() },
    } as Order;
    expect(updateMessage(o, "pcm", "https://x/tx")).toBe(
      "E don do! Light ₦10,000 don pay.\nYour token: 2636 2054\nReceipt: https://x/tx",
    );
  });
});

describe("WhatsApp webhook signature", () => {
  it("accepts Twilio's signature and nothing else", async () => {
    const { createHmac } = await import("node:crypto");
    const { WhatsApp } = await import("./channels.js");
    const wa = new WhatsApp({ accountSid: "AC1", authToken: "tok", from: "whatsapp:+14155238886" });
    const url = "https://bot.example/webhooks/whatsapp";
    const params = new URLSearchParams({
      From: "whatsapp:+2348031234567",
      Body: "buy 5k light",
      To: "whatsapp:+14155238886",
    });
    // Twilio: URL, then each field name+value sorted by name, HMAC-SHA1, base64.
    const sig = createHmac("sha1", "tok")
      .update(`${url}Bodybuy 5k lightFromwhatsapp:+2348031234567Towhatsapp:+14155238886`)
      .digest("base64");
    expect(wa.verify(url, params, sig)).toBe(true);
    expect(wa.verify(url, params, undefined)).toBe(false);
    params.set("Body", "buy 50k light");
    expect(wa.verify(url, params, sig)).toBe(false);
    expect(
      WhatsApp.chatOf(new URLSearchParams({ From: "whatsapp:+2348031234567", Body: "hi" })),
    ).toEqual({
      from: "+2348031234567",
      text: "hi",
    });
  });
});
