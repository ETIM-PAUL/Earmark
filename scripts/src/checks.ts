import {
  agentApiEnv,
  isConfigured,
  nearAiEnv,
  nearEnv,
  oneClickEnv,
  readEnv,
  redact,
  telegramEnv,
  twilioEnv,
  vtpassEnv,
} from "@earmark/config";

// Read-only smoke checks for every Phase 2 account and key. Nothing here
// moves money or writes state. The NEAR AI check spends one tiny completion.

export type Env = Record<string, string | undefined>;
export type CheckStatus = "ok" | "skipped" | "failed";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface Ctx {
  env: Env;
  fetch: typeof fetch;
}

const TIMEOUT_MS = 15_000;
/** Native USDC on NEAR. */
export const USDC_NEAR_CONTRACT =
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const failed = (name: string, detail: string): CheckResult => ({ name, status: "failed", detail });
const skipped = (name: string, detail: string): CheckResult => ({
  name,
  status: "skipped",
  detail,
});

async function getJson(ctx: Ctx, url: string, init: RequestInit = {}): Promise<[number, unknown]> {
  const res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  try {
    return [res.status, JSON.parse(text)];
  } catch {
    return [res.status, text.slice(0, 120)];
  }
}

/** Runs one check; any thrown error becomes a failed result with secrets removed. */
async function guarded(
  name: string,
  secrets: Array<string | undefined>,
  run: () => Promise<CheckResult | CheckResult[]>,
): Promise<CheckResult[]> {
  try {
    const r = await run();
    return Array.isArray(r) ? r : [r];
  } catch (e) {
    const msg =
      e instanceof Error ? `${e.message}${e.cause ? ` (${String(e.cause)})` : ""}` : String(e);
    return [failed(name, redact(msg, secrets))];
  }
}

function formatNear(yocto: string): string {
  const v = BigInt(yocto);
  const milli = v / 10n ** 21n;
  return `${milli / 1000n}.${String(milli % 1000n).padStart(3, "0")} NEAR`;
}

async function nearRpc(ctx: Ctx, rpcUrl: string, params: object): Promise<Record<string, unknown>> {
  const [, body] = await getJson(ctx, rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "earmark", method: "query", params }),
  });
  const b = body as { result?: Record<string, unknown>; error?: { cause?: { name?: string } } };
  if (b.error) throw new Error(b.error.cause?.name ?? "rpc error");
  if (!b.result) throw new Error("empty rpc response");
  return b.result;
}

export async function checkNear(ctx: Ctx): Promise<CheckResult[]> {
  if (!isConfigured(nearEnv, ctx.env)) {
    return [skipped("near", "set SERVICE_ACCOUNT_ID, SETTLEMENT_ACCOUNT_ID and PAYOUT_ACCOUNT_ID")];
  }
  const cfg = readEnv(nearEnv, ctx.env);
  const accounts: Array<[string, string | undefined]> = [
    ["service", cfg.SERVICE_ACCOUNT_ID],
    ["settlement", cfg.SETTLEMENT_ACCOUNT_ID],
    ["payout", cfg.PAYOUT_ACCOUNT_ID],
    ["receipts contract", cfg.RECEIPTS_CONTRACT_ID],
  ];
  const results: CheckResult[] = [];
  for (const [role, id] of accounts) {
    const name = `near: ${role}`;
    if (!id) {
      results.push(skipped(name, "not set yet (deployed in Phase 7)"));
      continue;
    }
    results.push(
      ...(await guarded(name, [], async () => {
        try {
          const acct = await nearRpc(ctx, cfg.NEAR_RPC_URL, {
            request_type: "view_account",
            finality: "final",
            account_id: id,
          });
          let detail = `${id}: ${formatNear(String(acct.amount))}`;
          if (role === "settlement") {
            const usdc = await nearRpc(ctx, cfg.NEAR_RPC_URL, {
              request_type: "call_function",
              finality: "final",
              account_id: USDC_NEAR_CONTRACT,
              method_name: "ft_balance_of",
              args_base64: Buffer.from(JSON.stringify({ account_id: id })).toString("base64"),
            });
            const raw = JSON.parse(Buffer.from(usdc.result as number[]).toString()) as string;
            detail += `, ${(Number(raw) / 1e6).toFixed(2)} USDC`;
          }
          return ok(name, detail);
        } catch (e) {
          if (e instanceof Error && e.message === "UNKNOWN_ACCOUNT") {
            return failed(name, `${id} does not exist on mainnet`);
          }
          throw e;
        }
      })),
    );
  }
  return results;
}

export async function checkAgentApi(ctx: Ctx): Promise<CheckResult[]> {
  const name = "agent api";
  const baseUrl = ctx.env.NEAR_INTENTS_AGENT_API_URL || "https://api.agentsonintents.com";
  return guarded(name, [ctx.env.NEAR_INTENTS_AGENT_API_KEY], async () => {
    const [, net] = await getJson(ctx, `${baseUrl}/v1/network`);
    const n = net as {
      network?: string;
      status?: { overall?: string };
      supported_owner_types?: string[];
    };
    const service = `${n.network} ${n.status?.overall}, owners: ${n.supported_owner_types?.join("/")}`;
    if (!isConfigured(agentApiEnv, ctx.env)) {
      return skipped(name, `service ${service}; set NEAR_INTENTS_AGENT_API_KEY`);
    }
    const cfg = readEnv(agentApiEnv, ctx.env);
    const [status, me] = await getJson(ctx, `${cfg.NEAR_INTENTS_AGENT_API_URL}/v1/whoami`, {
      headers: { "x-api-key": cfg.NEAR_INTENTS_AGENT_API_KEY },
    });
    if (status !== 200) return failed(name, `whoami returned HTTP ${status}; service ${service}`);
    return ok(
      name,
      `key valid, tenant ${(me as { tenant_id: string }).tenant_id}; service ${service}`,
    );
  });
}

