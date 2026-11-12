import type { IncomingMessage, ServerResponse } from "node:http";
import { isPresetName, PRESET_NAMES, PRESETS } from "@earmark/shared";
import type { DemoWiring } from "./demo.js";

/**
 * The sender's side over HTTP, for the demo's judge page: the approval
 * inbox, approve and decline, freeze, and rule presets.
 *
 *   GET  /sender/state?family=fam_…
 *   POST /sender/decide  { orderId, decision: "approved" | "declined" }
 *   POST /sender/freeze  { family, frozen }
 *   POST /sender/preset  { family, preset }
 *
 * Localhost only, and the demo owner signs for the sender. In Phase 12 these
 * move behind the owner's own sign-in, and `decide` takes the signature the
 * owner's wallet made instead of making it here.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const FAMILY = /^fam_[a-z0-9]{16}$/;

export function senderRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { demo: DemoWiring; webUrl: string },
): boolean {
  const url = req.url ?? "";
  if (!url.startsWith("/sender/")) return false;
  const cors = {
    "access-control-allow-origin": ctx.webUrl,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  const send = (status: number, body?: unknown) => {
    res.writeHead(status, { ...cors, ...(body ? { "content-type": "application/json" } : {}) });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  if (req.method === "OPTIONS") {
    send(204);
    return true;
  }
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
    send(403);
    return true;
  }
  const { sender } = ctx.demo;

  const state = req.method === "GET" && url.match(/^\/sender\/state\?family=(fam_[a-z0-9]{16})$/);
  if (state) {
    const family = state[1] as string;
    Promise.all([sender.overview(family), sender.approvals(family)])
      .then(([overview, approvals]) =>
        overview
          ? send(200, {
              overview,
              approvals,
              presets: PRESET_NAMES.map((name) => ({
                name,
                label: PRESETS[name].label,
                about: PRESETS[name].about,
              })),
            })
          : send(404),
      )
      .catch(() => send(500));
    return true;
  }

  if (req.method !== "POST") {
    send(404);
    return true;
  }
  let body = "";
  req.on("data", (c: Buffer) => {
    body += c.toString("utf8").slice(0, 2_000);
  });
  req.on("end", () => {
    let b: Record<string, unknown> = {};
    try {
      b = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      return send(400);
    }
    const family = typeof b.family === "string" && FAMILY.test(b.family) ? b.family : null;
    switch (url) {
      case "/sender/decide": {
        const { orderId, decision } = b;
        if (typeof orderId !== "string" || (decision !== "approved" && decision !== "declined")) {
          return send(400);
        }
        sender
          .signAsDemoOwner(orderId, decision)
          .then((proof) =>
            proof
              ? sender.decide(orderId, decision, proof)
              : ({ ok: false, reason: "not_found" } as const),
          )
          .then((r) => send(r.ok ? 200 : 409, { ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) }))
          .catch(() => send(500));
        return;
      }
      case "/sender/freeze":
        if (!family || typeof b.frozen !== "boolean") return send(400);
        sender
          .setFrozen(family, b.frozen)
          .then((ok) => send(ok ? 200 : 404, { ok }))
          .catch(() => send(500));
        return;
      case "/sender/preset":
        if (!family || !isPresetName(b.preset)) return send(400);
        return send(sender.applyPreset(family, b.preset) ? 200 : 404, { ok: true });
      default:
        return send(404);
    }
  });
  return true;
}
