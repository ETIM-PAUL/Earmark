import type { IncomingMessage, ServerResponse } from "node:http";
import { isPresetName, PRESET_NAMES, PRESETS, type SoftRulesChange } from "@earmark/shared";
import { z } from "zod";
import { MAX_MEMBERS, type SenderAccount, type SenderAccounts } from "./accounts.js";
import type { Bot } from "./app.js";
import type { DemoWiring } from "./demo.js";
import { RateLimiter } from "./limits.js";
import type { Passkeys } from "./passkeys.js";
import { normalizeAccount, normalizePhone, resolveBiller } from "./providers.js";
import {
  describeRules,
  type FamilyTeam,
  type Proposal,
  type ProposalKind,
  proposalMessage,
  summaries,
} from "./team.js";

/**
 * The sender app's API. Everything past sign-in needs a session from a
 * passkey login, and every family route checks that the signed-in account
 * owns the family.
 *
 *   GET  /api/config
 *   POST /api/auth/register/options | register/verify | login/options | login/verify | logout
 *   GET  /api/me
 *   POST /api/families                         create a family and its invite
 *   GET  /api/families/:id/state               overview, waiting approvals, recent orders
 *   POST /api/families/:id/invite              a fresh invite link
 *   POST /api/families/:id/freeze | preset | rules
 *   POST /api/families/:id/members/invite      a join code for a relative (creator only)
 *   POST /api/join                             redeem a join code
 *   POST /api/families/:id/policy              how many relatives must sign
 *   POST /api/families/:id/proposals/:pid/options | sign | cancel
 *   POST /api/decisions/options | decisions    approve or decline, signed by the passkey
 *
 * Any relative in the family can use the family routes. With more than one
 * relative and "required" above 1, a rule change, an unfreeze and an
 * approval each wait for that many passkey signatures. Declining a payment
 * and freezing take effect at once.
 */

export interface ApiContext {
  demo: DemoWiring;
  bot: Bot;
  accounts: SenderAccounts;
  passkeys: Passkeys;
  team: FamilyTeam;
  webUrl: string;
  config: { network: "testnet" | "mainnet"; contractId: string | null; rpcUrl: string | null };
  /** Called after a family is made, e.g. to open its web chat in the keyless demo. */
  afterFamilyCreated?: (familyId: string) => Promise<void>;
  /** Limits sign-up and sign-in attempts per address. */
  limiter?: RateLimiter;
}

const NAME = /^[\p{L}][\p{L} .'-]{0,39}$/u;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,29}$/u;

const NewFamilyIn = z.object({
  recipientPhone: z.string().max(20),
  meters: z
    .array(
      z.object({
        disco: z.string().min(1).max(40),
        ref: z.string().min(1).max(20),
        label: z.string().regex(LABEL),
        meterType: z.enum(["prepaid", "postpaid"]).optional(),
      }),
    )
    .max(5)
    .default([]),
  smartcards: z
    .array(
      z.object({
        tv: z.string().min(1).max(40),
        ref: z.string().min(1).max(20),
        label: z.string().regex(LABEL),
      }),
    )
    .max(3)
    .default([]),
  preset: z.enum(PRESET_NAMES).default("essentials"),
});

const naira = z.number().int().min(0).max(10_000_000);
const RulesIn = z.object({
  approvalAboveNaira: naira.nullable().optional(),
  categories: z
    .object({
      electricity: z.object({ enabled: z.boolean(), capNaira: naira.nullable() }).partial(),
      airtime: z.object({ enabled: z.boolean(), capNaira: naira.nullable() }).partial(),
      data: z.object({ enabled: z.boolean(), capNaira: naira.nullable() }).partial(),
      tv: z.object({ enabled: z.boolean(), capNaira: naira.nullable() }).partial(),
    })
    .partial()
    .optional(),
});

class Bad extends Error {}

async function readJson(req: IncomingMessage, max = 16_000): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += (chunk as Buffer).toString("utf8");
    if (body.length > max) throw new Bad("request too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Bad("not JSON");
  }
}

