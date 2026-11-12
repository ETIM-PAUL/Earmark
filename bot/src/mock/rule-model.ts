import type { Extraction } from "../extract.js";
import type { ChatModel } from "../model.js";

/**
 * A stand-in for the NEAR AI model, for the keyless demo: plain rules that
 * read the same fields (intent, category, provider, number, amount) out of
 * the usual phrasings, in English and Pidgin. It only extracts, like the
 * real model; the biller, lookup, price, YES and rule checks are the same
 * code either way. It is far less flexible than the model, and says so.
 */

const PROVIDERS = [
  "ikeja",
  "ikedc",
  "eko",
  "ekedc",
  "abuja",
  "aedc",
  "ibadan",
  "ibedc",
  "kano",
  "enugu",
  "port harcourt",
  "mtn",
  "airtel",
  "glo",
  "9mobile",
  "etisalat",
  "dstv",
  "gotv",
  "startimes",
];

const PIDGIN = /\b(abeg|wetin|dey|una|oya|wahala|sabi|comot|wan|sef|abi|sha)\b/i;

function amountOf(text: string): number | null {
  const k = text.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (k?.[1]) return Number(k[1]) * 1000;
  // Plain numbers of up to 6 digits; longer ones are phone or meter numbers.
  for (const m of text.matchAll(/(?<![\d])₦?\s*(\d{1,3}(?:,\d{3})+|\d{2,6})(?![\d])/g)) {
    return Number((m[1] ?? "").replace(/,/g, ""));
  }
  return null;
}

export function ruleExtraction(text: string): Extraction {
  const t = text.toLowerCase();
  const digits = text.replace(/(?<=\d)[ -](?=\d)/g, "");
  const longNumber = digits.match(/\d{10,13}/)?.[0] ?? null;
  const category: Extraction["category"] = /\b(light|electric\w*|meter|nepa|phcn|token)\b/.test(t)
    ? "electricity"
    : /\b(airtime|recharge|credit|top-?up)\b/.test(t)
      ? "airtime"
      : /\bdata\b|\bgb\b|\bmb\b/.test(t)
        ? "data"
        : /\b(dstv|gotv|startimes|tv|cable|decoder)\b/.test(t)
          ? "tv"
          : null;
  const provider = PROVIDERS.find((p) => new RegExp(`\\b${p}\\b`).test(t)) ?? null;
  const self = /\bmy (meter|line|phone|number|decoder|own)\b|\bfor me\b/.test(t);
  const amount = amountOf(longNumber ? text.replace(longNumber, " ") : text);

  const intent: Extraction["intent"] =
    category || provider || longNumber || amount !== null
      ? "pay_bill"
      : /\b(how much|remain|left|balance|budget)\b/.test(t)
        ? "balance"
        : /\b(receipt|history|last payments?|my payments)\b/.test(t)
          ? "receipts"
          : /\b(cancel|stop|forget|leave am)\b/.test(t)
            ? "cancel"
            : /\b(help|what can you)\b/.test(t)
              ? "help"
              : "other";

  return {
    intent,
    language: PIDGIN.test(t) ? "pcm" : "en",
    category,
    provider,
    customerRef: longNumber ?? (self ? "SELF" : null),
    amountNaira: amount,
    bundle: null,
    meterType: /\bpostpaid\b/.test(t) ? "postpaid" : /\bprepaid\b/.test(t) ? "prepaid" : null,
    choice: null,
  };
}

export const ruleModel: ChatModel = {
  async json(messages) {
    return JSON.stringify(ruleExtraction(messages.at(-1)?.content ?? ""));
  },
};
