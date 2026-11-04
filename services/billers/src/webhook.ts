import { OrderId } from "@earmark/shared";

/**
 * VTpass posts `{ type, data }` to our callback URL and retries up to five
 * times until we answer `{ "response": "success" }`.
 *
 * The callback is not signed, so its body is never trusted: we take only
 * the request ID from it and requery VTpass for the real status.
 */
export const WEBHOOK_ACK = { response: "success" } as const;

export type WebhookEvent =
  | { type: "transaction-update"; requestId: OrderId }
  | { type: "ignored"; why: string };

export function parseWebhook(body: unknown): WebhookEvent {
  if (typeof body !== "object" || body === null) return { type: "ignored", why: "not an object" };
  const { type, data } = body as { type?: unknown; data?: unknown };
  if (type !== "transaction-update") return { type: "ignored", why: `type ${String(type)}` };
  const requestId = (data as { requestId?: unknown } | undefined)?.requestId;
  const parsed = OrderId.safeParse(requestId);
  if (!parsed.success) return { type: "ignored", why: "request ID is not one of our order IDs" };
  return { type: "transaction-update", requestId: parsed.data };
}
