import type { Lang } from "./copy.js";

/**
 * Pidgin for messages made outside the bot: biller outcomes, lookups, the
 * float guard, quotes and rule checks. They are written in English where
 * they are made; this translates them sentence by sentence. A test checks
 * that every one has a translation.
 */

const SENTENCES: Record<string, string> = {
  "Your money is coming back to your account.": "Your money dey come back to your account.",
  "We're checking this payment.": "We dey check this payment.",
  "Please don't send it again.": "Abeg no send am again.",
  "Please don't send it again; we'll update you.": "Abeg no send am again; we go update you.",
  "That amount is above this biller's maximum.": "That amount pass wetin this biller fit collect.",
  "That amount is below this biller's minimum.":
    "That amount small pass wetin this biller dey collect.",
  "That biller is paused right now.": "That biller don pause for now.",
  "That biller is switched off right now.": "That biller no dey work for now.",
  "That biller isn't available right now.": "That biller no dey available now.",
  "That bundle isn't available any more.": "That bundle no dey again.",
  "The biller couldn't complete this payment.": "The biller no fit finish this payment.",
  "Please check the number.": "Abeg check the number.",
  "The biller didn't take this payment.": "The biller no collect this payment.",
  "The biller isn't responding right now.": "The biller no dey answer now.",
  "The biller sent this payment back.": "The biller don return this payment.",
  "The same bill was just paid a moment ago.": "The same bill just pay small time ago.",
  "We couldn't pay this bill right now.": "We no fit pay this bill now.",
  "We couldn't send this bill.": "We no fit send this bill.",
  "This order lost its price.": "This order no get price again.",
  "This order is from yesterday, so we couldn't send it today.":
    "This order na from yesterday, so we no fit send am today.",
  "The biller never received this payment.": "The biller never receive this payment.",
  "We couldn't find that meter number.": "We no see that meter number.",
  "We couldn't find that smartcard number.": "We no see that smartcard number.",
  "Please check it and send it again.": "Abeg check am and send am again.",
  "We couldn't reach the biller just now.": "We no fit reach the biller now.",
  "Please try again in a minute.": "Abeg try again for one minute time.",
  "Bill payments are paused for a short while.": "Bill payment don pause small.",
  "Please try again later.": "Abeg try again later.",
  "We can't price bills right now.": "We no fit price bill now.",
  "Please try again in a few minutes.": "Abeg try again after some minutes.",
  "The account is frozen by the sender.": "The person wey dey send money don freeze the account.",
  "This meter is not on the approved list.": "This meter no dey the approved list.",
  "This smartcard is not on the approved list.": "This smartcard no dey the approved list.",
  "This phone number is not on the approved list.": "This phone number no dey the approved list.",
  "We couldn't move the money for this bill.": "We no fit move the money for this bill.",
  "Nothing left the account.": "Nothing comot from the account.",
};

/** Sentences with amounts in them, from evaluateOrder. */
const PATTERNS: [RegExp, string][] = [
  [
    /^(\$[\d.,]+) is above the (\$[\d.,]+) per-payment maximum\.$/,
    "$1 pass the $2 wey one payment fit be.",
  ],
  [
    /^Only (\$[\d.,]+) of the (\$[\d.,]+) monthly budget is left\.$/,
    "Na only $1 remain from the $2 for this month.",
  ],
  [/^(\w+) is not switched on\.$/, "$1 never on."],
  [
    /^(\w+) would reach (₦[\d.,]+) this month; the cap is (₦[\d.,]+)\.$/,
    "$1 go reach $2 this month; the limit na $3.",
  ],
  [/^(₦[\d.,]+) is above the (₦[\d.,]+) that needs approval\.$/, "$1 pass $2, so e need approval."],
];

/** Split after . ! or ? followed by a space, so "$87.50" stays whole. */
function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}

function one(s: string): string | null {
  const exact = SENTENCES[s];
  if (exact) return exact;
  for (const [re, out] of PATTERNS) if (re.test(s)) return s.replace(re, out);
  return null;
}

/** Pidgin for a message made in English; unknown sentences stay as they are. */
export function localize(text: string, lang: Lang): string {
  if (lang === "en") return text;
  return sentences(text)
    .map((s) => one(s) ?? s)
    .join(" ");
}

/** For tests: the sentences we have no Pidgin for. */
export function untranslated(text: string): string[] {
  return sentences(text).filter((s) => one(s) === null);
}
