import { describeRefusal, waitForStatus } from "@earmark/agent-api";
import type { Order } from "@earmark/shared";
import { type AgentApi, AgentApiError } from "@near-intents-agent-api/sdk";
import { type Payer, PaymentRefused } from "./demo.js";

/**
 * Pays settlement for real, through the Agent API: one pre-provisioned
 * agent account and grant (from `pnpm setup:agent-production`) backs every
 * order, since real per-sender wallet signing isn't built. The order ID is
 * the idempotency key, so a retried `pay()` for the same order never pays
 * twice.
 */
export interface AgentApiPayerOptions {
  api: AgentApi;
  grantToken: string;
  agentId: string;
  usdcAssetId: string;
  settlementAccountId: string;
}

export function createAgentApiPayer(opts: AgentApiPayerOptions): Payer {
  const bot = opts.api.forGrant(opts.grantToken);
  return {
    async pay(order: Order): Promise<{ txHash: string }> {
      if (!order.quote) throw new Error(`order ${order.id} has no quote to pay against`);
      let status: Awaited<ReturnType<typeof waitForStatus>>;
      try {
        const execution = await bot.transfer(
          opts.agentId,
          {
            asset: opts.usdcAssetId,
            amount: order.quote.amountUsdcAtomic,
            recipient: opts.settlementAccountId,
          },
          // The order ID is already a stable unique string; reusing it (not
          // createIdempotencyKey(), which mints a fresh random one each
          // call) is what lets a retried pay() for the same order never
          // double-pay.
          { idempotencyKey: order.id },
        );
        status =
          execution.status === "PENDING_APPROVAL"
            ? execution
            : await waitForStatus(opts.api, execution.correlation_id);
      } catch (e) {
        if (e instanceof AgentApiError) {
          throw new PaymentRefused(describeRefusal(e)?.recipient ?? e.message);
        }
        throw e; // network / 5xx / timeout: the order stays in "paying" and this is retried
      }
      if (status.status === "SUCCESS") {
        const txHash = "tx_hash" in status.details ? status.details.tx_hash : null;
        if (!txHash) throw new Error(`transfer ${status.correlation_id} succeeded with no tx_hash`);
        return { txHash };
      }
      if (status.status === "FAILED") {
        const reason = "failure_reason" in status.details ? status.details.failure_reason : null;
        throw new PaymentRefused(reason ?? status.failure_code ?? "transfer failed");
      }
      // PENDING_APPROVAL, UNCERTAIN, NEEDS_REVIEW, REFUNDED: not a refusal
      // and not settled. Per waitForStatus's doc, these need a person to
      // reconcile, never a resubmit — so this isn't PaymentRefused (that
      // would wrongly tell the recipient no money moved). It bubbles up as
      // a retry so the order waits in "paying" and the alert fires.
      throw new Error(
        `transfer ${status.correlation_id} is ${status.status}; needs reconciliation`,
      );
    },
  };
}
