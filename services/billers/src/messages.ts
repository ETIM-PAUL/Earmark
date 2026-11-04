/**
 * VTpass response codes in plain words: one line for the recipient's chat,
 * one for whoever is on call. Purchase messages assume the family has
 * already paid us, so every failure says the money is coming back.
 */
export interface BillerMessage {
  code: string;
  /** Short and Pidgin-friendly; safe to show the recipient. */
  recipient: string;
  /** For the on-call log and alerts. */
  operator: string;
  /** Our side is broken (keys, wallet, whitelisting): page the lead. */
  alert: boolean;
}

const COMING_BACK = "Your money is coming back to your account.";

const TABLE: Record<string, Omit<BillerMessage, "code">> = {
  "010": {
    recipient: `That bundle isn't available any more. ${COMING_BACK}`,
    operator: "Variation code does not exist; refresh the variation list.",
    alert: false,
  },
  "011": {
    recipient: `We couldn't send this bill. ${COMING_BACK}`,
    operator: "Invalid arguments: a required field is missing from the request.",
    alert: true,
  },
  "012": {
    recipient: `That biller isn't available right now. ${COMING_BACK}`,
    operator: "Product does not exist on VTpass.",
    alert: true,
  },
  "013": {
    recipient: `That amount is below this biller's minimum. ${COMING_BACK}`,
    operator: "Below the product's minimum amount.",
    alert: false,
  },
  "014": {
    recipient: "We're checking this payment. Please don't send it again.",
    operator: "Request ID already used; requery decides the outcome.",
    alert: false,
  },
  "015": {
    recipient: "We're checking this payment. Please don't send it again.",
    operator: "Requery: VTpass has no transaction with this request ID.",
    alert: false,
  },
  "016": {
    recipient: `The biller couldn't complete this payment. Please check the number. ${COMING_BACK}`,
    operator: "Transaction failed at the biller.",
    alert: false,
  },
  "017": {
    recipient: `That amount is above this biller's maximum. ${COMING_BACK}`,
    operator: "Above the product's maximum amount.",
    alert: false,
  },
  "018": {
    recipient: `We couldn't pay this bill right now. ${COMING_BACK}`,
    operator: "VTpass wallet balance too low: top up the naira float.",
    alert: true,
  },
  "019": {
    recipient: `The same bill was just paid a moment ago. ${COMING_BACK}`,
    operator: "Likely duplicate: same biller code within 30 seconds.",
    alert: false,
  },
  "021": {
    recipient: `We couldn't pay this bill right now. ${COMING_BACK}`,
    operator: "VTpass account locked.",
    alert: true,
  },
  "022": {
    recipient: `We couldn't pay this bill right now. ${COMING_BACK}`,
    operator: "VTpass account suspended.",
    alert: true,
  },
  "023": {
    recipient: `We couldn't pay this bill right now. ${COMING_BACK}`,
    operator: "API access not enabled on the VTpass account.",
    alert: true,
  },
  "024": {
    recipient: `We couldn't pay this bill right now. ${COMING_BACK}`,
    operator: "VTpass account inactive.",
    alert: true,
  },
  "027": {
    recipient: `We couldn't pay this bill right now. ${COMING_BACK}`,
    operator: "Server IP not whitelisted with VTpass.",
    alert: true,
  },
  "028": {
    recipient: `That biller isn't available right now. ${COMING_BACK}`,
    operator: "Product not whitelisted on our VTpass account.",
    alert: true,
  },
  "030": {
    recipient: `The biller isn't responding right now. ${COMING_BACK}`,
    operator: "Biller not reachable.",
    alert: false,
  },
  "034": {
    recipient: `That biller is paused right now. ${COMING_BACK}`,
    operator: "Service suspended on VTpass.",
    alert: false,
  },
  "035": {
    recipient: `That biller is switched off right now. ${COMING_BACK}`,
    operator: "Service inactive on VTpass.",
    alert: false,
  },
  "040": {
    recipient: `The biller sent this payment back. ${COMING_BACK}`,
    operator: "Transaction reversed to our VTpass wallet.",
    alert: false,
  },
  "085": {
    recipient: `We couldn't send this bill. ${COMING_BACK}`,
    operator: "Improper request ID: the date part must be today in Lagos.",
    alert: false,
  },
  "087": {
    recipient: `We couldn't pay this bill right now. ${COMING_BACK}`,
    operator: "Invalid VTpass credentials.",
    alert: true,
  },
  "099": {
    recipient: "We're checking this payment. Please don't send it again.",
    operator: "VTpass is still processing the transaction; requery.",
    alert: false,
  },
  "089": {
    recipient: "We're checking this payment. Please don't send it again.",
    operator: "VTpass still processing a previous request; requery.",
    alert: false,
  },
  "091": {
    recipient: `The biller didn't take this payment. ${COMING_BACK}`,
    operator: "Transaction not processed; VTpass did not charge us.",
    alert: false,
  },
};

const UNKNOWN: Omit<BillerMessage, "code"> = {
  recipient: "We're checking this payment. Please don't send it again; we'll update you.",
  operator: "Unexpected VTpass answer; requery decides the outcome.",
  alert: false,
};

export function describeCode(code: string): BillerMessage {
  return { code, ...(TABLE[code] ?? UNKNOWN) };
}

/** Lookup failures, before any money moves. */
export function describeVerifyFailure(kind: "meter" | "smartcard"): string {
  return kind === "meter"
    ? "We couldn't find that meter number. Please check it and send it again."
    : "We couldn't find that smartcard number. Please check it and send it again.";
}

export const KNOWN_CODES = Object.keys(TABLE);
