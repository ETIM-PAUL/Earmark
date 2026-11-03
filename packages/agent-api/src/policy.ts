import type { HardLimits } from "@earmark/shared";
import type { Policy } from "@near-intents-agent-api/sdk";

/** At most this many payments an hour, so a compromised bot grant can only do bounded harm. */
export const MAX_PAYMENTS_PER_HOUR = 10;

/**
 * The Agent API policy a sender signs for one family account: layer 1 of
 * Earmark's rules (see packages/shared/src/rules.ts).
 *
 * - transfers only, USDC only, to the settlement account only
 * - per-payment cap and monthly USD budget from HardLimits
 *
 * The API's budget period starts when the cap is switched on, not on the
 * 1st of the month. Read live usage from getPolicy().usage.budget.
 */
export function familyPolicy(
  hard: HardLimits,
  usdcAssetId: string,
  opts: { frozen?: boolean; ownerApproval?: boolean } = {},
): Policy {
  return {
    frozen: opts.frozen ?? false,
    actions: ["transfer"],
    confidential: false,
    // All-or-nothing in the API. Earmark's per-amount approvals run in the
    // order service; this stays false in production.
    owner_approval: opts.ownerApproval ?? false,
    assets: [usdcAssetId],
    limits: { per_transaction: { [usdcAssetId]: hard.perTransactionMaxUsdcAtomic } },
    max_actions_per_hour: MAX_PAYMENTS_PER_HOUR,
    destinations: {
      mode: "only",
      list: [{ action: "transfer", address: hard.settlementAccountId, confidential: false }],
    },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: hard.monthlyBudgetUsd },
    timelock_ms: 0,
  };
}
