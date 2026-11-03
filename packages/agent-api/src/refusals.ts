import { AgentApiError } from "@near-intents-agent-api/sdk";

/**
 * Agent API refusal codes in plain words: one line for the recipient's
 * chat, one for the sender's app. Refusals in this table sent nothing, so
 * no money moved.
 */
export interface Refusal {
  code: string;
  /** Short, Pidgin-friendly, for the recipient. */
  recipient: string;
  /** What the sender can do about it. */
  sender: string;
}

const TABLE: Record<string, Omit<Refusal, "code">> = {
  wallet_frozen: {
    recipient: "Your account is paused by your sender. No money was taken.",
    sender: "The account is frozen. Unfreeze it to allow payments again.",
  },
  spend_budget_exceeded: {
    recipient: "This month's budget is used up. No money was taken.",
    sender: "The monthly budget is used up. Raise it or wait for the reset.",
  },
  policy_transaction_limit_exceeded: {
    recipient: "This amount is above the limit for one payment. No money was taken.",
    sender: "This payment is above the per-payment maximum you signed.",
  },
  policy_limit_exceeded: {
    recipient: "This amount is above your limit. No money was taken.",
    sender: "This payment is above a limit you signed.",
  },
  policy_denied: {
    recipient: "This amount is above your limit. No money was taken.",
    sender: "This payment is above a limit you signed.",
  },
  policy_action_limit_exceeded: {
    recipient: "Too many payments in the last hour. Try again later.",
    sender: "The hourly payment count is reached.",
  },
  policy_destination_denied: {
    recipient: "This payment can't go through. No money was taken.",
    sender: "The payment went to an address your rules don't allow.",
  },
  insufficient_balance: {
    recipient: "There isn't enough money in the account. Ask your sender to top up.",
    sender: "The account balance is too low. Top up to continue.",
  },
  policy_not_ready: {
    recipient: "Your account is still being set up. Try again in a few minutes.",
    sender: "Your latest rule change is still being applied.",
  },
  authorization_stale: {
    recipient: "This payment needs a fresh approval. No money was taken.",
    sender: "The rules or access changed after you approved. Approve again.",
  },
};

// Unknown codes may include server failures whose request took effect, so
// never claim that no money moved. The order service reconciles by status.
const FALLBACK: Omit<Refusal, "code"> = {
  recipient: "We're checking this payment. Please don't send it again; we'll update you.",
  sender: "The account service returned an unexpected error. We're checking the payment.",
};

export function describeRefusal(error: unknown): Refusal | null {
  if (!(error instanceof AgentApiError)) return null;
  return { code: error.code, ...(TABLE[error.code] ?? FALLBACK) };
}

export const KNOWN_REFUSAL_CODES = Object.keys(TABLE);
