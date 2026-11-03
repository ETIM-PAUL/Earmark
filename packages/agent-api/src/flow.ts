import { setTimeout as sleep } from "node:timers/promises";
import type { AgentApi, StatusResponse } from "@near-intents-agent-api/sdk";

type GenerateRequest = Parameters<AgentApi["generateIntent"]>[0];
type Generated = Awaited<ReturnType<AgentApi["generateIntent"]>>;

const MOVING = new Set<StatusResponse["status"]>(["QUEUED", "PROCESSING"]);

/**
 * Poll until an operation stops moving. Returns on terminal statuses and on
 * the ones a person or the chain must unblock (PENDING_*), and on
 * UNCERTAIN / NEEDS_REVIEW, which need reconciliation, never a resubmit.
 */
export async function waitForStatus(
  api: AgentApi,
  correlationId: string,
  signal: AbortSignal = AbortSignal.timeout(180_000),
): Promise<StatusResponse> {
  while (true) {
    signal.throwIfAborted();
    const status = await api.getStatus(correlationId, { waitMs: 30_000, signal });
    if (!MOVING.has(status.status)) return status;
  }
}

/**
 * generate → persist → owner signs → submit → poll. `save` runs before the
 * owner is asked, so a crash can resume with the same correlation id.
 */
export async function runOwnerIntent(
  api: AgentApi,
  request: GenerateRequest,
  sign: (generated: Generated) => Promise<unknown>,
  opts: { idempotencyKey: string; save?: (generated: Generated) => Promise<void> },
): Promise<StatusResponse> {
  const generated = await api.generateIntent(request, { idempotencyKey: opts.idempotencyKey });
  await opts.save?.(generated);
  const signedData = await sign(generated);
  await api.submitIntent({
    type: generated.type,
    correlation_id: generated.correlation_id,
    signed_data: signedData as never,
  });
  return waitForStatus(api, generated.correlation_id);
}

/** Follow an execution after an approve vote until it leaves PENDING_APPROVAL and settles. */
export async function settleApproved(
  api: AgentApi,
  correlationId: string,
  signal: AbortSignal = AbortSignal.timeout(300_000),
): Promise<StatusResponse> {
  while (true) {
    const status = await waitForStatus(api, correlationId, signal);
    if (status.status !== "PENDING_APPROVAL") return status;
    await sleep(2_000, undefined, { signal });
  }
}

/**
 * A signed policy is only in force once it is APPLIED and synced to the
 * custody provider; until then executions fail with policy_not_ready.
 */
export async function waitForPolicyApplied(
  api: AgentApi,
  agentId: string,
  signal: AbortSignal = AbortSignal.timeout(300_000),
) {
  while (true) {
    const view = await api.getPolicy(agentId, { signal });
    if (view.status === "APPLIED" && view.provider_policy_synced) return view;
    if (view.status === "FAILED") throw new Error("policy failed to apply");
    await sleep(3_000, undefined, { signal });
  }
}

/** Wait out a cooldown timestamp (policy edits and unfreezes are 10 minutes apart). */
export async function waitUntil(iso: string | null, onWait?: (ms: number) => void): Promise<void> {
  if (!iso) return;
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return;
  onWait?.(ms);
  await sleep(ms + 1_000);
}
