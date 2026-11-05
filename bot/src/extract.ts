import { z } from "zod";
import type { ChatMessage, ChatModel } from "./model.js";

/**
 * The model's only job: read one message and say what it asks for. It
 * never sees rules, balances or prices, can't confirm a payment, and
 * everything it returns is checked in code before use.
 */

export const Intent = z.enum([
  "pay_bill", // wants to buy, or is adding details to a bill in progress
  "balance", // how much is left, budget left
  "receipts", // past payments
  "cancel", // stop the bill in progress
  "help",
  "other",
]);
export type Intent = z.infer<typeof Intent>;

const nullable = <T extends z.ZodType>(t: T) => t.nullable().catch(null).default(null);

export const Extraction = z.object({
  intent: Intent.catch("other"),
  language: z.enum(["en", "pcm"]).catch("en"),
  category: nullable(z.enum(["electricity", "airtime", "data", "tv"])),
  /** The biller as said: "ikedc", "9mobile", "dstv". Code maps it. */
  provider: nullable(z.string().max(60)),
  /** Digits as said, or "SELF" for "my line"/"my meter". */
  customerRef: nullable(z.string().max(40)),
  amountNaira: nullable(z.number().positive().max(10_000_000)),
  /** Bundle or bouquet words: "1.5GB", "compact", "padi". */
  bundle: nullable(z.string().max(60)),
  meterType: nullable(z.enum(["prepaid", "postpaid"])),
  /** A number picked from a list we showed. */
  choice: nullable(z.number().int().min(1).max(20)),
});
export type Extraction = z.infer<typeof Extraction>;

export const SYSTEM_PROMPT = `You read WhatsApp/Telegram messages from people in Nigeria who pay household bills with money a relative sent them. Messages are in English, Nigerian Pidgin, or a mix. You only extract what the LATEST message says, as one JSON object. You never decide or approve anything.

Keys (use null when the latest message doesn't say it):
- intent: "pay_bill" (wants to buy electricity/light, airtime/recharge/card, data, TV/cable, or is giving details for a bill already in progress, e.g. just a number or an amount), "balance" (money/budget left), "receipts" (past payments), "cancel" (no / stop / leave am / forget it), "help", "other".
- language: "pcm" if the message uses Pidgin (abeg, wetin, dey, una, na, oya, wan, make, am, sef, abi, sha, comot), else "en".
- category: "electricity" (light, NEPA, PHCN, meter, token, prepaid/postpaid), "airtime" (recharge, card, credit, top-up, call credit), "data" (data, MB, GB, browse, bundle), "tv" (DStv, GOtv, StarTimes, Showmax, cable, decoder, subscription).
- provider: the company exactly as written, e.g. "ikeja", "ikedc", "eko", "aedc", "mtn", "airtel", "glo", "9mobile", "dstv", "gotv". For airtime or data on a network, put the network.
- customerRef: the meter, phone or smartcard number as digits only. "SELF" if they mean their own line or their usual meter/decoder without giving a number ("my line", "my meter", "for me", "my number").
- amountNaira: naira as a number. "10k" = 10000, "2.5k" = 2500, "5 thousand" = 5000, "N1,500" = 1500, "one k" = 1000. Not for bundle sizes like 1.5GB.
- bundle: data bundle or TV bouquet words, e.g. "1.5GB", "10GB monthly", "compact", "padi", "jolli". Null for airtime and electricity.
- meterType: "prepaid" or "postpaid" only if said.
- choice: if the message is just a number picking from a numbered list we sent (e.g. "2", "number 3", "the first one" = 1), that number; then leave customerRef and amountNaira null.

Return only the JSON object.`;

/** What we tell the model about the conversation so far, to read follow-ups. */
export interface ExtractContext {
  /** e.g. "A bill in progress: electricity, Ikeja Electric; we asked for the meter number." */
  progress: string | null;
}

export async function extract(
  model: ChatModel,
  text: string,
  ctx: ExtractContext = { progress: null },
): Promise<Extraction> {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  if (ctx.progress) messages.push({ role: "assistant", content: ctx.progress });
  messages.push({ role: "user", content: text.slice(0, 500) });

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await model.json(messages);
    try {
      return Extraction.parse(JSON.parse(stripFences(raw)));
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`model reply was not a valid extraction: ${String(lastError)}`);
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}
