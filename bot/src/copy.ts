/**
 * Everything the bot says, in English and Pidgin. Replies come from these
 * templates, never from the model, so it can't invent an amount, a rule or
 * a promise.
 */

export type Lang = "en" | "pcm";

type Text = Record<Lang, string>;
const t = (en: string, pcm: string): Text => ({ en, pcm });

export const COPY = {
  askCategory: t(
    "What would you like to pay? Light (electricity), airtime, data or TV?",
    "Wetin you wan pay? Light, airtime, data or TV?",
  ),
  askDisco: t(
    "Which electricity company? For example Ikeja, Eko, Abuja or Ibadan.",
    "Which light company? Like Ikeja, Eko, Abuja or Ibadan.",
  ),
  askNetwork: t(
    "Which network? MTN, Airtel, Glo or 9mobile?",
    "Which network? MTN, Airtel, Glo or 9mobile?",
  ),
  askTv: t(
    "Which TV? DStv, GOtv, StarTimes or Showmax?",
    "Which TV? DStv, GOtv, StarTimes or Showmax?",
  ),
  askMeter: t("What's the meter number?", "Wetin be the meter number?"),
  askPhone: t("Which phone number?", "Which phone number?"),
  askSmartcard: t("What's the smartcard (IUC) number?", "Wetin be the smartcard (IUC) number?"),
  askAmount: t("How much, in naira?", "How much (naira)?"),
  askBundle: t("Which plan? Reply with the number:", "Which plan you want? Send the number:"),
  noMatch: t(
    "I couldn't find that plan. Here are some options. Reply with the number:",
    "I no see that plan. See some options, send the number:",
  ),
  badMeter: t(
    "That doesn't look like a meter number (11 to 13 digits). Please send it again.",
    "That one no be meter number (11 to 13 digits). Abeg send am again.",
  ),
  badPhone: t(
    "That doesn't look like a Nigerian phone number. Please send it again.",
    "That one no be Naija phone number. Abeg send am again.",
  ),
  badSmartcard: t(
    "That doesn't look like a smartcard number (10 or 11 digits). Please send it again.",
    "That one no be smartcard number (10 or 11 digits). Abeg send am again.",
  ),
  askWhich: t(
    "Which {kind}? {names}. You can also send a number from the list {sender} set up.",
    "Which {kind}? {names}. You fit also send number wey {sender} don add.",
  ),
  notOnList: t(
    "That {kind} isn't on the list {sender} set up, so I can't pay for it. Ask {sender} to add it in Earmark, then try again.",
    "That {kind} no dey the list wey {sender} set, so I no fit pay am. Abeg tell {sender} make e add am for Earmark, then try again.",
  ),
  tooSmall: t(
    "The smallest amount for this is {min}.",
    "The smallest amount for this one na {min}.",
  ),
  tooBig: t("That's more than {max} in one payment.", "E pass {max} for one payment."),
  unknownBiller: t(
    "I don't know that company yet. Which one is it?",
    "I never sabi that company. Which one e be?",
  ),
  summary: t(
    "{what}\n{who}\nAmount: {naira} (about {usd})\n\nReply YES to pay or NO to cancel.",
    "{what}\n{who}\nAmount: {naira} (about {usd})\n\nSend YES make I pay, or NO to cancel.",
  ),
  sayYes: t(
    "Please reply YES to pay or NO to cancel.",
    "Abeg send YES make I pay, or NO to cancel.",
  ),
  priceMoved: t("The price changed while we waited.", "The price don change as we dey wait."),
  cancelled: t("OK, cancelled. Nothing was paid.", "No wahala, I don cancel am. Nothing comot."),
  nothingToCancel: t("There's nothing in progress.", "Nothing dey ground to cancel."),
  paying: t(
    "Paying now. I'll message you when it's done.",
    "I dey pay am now. I go message you once e done.",
  ),
  needsApproval: t(
    "This needs {sender}'s OK first: {why} I've asked them, and I'll tell you when they answer.",
    "{sender} go first approve this one: {why} I don ask am, I go tell you when e answer.",
  ),
  approvedPaying: t(
    "{sender} said yes. Paying now. I'll message you when it's done.",
    "{sender} don talk yes. I dey pay am now. I go message you once e done.",
  ),
  rejected: t("I can't pay this one: {why}", "I no fit pay this one: {why}"),
  fulfilled: t("Done! {what} paid.", "E don do! {what} don pay."),
  token: t("Your token: {token}", "Your token: {token}"),
  units: t("Units: {units}", "Units: {units}"),
  receipt: t("Receipt: {link}", "Receipt: {link}"),
  failed: t("{why}", "{why}"),
  refunded: t("The money is back in your account.", "The money don return to your account."),
  balance: t(
    "Budget left this month: {left} of {budget}.{cats}",
    "Wetin remain this month: {left} out of {budget}.{cats}",
  ),
  frozen: t("Payments are paused by {sender} right now.", "{sender} don pause payments for now."),
  noReceipts: t("No payments yet.", "No payment never happen yet."),
  receiptsHead: t("Your last payments:", "Your last payments:"),
  help: t(
    'I can pay light, airtime, data and TV from the money {sender} sends. Try: "buy 5k light for my meter", "1k MTN airtime for 0803…", "how much is left?"',
    'I fit pay light, airtime, data and TV from the money {sender} dey send. Try: "abeg buy 5k light for my meter", "1k MTN airtime for 0803…", "how much remain?"',
  ),
  notUnderstood: t(
    'Sorry, I didn\'t get that. You can say things like "buy 5k light" or "how much is left?"',
    'Sorry, I no understand. You fit talk like "buy 5k light" or "how much remain?"',
  ),
  busy: t(
    "Sorry, I'm having trouble right now. Please try again in a minute.",
    "Sorry, network dey worry me. Abeg try again small time.",
  ),
  textOnly: t("Please send text messages only.", "Abeg na text message only."),
  connected: t(
    "Welcome! This chat is now connected to {sender}'s family account.",
    "You don land! This chat don connect to {sender} family account.",
  ),
  inviteUnknown: t(
    "That invite link doesn't look right — it may be cut off. Check you copied the whole link, or ask the person who sends you money to send it again.",
    "That invite link no correct — e fit cut short. Check say you copy the whole link, or ask the person wey dey send you money make e send am again.",
  ),
  inviteExpired: t(
    "That invite link has expired. Ask the person who sends you money to send you a new one.",
    "That invite link don expire. Ask the person wey dey send you money make e send you new one.",
  ),
  inviteUsed: t(
    "That invite link was already used to connect a different chat. If that's you on another device, use this chat instead; otherwise ask the person who sends you money for a new link.",
    "That invite link don already connect another chat. If na you for another phone, use this chat instead; if not, ask the person wey dey send you money for new link.",
  ),
  notConnected: t(
    "This chat isn't connected to a family account yet. Ask the person who sends you money for your invite link.",
    "This chat never connect to family account. Ask the person wey dey send you money for the invite link.",
  ),
  lookupFailed: t("{why}", "{why}"),
  checking: t(
    "We're checking this payment. Please don't send it again; we'll update you.",
    "We dey check this payment. Abeg no send am again; we go update you.",
  ),
  alreadySent: t(
    "That one is already on its way ({what}). I'll message you when it's done.",
    "I don already send that one ({what}). I go message you once e done.",
  ),
  slowDown: t(
    "You're sending messages too fast. Please wait a minute, then try again.",
    "You dey send message too fast. Abeg wait one minute, then try again.",
  ),
} satisfies Record<string, Text>;

export type CopyKey = keyof typeof COPY;

export function say(lang: Lang, key: CopyKey, vars: Record<string, string> = {}): string {
  return COPY[key][lang].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}
