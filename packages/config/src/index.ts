import { z } from "zod";

// Every external credential Earmark uses, grouped by provider. Services read
// only the groups they need, so a missing Telegram token never stops the
// biller service from starting. Real values live in the secrets manager and
// a local, gitignored .env; never in the repo.

const accountId = z
  .string()
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "must be a NEAR account id");

export const nearEnv = z.object({
  NEAR_NETWORK: z.literal("mainnet").default("mainnet"),
  NEAR_RPC_URL: z.url().default("https://rpc.mainnet.fastnear.com"),
  /** Writes receipts and drives settlement. */
  SERVICE_ACCOUNT_ID: accountId,
  /** The only destination family accounts may pay. */
  SETTLEMENT_ACCOUNT_ID: accountId,
  /** Receives prizes. Never holds operating funds. */
  PAYOUT_ACCOUNT_ID: accountId,
  /** Not deployed until Phase 7. */
  RECEIPTS_CONTRACT_ID: accountId.optional(),
});

export const agentApiEnv = z.object({
  NEAR_INTENTS_AGENT_API_KEY: z.string().startsWith("naa_", "must start with naa_"),
  NEAR_INTENTS_AGENT_API_URL: z.url().default("https://api.agentsonintents.com"),
});

export const oneClickEnv = z.object({
  ONECLICK_API_URL: z.url().default("https://1click.chaindefuser.com"),
  /** Optional partner JWT. Without it a 0.2% fee applies. */
  ONECLICK_JWT: z.string().optional(),
});

export const nearAiEnv = z.object({
  NEAR_AI_API_KEY: z.string().min(1),
  NEAR_AI_BASE_URL: z.url().default("https://cloud-api.near.ai/v1"),
  NEAR_AI_MODEL: z.string().min(1).default("deepseek/deepseek-v4.1-flash"),
});

export const vtpassEnv = z.object({
  /** Sandbox until live access is granted, then https://vtpass.com/api. */
  VTPASS_BASE_URL: z.url().default("https://sandbox.vtpass.com/api"),
  VTPASS_API_KEY: z.string().min(1),
  /** GET requests authenticate with api-key + public-key. */
  VTPASS_PUBLIC_KEY: z.string().min(1),
  /** POST requests authenticate with api-key + secret-key. */
  VTPASS_SECRET_KEY: z.string().min(1),
});

export const telegramEnv = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]+$/, "must look like 123456:ABC-..."),
});

export const twilioEnv = z.object({
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC", "must start with AC"),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  /** The Twilio WhatsApp sandbox number until business verification lands. */
  TWILIO_WHATSAPP_FROM: z.string().startsWith("whatsapp:+", "must look like whatsapp:+14155238886"),
});

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid config:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

/** Blank lines copied from .env.example count as unset. */
function withoutBlanks(env: Env): Env {
  return Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
}

/**
 * Parse one provider group. Errors name the variable and the rule it broke,
 * never its value, so they are safe to log.
 */
export function readEnv<S extends z.ZodObject>(schema: S, env: Env = process.env): z.infer<S> {
  const res = schema.safeParse(withoutBlanks(env), { reportInput: false });
  if (res.success) return res.data;
  throw new ConfigError(
    res.error.issues.map((i) => {
      const key = i.path.join(".");
      return i.code === "invalid_type" ? `${key} is not set` : `${key} ${i.message}`;
    }),
  );
}

/** True when every required variable in the group is set (it may still be invalid). */
export function isConfigured(schema: z.ZodObject, env: Env = process.env): boolean {
  const present = withoutBlanks(env);
  return Object.entries(schema.shape).every(
    ([key, field]) => key in present || (field as z.ZodType).safeParse(undefined).success,
  );
}

/** Replace every secret value in a message, for errors that may echo a URL or header. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}
