import type { Lookup } from "@earmark/billers";
import {
  advance,
  type Category,
  evaluateOrder,
  type FamilyId,
  type FamilyRules,
  formatNaira,
  formatUsdc,
  hashCustomerRef,
  type MonthUsage,
  newOrderId,
  type Order,
  type Quote,
} from "@earmark/shared";
import { type Lang, say } from "./copy.js";
import { type Extraction, extract } from "./extract.js";
import type { ChatModel } from "./model.js";
import { localize } from "./pidgin.js";
import {
  LABELS,
  maskRef,
  networkFromPhone,
  normalizeAccount,
  normalizePhone,
  resolveBiller,
} from "./providers.js";
import { type Option, pickVariation } from "./variations.js";

/**
 * One conversation turn: message in, replies out. The model reads the
 * message (extract.ts); everything after that is code: which biller, which
 * number, the lookup, the price, the summary, the YES, and the rule checks.
 *
 * The model can't confirm a payment: only a message that is plainly "yes"
 * does, matched here by a regex, and only while a summary is showing.
 */

export interface SavedRef {
  category: Category;
  billerCode: string;
  ref: string;
  /** e.g. "home meter". Shown to the recipient, never on-chain. */
  label: string;
  meterType?: "prepaid" | "postpaid";
}

export interface Family {
  familyId: FamilyId;
  /** Per-family HMAC salt for customerRefHash. */
  salt: string;
  senderName: string;
  /** The recipient's own number: "my line" and VTpass's contact phone. */
  recipientPhone: string;
  saved: SavedRef[];
  rules: FamilyRules;
  usage: MonthUsage;
}

export interface BotPorts {
  model: ChatModel;
  family: (chat: string) => Promise<Family | null>;
  lookup: (input: {
    category: Category;
    billerCode: string;
    customerRef: string;
    meterType?: "prepaid" | "postpaid";
  }) => Promise<Lookup>;
  /** Throws an error with a `recipient` message when no price is available. */
  quote: (amountNgnKobo: number) => Promise<Quote>;
  variations: (serviceId: string) => Promise<Option[]>;
  /** Hands over an order whose status code has decided: approved, awaiting_approval or rejected. */
  submit: (order: Order, family: Family) => Promise<void>;
  recent: (familyId: FamilyId, n: number) => Promise<Order[]>;
  receiptLink?: (order: Order) => string | null;
  now?: () => Date;
}

export type Slot = "category" | "provider" | "customerRef" | "amount" | "bundle" | "confirm";

export interface Draft {
  category?: Category | undefined;
  billerCode?: string | undefined;
  customerRef?: string | undefined;
  meterType?: "prepaid" | "postpaid" | undefined;
  amountNgnKobo?: number | undefined;
  bundleQuery?: string | undefined;
  variation?: Option | undefined;
  customerName?: string | undefined;
  /** Said before the category was known; resolved once it is. */
  providerSaid?: string | undefined;
  refSaid?: string | undefined;
}

export interface Session {
  lang: Lang;
  draft: Draft;
  asking: Slot | null;
  options?: Option[] | undefined;
  pending?: Order | undefined;
  /** The last order this chat said YES to, so a second YES isn't a second bill. */
  lastSent?: { what: string; at: string } | undefined;
}

/** A YES this soon after a sent order is a double tap, not a new bill. */
const DOUBLE_TAP_MS = 5 * 60 * 1000;

export const newSession = (): Session => ({ lang: "en", draft: {}, asking: null });

export interface Turn {
  replies: string[];
  session: Session;
}

/** Pilot limits per payment, in kobo. VTpass's own minimums still apply. */
const LIMITS: Record<"airtime" | "electricity", { min: number; max: number }> = {
  airtime: { min: 50_00, max: 50_000_00 },
  electricity: { min: 1_000_00, max: 500_000_00 },
};