export async function checkOneClick(ctx: Ctx): Promise<CheckResult[]> {
  const name = "1click";
  const cfg = readEnv(oneClickEnv, ctx.env);
  return guarded(name, [cfg.ONECLICK_JWT], async () => {
    const [status, body] = await getJson(ctx, `${cfg.ONECLICK_API_URL}/v0/tokens`);
    if (status !== 200 || !Array.isArray(body))
      return failed(name, `tokens returned HTTP ${status}`);
    const usdc = new Set(
      (body as Array<{ symbol: string; blockchain: string }>)
        .filter((t) => t.symbol === "USDC")
        .map((t) => t.blockchain),
    );
    const missing = ["base", "sol", "eth", "near"].filter((c) => !usdc.has(c));
    if (missing.length) return failed(name, `USDC missing on: ${missing.join(", ")}`);
    const jwt = cfg.ONECLICK_JWT ? "partner JWT set" : "no partner JWT (0.2% fee applies)";
    return ok(name, `USDC routable from base, sol, eth to near; ${jwt}`);
  });
}

export async function checkNearAi(ctx: Ctx): Promise<CheckResult[]> {
  const name = "near ai cloud";
  if (!isConfigured(nearAiEnv, ctx.env)) return [skipped(name, "set NEAR_AI_API_KEY")];
  const cfg = readEnv(nearAiEnv, ctx.env);
  return guarded(name, [cfg.NEAR_AI_API_KEY], async () => {
    const [, models] = await getJson(ctx, `${cfg.NEAR_AI_BASE_URL}/models`);
    const ids = ((models as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id);
    if (!ids.includes(cfg.NEAR_AI_MODEL)) {
      return failed(name, `model ${cfg.NEAR_AI_MODEL} not offered (${ids.length} models listed)`);
    }
    const [status, body] = await getJson(ctx, `${cfg.NEAR_AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.NEAR_AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: cfg.NEAR_AI_MODEL,
        messages: [{ role: "user", content: "Reply with: ok" }],
        max_tokens: 5,
      }),
    });
    if (status !== 200) return failed(name, `chat completion returned HTTP ${status}`);
    const reply = (body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]
      ?.message?.content;
    return ok(name, `key valid, ${cfg.NEAR_AI_MODEL} replied "${reply?.trim() ?? ""}"`);
  });
}

export async function checkVtpass(ctx: Ctx): Promise<CheckResult[]> {
  const name = "vtpass";
  if (!isConfigured(vtpassEnv, ctx.env)) {
    return [skipped(name, "set VTPASS_API_KEY, VTPASS_PUBLIC_KEY and VTPASS_SECRET_KEY")];
  }
  const cfg = readEnv(vtpassEnv, ctx.env);
  const mode = cfg.VTPASS_BASE_URL.includes("sandbox") ? "sandbox" : "LIVE";
  return guarded(
    name,
    [cfg.VTPASS_API_KEY, cfg.VTPASS_PUBLIC_KEY, cfg.VTPASS_SECRET_KEY],
    async () => {
      const [status, body] = await getJson(ctx, `${cfg.VTPASS_BASE_URL}/balance`, {
        headers: { "api-key": cfg.VTPASS_API_KEY, "public-key": cfg.VTPASS_PUBLIC_KEY },
      });
      const b = body as { code?: number; contents?: { balance?: number } };
      if (b.code !== 1) {
        return failed(
          name,
          `${mode} balance check refused (HTTP ${status}): ${JSON.stringify(body)}`,
        );
      }
      const naira = `₦${(b.contents?.balance ?? 0).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
      return ok(name, `${mode} keys valid, wallet balance ${naira}`);
    },
  );
}

export async function checkTelegram(ctx: Ctx): Promise<CheckResult[]> {
  const name = "telegram";
  if (!isConfigured(telegramEnv, ctx.env)) return [skipped(name, "set TELEGRAM_BOT_TOKEN")];
  const cfg = readEnv(telegramEnv, ctx.env);
  return guarded(name, [cfg.TELEGRAM_BOT_TOKEN], async () => {
    const [, body] = await getJson(
      ctx,
      `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/getMe`,
    );
    const b = body as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!b.ok) return failed(name, `getMe refused: ${b.description ?? "unknown error"}`);
    return ok(name, `bot @${b.result?.username}`);
  });
}

export async function checkTwilio(ctx: Ctx): Promise<CheckResult[]> {
  const name = "twilio whatsapp";
  if (!isConfigured(twilioEnv, ctx.env)) {
    return [skipped(name, "set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM")];
  }
  const cfg = readEnv(twilioEnv, ctx.env);
  return guarded(name, [cfg.TWILIO_AUTH_TOKEN], async () => {
    const auth = Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString(
      "base64",
    );
    const [status, body] = await getJson(
      ctx,
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}.json`,
      { headers: { authorization: `Basic ${auth}` } },
    );
    if (status !== 200) return failed(name, `account lookup returned HTTP ${status}`);
    const b = body as { status?: string; type?: string };
    return ok(name, `account ${b.status} (${b.type}), sending from ${cfg.TWILIO_WHATSAPP_FROM}`);
  });
}

export const ALL_CHECKS = [
  checkNear,
  checkAgentApi,
  checkOneClick,
  checkNearAi,
  checkVtpass,
  checkTelegram,
  checkTwilio,
];

export async function runAll(ctx: Ctx): Promise<CheckResult[]> {
  const groups = await Promise.all(ALL_CHECKS.map((c) => c(ctx)));
  return groups.flat();
}