export function apiRoute(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): boolean {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (!path.startsWith("/api/")) return false;
  const cors = {
    "access-control-allow-origin": ctx.webUrl,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "origin",
  };
  const send = (status: number, body?: unknown) => {
    res.writeHead(status, {
      ...cors,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  if (req.method === "OPTIONS") {
    send(204);
    return true;
  }
  handle(req, path, send, ctx).catch((e) => {
    if (e instanceof Bad || e instanceof z.ZodError) {
      return send(400, {
        error: e instanceof Bad ? e.message : "Please check the details and try again.",
      });
    }
    console.error(`api ${req.method} ${path}: ${String(e)}`);
    send(500, { error: "Something went wrong on our side." });
  });
  return true;
}

async function handle(
  req: IncomingMessage,
  path: string,
  send: (status: number, body?: unknown) => void,
  ctx: ApiContext,
): Promise<void> {
  const { demo, accounts, passkeys } = ctx;
  const get = req.method === "GET";
  const post = req.method === "POST";
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  const me = (): SenderAccount | null => accounts.sessionAccount(token);
  const signedIn = (): SenderAccount => {
    const a = me();
    if (!a) throw Object.assign(new Error("sign in"), { status: 401 });
    return a;
  };

  try {
    // ── Public ────────────────────────────────────────────────────────
    if (get && path === "/api/config") {
      return send(200, {
        network: ctx.config.network,
        contractId: ctx.config.contractId,
        rpcUrl: ctx.config.rpcUrl,
        presets: PRESET_NAMES.map((name) => ({
          name,
          label: PRESETS[name].label,
          about: PRESETS[name].about,
        })),
        topUp: {
          enabled: false,
          why: "Top-ups use the NEAR Intents 1Click API and need the mainnet accounts, which aren't set up in this build.",
        },
      });
    }

    if (post && path.startsWith("/api/auth/")) {
      const ip = req.socket.remoteAddress ?? "?";
      if ((ctx.limiter ?? defaultLimiter).admit(ip) !== "ok") {
        return send(429, { error: "Too many attempts. Please wait a minute." });
      }
      const body = (await readJson(req, 64_000)) as Record<string, unknown>;
      const challengeId = typeof body.challengeId === "string" ? body.challengeId : "";
      switch (path) {
        case "/api/auth/register/options": {
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!NAME.test(name)) return send(400, { error: "Please enter your name." });
          return send(200, await passkeys.registerOptions(name));
        }
        case "/api/auth/register/verify": {
          const r = await passkeys.registerVerify(challengeId, body.response as never);
          if (!r) return send(401, { error: "We couldn't set up that passkey. Please try again." });
          return send(200, session(accounts, r.accountId));
        }
        case "/api/auth/login/options":
          return send(200, await passkeys.loginOptions());
        case "/api/auth/login/verify": {
          const r = await passkeys.loginVerify(challengeId, body.response as never);
          if (!r) return send(401, { error: "That passkey didn't work. Please try again." });
          return send(200, session(accounts, r.accountId));
        }
        case "/api/auth/logout":
          if (token) accounts.endSession(token);
          return send(200, { ok: true });
        default:
          return send(404);
      }
    }

    // ── Signed in ─────────────────────────────────────────────────────
    const account = signedIn();

    if (get && path === "/api/me") return send(200, view(account));

    if (post && path === "/api/families") {
      const input = NewFamilyIn.parse(await readJson(req));
      const phone = normalizePhone(input.recipientPhone);
      if (!phone) return send(400, { error: "That doesn't look like a Nigerian phone number." });
      const saved = [];
      for (const m of input.meters) {
        const billerCode = resolveBiller("electricity", m.disco);
        const ref = normalizeAccount("electricity", m.ref);
        if (!billerCode)
          return send(400, { error: `We don't know the electricity company "${m.disco}".` });
        if (!ref) return send(400, { error: `"${m.ref}" isn't a meter number (11 to 13 digits).` });
        saved.push({
          category: "electricity" as const,
          billerCode,
          ref,
          label: m.label,
          meterType: m.meterType ?? ("prepaid" as const),
        });
      }
      for (const c of input.smartcards) {
        const billerCode = resolveBiller("tv", c.tv);
        const ref = normalizeAccount("tv", c.ref);
        if (!billerCode) return send(400, { error: `We don't know the TV company "${c.tv}".` });
        if (!ref)
          return send(400, { error: `"${c.ref}" isn't a smartcard number (10 or 11 digits).` });
        saved.push({ category: "tv" as const, billerCode, ref, label: c.label });
      }
      const family = demo.createFamily({
        senderName: account.name.split(" ")[0] ?? account.name,
        recipientPhone: phone,
        saved,
        preset: input.preset,
      });
      accounts.linkFamily(account.id, family.familyId);
      await ctx.afterFamilyCreated?.(family.familyId);
      return send(201, { familyId: family.familyId, invite: invite(ctx, family.familyId) });
    }

    if (post && path === "/api/join") {
      const ip = req.socket.remoteAddress ?? "?";
      if ((ctx.limiter ?? defaultLimiter).admit(ip) !== "ok") {
        return send(429, { error: "Too many attempts. Please wait a minute." });
      }
      const b = (await readJson(req)) as { code?: unknown };
      const r = ctx.team.redeem(typeof b.code === "string" ? b.code : "", account.id);
      if (r === "bad_code") {
        return send(400, { error: "That code didn't work. It may have expired or been used." });
      }
      if (r === "full") return send(400, { error: "That family already has the most relatives." });
      return send(200, { familyId: r.familyId });
    }

    const fam = path.match(/^\/api\/families\/(fam_[a-z0-9]{16})\/([a-z0-9_/]+)$/);
    if (fam) {
      const familyId = fam[1] as string;
      const route = fam[2] as string;
      // A family you're not in looks the same as one that doesn't exist.
      if (!accounts.isMember(account.id, familyId)) return send(404);
      const { sender } = demo;
      const { team } = ctx;
      const isOwner = accounts.ownsFamily(account.id, familyId);
      const creatorOnly = () =>
        send(403, { error: "Only the person who set up this family can do that." });
      const nameOf = (id: string) =>
        (accounts.get(id)?.name ?? "A relative").split(" ")[0] ?? "A relative";

      /** Run a change now, or, when relatives must co-sign, put it up for their signatures. */
      const change = async (kind: ProposalKind, payload: unknown, summary: string) => {
        if (team.required(familyId) <= 1) {
          await applyChange(ctx, familyId, kind, payload);
          return send(200, { ok: true });
        }
        const p = team.propose(familyId, kind, payload, summary, account.id);
        if (p === "too_many") {
          return send(400, { error: "Too many changes are waiting. Sign or cancel some first." });
        }
        return send(202, {
          ok: true,
          waiting: true,
          proposalId: p.id,
          needed: team.required(familyId),
        });
      };

      if (get && route === "state") {
        const [overview, approvals, orders] = await Promise.all([
          sender.overview(familyId),
          sender.approvals(familyId),
          sender.orders(familyId, 30),
        ]);
        const needed = team.required(familyId);
        return send(200, {
          overview,
          approvals: approvals.map((c) => {
            const signers = team.signersOfOrder(c.orderId);
            return {
              ...c,
              needed,
              signedBy: signers.map(nameOf),
              youSigned: signers.includes(account.id),
            };
          }),
          orders,
          team: {
            members: accounts.membersOf(familyId).map((m) => ({
              id: m.id,
              name: m.name,
              isOwner: accounts.ownsFamily(m.id, familyId),
              you: m.id === account.id,
            })),
            required: needed,
            isOwner,
            maxMembers: MAX_MEMBERS,
          },
          proposals: team
            .proposals(familyId)
            .map((p) => proposalView(p, account.id, needed, nameOf)),
        });
      }
      if (!post) return send(404);

      switch (route) {
        case "invite":
          return isOwner ? send(200, invite(ctx, familyId)) : creatorOnly();
        case "members/invite":
          return isOwner ? send(200, team.newJoinCode(familyId)) : creatorOnly();
        case "freeze": {
          const b = (await readJson(req)) as { frozen?: unknown };
          if (typeof b.frozen !== "boolean") {
            return send(400, { error: "frozen must be true or false" });
          }
          // Stopping money is always safe, so any relative can freeze at once.
          if (b.frozen) {
            await sender.setFrozen(familyId, true);
            return send(200, { ok: true });
          }
          return change("unfreeze", null, summaries.unfreeze());
        }
        case "preset": {
          const b = (await readJson(req)) as { preset?: unknown };
          if (!isPresetName(b.preset)) return send(400, { error: "unknown preset" });
          return change("preset", b.preset, summaries.preset(b.preset));
        }
        case "rules": {
          const b = RulesIn.parse(await readJson(req));
          const rules: SoftRulesChange = {};
          if (b.approvalAboveNaira !== undefined) {
            rules.approvalAboveNgnKobo =
              b.approvalAboveNaira === null ? null : b.approvalAboveNaira * 100;
          }
          if (b.categories) {
            rules.categories = {};
            for (const [c, r] of Object.entries(b.categories)) {
              if (!r) continue;
              rules.categories[c as "electricity"] = {
                ...(r.enabled !== undefined ? { enabled: r.enabled } : {}),
                ...(r.capNaira !== undefined
                  ? { monthlyCapNgnKobo: r.capNaira === null ? null : r.capNaira * 100 }
                  : {}),
              };
            }
          }
          return change("rules", rules, describeRules(rules));
        }
        case "policy": {
          const b = (await readJson(req)) as { required?: unknown };
          const n = b.required;
          if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
            return send(400, { error: "required must be a whole number, 1 or more" });
          }
          if (n > accounts.membersOf(familyId).length) {
            return send(400, {
              error: "You can't ask for more signatures than there are relatives.",
            });
          }
          return change("policy", n, summaries.policy(n));
        }
      }

      const prop = route.match(/^proposals\/(prop_[a-f0-9]{16})\/(options|sign|cancel)$/);
      if (prop) {
        const p = team.proposal(familyId, prop[1] as string);
        if (!p) return send(409, { ok: false, reason: "not_pending" });
        const message = proposalMessage(p);
        switch (prop[2]) {
          case "cancel":
            // Anyone in the family can turn a change down.
            team.drop(p.id);
            return send(200, { ok: true });
          case "options":
            return send(200, await passkeys.messageOptions(account.id, message));
          case "sign": {
            const b = (await readJson(req, 64_000)) as { response?: unknown };
            const signer = await passkeys.signerOf(
              familyId,
              message,
              JSON.stringify(b.response ?? null),
            );
            // It must be this relative's own passkey, not another's replayed.
            if (signer !== account.id) return send(409, { ok: false, reason: "bad_proof" });
            const needed = team.required(familyId);
            const signed = team.sign(p, account.id);
            if (signed < needed) return send(200, { ok: true, applied: false, signed, needed });
            team.drop(p.id);
            await applyChange(ctx, familyId, p.kind, p.payload);
            return send(200, { ok: true, applied: true, signed, needed });
          }
        }
      }
    }

    if (post && (path === "/api/decisions/options" || path === "/api/decisions")) {
      const b = (await readJson(req, 64_000)) as Record<string, unknown>;
      const { orderId, decision } = b;
      if (typeof orderId !== "string" || (decision !== "approved" && decision !== "declined")) {
        return send(400, { error: "orderId and decision are needed" });
      }
      const order = await demo.sender.pendingOrder(orderId);
      if (!order || !accounts.isMember(account.id, order.familyId)) {
        return send(409, { ok: false, reason: "not_pending" });
      }
      if (path === "/api/decisions/options") {
        return send(200, await passkeys.decisionOptions(account.id, order, decision));
      }
      const proof = JSON.stringify(b.response ?? null);
      const needed = ctx.team.required(order.familyId);
      // One relative's "no" stops a payment. A "yes" needs `needed` of them.
      if (decision === "declined" || needed <= 1) {
        const r = await demo.sender.decide(orderId, decision, proof);
        return send(r.ok ? 200 : 409, {
          ok: r.ok,
          ...(r.ok ? { status: r.order.status } : { reason: r.reason }),
        });
      }
      const signer = await passkeys.signerOfDecision(order, "approved", proof);
      if (signer !== account.id) return send(409, { ok: false, reason: "bad_proof" });
      if (ctx.team.signersOfOrder(orderId).includes(signer)) {
        return send(409, { ok: false, reason: "already_signed" });
      }
      const signed = ctx.team.addOrderSigner(orderId, signer);
      if (signed < needed) {
        return send(200, { ok: true, status: "awaiting_approval", signed, needed });
      }
      // Enough relatives have signed with their own passkeys. The service now
      // records the decision with its own proof, since each passkey assertion
      // can be checked only once.
      const ownProof = await demo.sender.signAsDemoOwner(orderId, "approved");
      const r = ownProof
        ? await demo.sender.decide(orderId, "approved", ownProof)
        : ({ ok: false, reason: "not_pending" } as const);
      ctx.team.forgetOrder(orderId);
      return send(r.ok ? 200 : 409, {
        ok: r.ok,
        ...(r.ok ? { status: r.order.status } : { reason: r.reason }),
      });
    }

    return send(404);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401) return send(401, { error: "Please sign in." });
    throw e;
  }
}