const POLITE = "(?:\\s+(?:please|pls|abeg|o|oo|sir|ma|now|jare))*[\\s.!👍✅]*";
const YES = new RegExp(
  `^\\s*(?:yes|yeah|yea|yep|yup|ok|okay|k|sure|confirm|confirmed|go ahead|oya|correct|na so|ehen|do am|send am|pay am|pay|y)${POLITE}$`,
  "i",
);
const NO = new RegExp(
  `^\\s*(?:no|nope|nah|n|cancel|stop|leave am|leave it|forget it|forget am|no o|abeg no|don't|dont)${POLITE}$`,
  "i",
);
export const isYes = (s: string) => YES.test(s);
export const isNo = (s: string) => NO.test(s);

export class Dialog {
  private readonly now: () => Date;

  constructor(private readonly ports: BotPorts) {
    this.now = ports.now ?? (() => new Date());
  }

  async handle(chat: string, prev: Session, text: string): Promise<Turn> {
    const s: Session = structuredClone(prev);
    const family = await this.ports.family(chat);
    if (!family) return { replies: [say(s.lang, "notConnected")], session: s };

    // A summary is showing: only a plain yes pays, only a plain no cancels.
    if (s.asking === "confirm" && s.pending) {
      if (isYes(text)) return this.confirm(s, family);
      if (isNo(text)) return this.reply(reset(s), say(s.lang, "cancelled"));
    }
    // YES with nothing showing, just after a YES: the order is already sent.
    if (
      !s.pending &&
      s.lastSent &&
      isYes(text) &&
      this.now().getTime() - Date.parse(s.lastSent.at) < DOUBLE_TAP_MS
    ) {
      return this.reply(s, say(s.lang, "alreadySent", { what: s.lastSent.what }));
    }
    // A numbered list is showing and the reply is just a number: no model needed.
    const bare = text.trim().match(/^(?:number\s*|no\.?\s*|#)?(\d{1,2})[.)]?$/i);
    if (s.asking === "bundle" && s.options && bare) {
      return this.choose(s, family, Number(bare[1]));
    }

    let x: Extraction;
    try {
      x = await extract(this.ports.model, text, { progress: describeProgress(s) });
    } catch {
      return this.reply(s, say(s.lang, "busy"));
    }
    s.lang = x.language;

    switch (x.intent) {
      case "cancel":
        if (!s.asking) return this.reply(s, say(s.lang, "nothingToCancel"));
        return this.reply(reset(s), say(s.lang, "cancelled"));
      case "balance":
        return this.reply(s, this.balance(s.lang, family));
      case "receipts":
        return this.reply(s, await this.receipts(s.lang, family));
      case "help":
        return this.reply(s, say(s.lang, "help", { sender: family.senderName }));
      case "pay_bill":
        break;
      case "other":
        if (!s.asking || !hasSlots(x)) {
          return this.reply(s, say(s.lang, s.asking === "confirm" ? "sayYes" : "notUnderstood"));
        }
    }

    // Neither yes nor no nor a change: the summary still stands.
    if (s.asking === "confirm" && s.pending && !hasSlots(x)) {
      return this.reply(s, say(s.lang, "sayYes"));
    }
    if (s.asking === "bundle" && s.options && x.choice) return this.choose(s, family, x.choice);
    this.merge(s, x);
    return this.next(s, family);
  }

  /** Fold what the message said into the draft, as said. `resolve` checks it. */
  private merge(s: Session, x: Extraction): void {
    const d = s.draft;
    const category = x.category ?? inferCategory(x);
    if (category && d.category && category !== d.category) {
      // A different kind of bill starts over; details said with it still count.
      s.draft = { category };
      s.options = undefined;
    } else if (category) {
      d.category = category;
    }
    const draft = s.draft;
    // Any change after the summary needs a new summary.
    s.pending = undefined;
    if (s.asking === "confirm") s.asking = null;

    if (x.provider) draft.providerSaid = x.provider;
    if (x.meterType) draft.meterType = x.meterType;
    if (x.bundle) {
      draft.bundleQuery = x.bundle;
      draft.variation = undefined;
    }
    if (x.amountNaira !== null) {
      draft.amountNgnKobo = Math.round(x.amountNaira * 100);
      if (draft.category === "data" || draft.category === "tv") draft.variation = undefined;
    }
    if (x.customerRef) draft.refSaid = x.customerRef;
  }

  /** Turn what was said into a biller and a number, once the category is known. */
  private resolve(s: Session, family: Family): string | null {
    const d = s.draft;
    const cat = d.category;
    if (!cat) return null;
    if (d.providerSaid) {
      const biller = resolveBiller(cat, d.providerSaid);
      d.providerSaid = undefined;
      if (!biller) return say(s.lang, "unknownBiller");
      if (biller !== d.billerCode) {
        d.billerCode = biller;
        d.variation = undefined;
        d.customerName = undefined;
      }
    }
    if (d.refSaid) {
      const said = d.refSaid;
      d.refSaid = undefined;
      const ref = said.toUpperCase() === "SELF" ? this.selfRef(family, d) : said;
      if (!ref) return null; // "my meter" with several saved: ask which
      const norm =
        cat === "airtime" || cat === "data" ? normalizePhone(ref) : normalizeAccount(cat, ref);
      if (!norm) {
        s.asking = "customerRef";
        return say(
          s.lang,
          cat === "electricity" ? "badMeter" : cat === "tv" ? "badSmartcard" : "badPhone",
        );
      }
      d.customerRef = norm;
      d.customerName = undefined;
    }
    return null;
  }

  /** Ask for the first missing thing, or show the summary. */
  private async next(s: Session, family: Family): Promise<Turn> {
    const d = s.draft;
    const lang = s.lang;
    if (!d.category) return this.ask(s, "category", say(lang, "askCategory"));
    const cat = d.category;
    const problem = this.resolve(s, family);
    if (problem) return this.reply(s, problem);

    // Fill what we can from saved numbers and the phone prefix.
    if (cat === "airtime" || cat === "data") {
      if (d.customerRef && !d.billerCode) {
        const net = networkFromPhone(d.customerRef);
        if (net) d.billerCode = cat === "data" ? `${net}-data` : net;
      }
    } else {
      const saved = family.saved.filter(
        (r) => r.category === cat && (!d.billerCode || r.billerCode === d.billerCode),
      );
      if (!d.customerRef && saved.length === 1 && saved[0]) {
        d.customerRef = saved[0].ref;
        d.billerCode ??= saved[0].billerCode;
        d.meterType ??= saved[0].meterType;
      }
      if (d.customerRef && !d.billerCode) {
        const known = family.saved.find((r) => r.category === cat && r.ref === d.customerRef);
        if (known) {
          d.billerCode = known.billerCode;
          d.meterType ??= known.meterType;
        }
      }
    }

    // Phones first: the number usually tells us the network.
    const phoneBill = cat === "airtime" || cat === "data";
    if (phoneBill && !d.customerRef) return this.ask(s, "customerRef", say(lang, "askPhone"));
    if (!d.billerCode) {
      const key = cat === "electricity" ? "askDisco" : cat === "tv" ? "askTv" : "askNetwork";
      return this.ask(s, "provider", say(lang, key));
    }
    if (!d.customerRef) {
      const key = cat === "electricity" ? "askMeter" : "askSmartcard";
      return this.ask(s, "customerRef", say(lang, key));
    }

    if (cat === "airtime" || cat === "electricity") {
      if (!d.amountNgnKobo) return this.ask(s, "amount", say(lang, "askAmount"));
      const { min, max } = LIMITS[cat];
      if (d.amountNgnKobo < min || d.amountNgnKobo > max || d.amountNgnKobo % 100) {
        const msg =
          d.amountNgnKobo > max
            ? say(lang, "tooBig", { max: formatNaira(max) })
            : say(lang, "tooSmall", { min: formatNaira(min) });
        d.amountNgnKobo = undefined;
        return this.ask(s, "amount", `${msg} ${say(lang, "askAmount")}`);
      }
    } else if (!d.variation) {
      const options = await this.ports.variations(d.billerCode);
      const pick = pickVariation(options, d.bundleQuery ?? null, d.amountNgnKobo ?? null);
      if (pick.kind === "one") {
        d.variation = pick.option;
      } else {
        s.options = pick.options;
        const head = say(lang, pick.kind === "none" ? "noMatch" : "askBundle");
        const list = pick.options.map((o, i) => `${i + 1}. ${o.name}`).join("\n");
        return this.ask(s, "bundle", `${head}\n${list}`);
      }
    }
    if (d.variation) d.amountNgnKobo = d.variation.amountNgnKobo;

    return this.summarise(s, family);
  }

  private async choose(s: Session, family: Family, n: number): Promise<Turn> {
    const option = s.options?.[n - 1];
    if (!option) return this.reply(s, say(s.lang, "askBundle"));
    s.draft.variation = option;
    s.draft.amountNgnKobo = option.amountNgnKobo;
    s.options = undefined;
    return this.summarise(s, family);
  }

  /** Lookup, quote, and the summary the recipient says YES to. */
  private async summarise(s: Session, family: Family): Promise<Turn> {
    const d = s.draft;
    const lang = s.lang;
    const cat = d.category as Category;
    const billerCode = d.billerCode as string;
    const ref = d.customerRef as string;

    if ((cat === "electricity" || cat === "tv") && !d.customerName) {
      const found = await this.ports.lookup({
        category: cat,
        billerCode,
        customerRef: ref,
        ...(cat === "electricity" ? { meterType: d.meterType ?? "prepaid" } : {}),
      });
      if (!found.ok) {
        if (found.reason === "not_found") {
          d.customerRef = undefined;
          return this.ask(s, "customerRef", localize(found.recipient, lang));
        }
        return this.reply(s, localize(found.recipient, lang));
      }
      d.customerName = found.customerName ?? "";
    }

    let quote: Quote;
    try {
      quote = await this.ports.quote(d.amountNgnKobo as number);
    } catch (e) {
      const r = (e as { recipient?: string }).recipient;
      const msg = r ? localize(r, lang) : say(lang, "busy");
      return this.reply(s, msg);
    }

    const at = this.now();
    const label = LABELS[billerCode] ?? billerCode;
    const draft: Order = {
      id: newOrderId(at),
      familyId: family.familyId,
      category: cat,
      billerCode,
      ...(cat === "electricity"
        ? { variationCode: d.meterType ?? "prepaid" }
        : d.variation
          ? { variationCode: d.variation.code }
          : {}),
      customerRef: ref,
      customerRefHash: await hashCustomerRef(family.salt, cat, ref),
      customerName: d.customerName || `${label} ${ref}`,
      amountNgnKobo: d.amountNgnKobo as number,
      status: "draft",
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    };
    s.pending = advance(draft, "awaiting_confirmation", { quote }, at);
    s.asking = "confirm";
    return this.reply(s, this.summaryText(lang, s.pending, d));
  }

  private summaryText(lang: Lang, o: Order, d: Draft): string {
    const label = LABELS[o.billerCode] ?? o.billerCode;
    const what =
      o.category === "electricity"
        ? `${label} ${o.variationCode ?? "prepaid"} electricity`
        : o.category === "airtime"
          ? `${label} airtime`
          : `${label}: ${d.variation?.name ?? o.variationCode}`;
    const name = d.customerName ? ` (${d.customerName})` : "";
    const who =
      o.category === "electricity"
        ? `Meter ${o.customerRef}${name}`
        : o.category === "tv"
          ? `Smartcard ${o.customerRef}${name}`
          : `Phone ${o.customerRef}`;
    return say(lang, "summary", {
      what,
      who,
      naira: formatNaira(o.amountNgnKobo),
      usd: o.quote ? formatUsdc(o.quote.amountUsdcAtomic) : "?",
    });
  }

  /** The recipient said YES. Rules decide, in code. */
  private async confirm(s: Session, family: Family): Promise<Turn> {
    const lang = s.lang;
    let order = s.pending as Order;
    const at = this.now();
    if (!order.quote || at.getTime() >= Date.parse(order.quote.expiresAt)) {
      // Requote: a 10-minute-old price is never paid.
      const turn = await this.summarise({ ...s, pending: undefined }, family);
      turn.replies[0] = `${say(lang, "priceMoved")}\n${turn.replies[0]}`;
      return turn;
    }

    const verdict = evaluateOrder(order, family.rules, family.usage);
    let reply: string;
    if (verdict.outcome === "allow") {
      order = advance(order, "approved", {}, at);
      reply = say(lang, "paying");
    } else if (verdict.outcome === "needs_approval") {
      const why = verdict.breaches.map((b) => b.message).join(" ");
      const whyLocal = localize(why, lang);
      order = advance(
        order,
        "awaiting_approval",
        {
          approval: { reason: why, requestedAt: at.toISOString() },
        },
        at,
      );
      reply = say(lang, "needsApproval", { sender: family.senderName, why: whyLocal });
    } else {
      const why = verdict.breaches
        .filter((b) => b.layer === "hard")
        .map((b) => b.message)
        .join(" ");
      order = advance(order, "rejected", { failureReason: why }, at);
      reply = say(lang, "rejected", { why: localize(why, lang) });
    }
    await this.ports.submit(order, family);
    const next = reset(s);
    if (order.status === "approved" || order.status === "awaiting_approval") {
      next.lastSent = {
        what: `${CATEGORY_LABEL[order.category]} ${formatNaira(order.amountNgnKobo)}`,
        at: at.toISOString(),
      };
    }
    return this.reply(next, reply);
  }

  private balance(lang: Lang, family: Family): string {
    if (family.rules.frozen) return say(lang, "frozen", { sender: family.senderName });
    const budget = BigInt(Math.round(Number(family.rules.hardLimits.monthlyBudgetUsd) * 1e6));
    const spent = BigInt(family.usage.spentUsdcAtomic);
    const left = budget > spent ? budget - spent : 0n;
    const cats = (
      Object.entries(family.rules.categories) as [Category, FamilyRules["categories"][Category]][]
    )
      .filter(([, r]) => r.enabled && r.monthlyCapNgnKobo !== null)
      .map(([c, r]) => {
        const capLeft = Math.max(
          0,
          (r.monthlyCapNgnKobo ?? 0) - family.usage.spentNgnKoboByCategory[c],
        );
        return `\n${CATEGORY_LABEL[c]}: ${formatNaira(capLeft)} left`;
      })
      .join("");
    return say(lang, "balance", {
      left: formatUsdc(left.toString()),
      budget: `$${family.rules.hardLimits.monthlyBudgetUsd}`,
      cats,
    });
  }

  private async receipts(lang: Lang, family: Family): Promise<string> {
    const orders = await this.ports.recent(family.familyId, 5);
    if (orders.length === 0) return say(lang, "noReceipts");
    const lines = orders.map((o) => {
      const day = new Date(o.createdAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "Africa/Lagos",
      });
      const link = this.ports.receiptLink?.(o);
      return `• ${day} · ${CATEGORY_LABEL[o.category]} ${formatNaira(o.amountNgnKobo)} · ${maskRef(o.customerRef)} · ${STATUS_LABEL[o.status] ?? o.status}${link ? `\n  ${link}` : ""}`;
    });
    return `${say(lang, "receiptsHead")}\n${lines.join("\n")}`;
  }

  private selfRef(family: Family, d: Draft): string | null {
    if (!d.category || d.category === "airtime" || d.category === "data")
      return family.recipientPhone;
    const saved = family.saved.filter(
      (r) => r.category === d.category && (!d.billerCode || r.billerCode === d.billerCode),
    );
    return saved.length === 1 && saved[0] ? saved[0].ref : null;
  }

  private ask(s: Session, slot: Slot, text: string): Turn {
    s.asking = slot;
    return { replies: [text], session: s };
  }

  private reply(s: Session, text: string): Turn {
    return { replies: [text], session: s };
  }
}

/** What the bot tells the recipient when an order moves after YES. */
export function updateMessage(o: Order, lang: Lang, receiptLink: string | null): string | null {
  const what = `${CATEGORY_LABEL[o.category]} ${formatNaira(o.amountNgnKobo)}`;
  switch (o.status) {
    case "fulfilled": {
      const lines = [say(lang, "fulfilled", { what })];
      if (o.fulfillment?.token) lines.push(say(lang, "token", { token: o.fulfillment.token }));
      if (o.fulfillment?.units) lines.push(say(lang, "units", { units: o.fulfillment.units }));
      if (receiptLink) lines.push(say(lang, "receipt", { link: receiptLink }));
      return lines.join("\n");
    }
    case "refunded": {
      const lines = [o.failureReason ? localize(o.failureReason, lang) : say(lang, "refunded")];
      if (receiptLink) lines.push(say(lang, "receipt", { link: receiptLink }));
      return lines.join("\n");
    }
    case "declined":
    case "expired":
    case "rejected":
      return o.failureReason ? localize(o.failureReason, lang) : null;
    default:
      return null;
  }
}

const CATEGORY_LABEL: Record<Category, string> = {
  electricity: "Light",
  airtime: "Airtime",
  data: "Data",
  tv: "TV",
};

const STATUS_LABEL: Partial<Record<Order["status"], string>> = {
  fulfilled: "paid",
  refunded: "refunded",
  awaiting_approval: "waiting for approval",
  approved: "paying",
  paying: "paying",
  paid: "paying",
  purchasing: "paying",
  rejected: "not allowed",
  declined: "declined",
  expired: "expired",
};

function reset(s: Session): Session {
  return { lang: s.lang, draft: {}, asking: null, ...(s.lastSent ? { lastSent: s.lastSent } : {}) };
}

function hasSlots(x: Extraction): boolean {
  return !!(
    x.category ||
    x.provider ||
    x.customerRef ||
    x.amountNaira ||
    x.bundle ||
    x.choice ||
    x.meterType
  );
}

/** "ikedc" says electricity even when "light" wasn't. */
function inferCategory(x: Extraction): Category | null {
  if (!x.provider) return null;
  for (const c of ["electricity", "tv"] as const) if (resolveBiller(c, x.provider)) return c;
  return null;
}

/** For the model: what we already have and what we just asked. No numbers. */
function describeProgress(s: Session): string | null {
  if (!s.asking) return null;
  const d = s.draft;
  const parts = [
    d.category && `category ${d.category}`,
    d.billerCode && `provider ${LABELS[d.billerCode] ?? d.billerCode}`,
    d.customerRef && "number given",
    d.amountNgnKobo && "amount given",
    d.variation && `plan ${d.variation.name}`,
  ].filter(Boolean);
  const asked: Record<Slot, string> = {
    category: "what kind of bill",
    provider: "which company or network",
    customerRef:
      d.category === "electricity"
        ? "the meter number"
        : d.category === "tv"
          ? "the smartcard number"
          : "the phone number",
    amount: "the amount in naira",
    bundle: "which plan, from a numbered list",
    confirm: "YES or NO to the summary",
  };
  return `Bill in progress: ${parts.join(", ") || "nothing yet"}. We just asked for ${asked[s.asking]}.`;
}