const defaultLimiter = new RateLimiter({ burst: 20, refillMs: 6_000 });

const view = (a: SenderAccount) => ({ id: a.id, name: a.name, familyIds: a.familyIds });

function session(accounts: SenderAccounts, accountId: string) {
  const a = accounts.get(accountId) as SenderAccount;
  return { token: accounts.newSession(accountId), account: view(a) };
}

function invite(ctx: ApiContext, familyId: string) {
  const { code: _code, ...rest } = ctx.bot.inviteFor(familyId);
  return rest;
}

/** Do a change that has the signatures it needs. */
async function applyChange(
  ctx: ApiContext,
  familyId: string,
  kind: ProposalKind,
  payload: unknown,
): Promise<void> {
  const { sender } = ctx.demo;
  switch (kind) {
    case "preset":
      if (isPresetName(payload)) sender.applyPreset(familyId, payload);
      return;
    case "rules":
      sender.updateRules(familyId, payload as SoftRulesChange);
      return;
    case "unfreeze":
      await sender.setFrozen(familyId, false);
      return;
    case "policy":
      ctx.team.setRequired(familyId, payload as number);
      return;
  }
}

function proposalView(p: Proposal, me: string, needed: number, nameOf: (id: string) => string) {
  return {
    id: p.id,
    summary: p.summary,
    proposedBy: nameOf(p.proposedBy),
    signedBy: p.signers.map(nameOf),
    youSigned: p.signers.includes(me),
    needed,
    expiresAt: new Date(p.expiresAt).toISOString(),
  };
}
