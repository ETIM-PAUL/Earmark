import { describe, expect, it } from "vitest";
import {
  ConfigError,
  isConfigured,
  nearEnv,
  readEnv,
  redact,
  telegramEnv,
  vtpassEnv,
} from "./index.js";

describe("readEnv", () => {
  it("applies defaults and treats blank values as unset", () => {
    const cfg = readEnv(vtpassEnv, {
      VTPASS_BASE_URL: "",
      VTPASS_API_KEY: "k",
      VTPASS_PUBLIC_KEY: "PK_x",
      VTPASS_SECRET_KEY: "SK_x",
    });
    expect(cfg.VTPASS_BASE_URL).toBe("https://sandbox.vtpass.com/api");
  });

  it("names missing variables", () => {
    expect(() => readEnv(vtpassEnv, { VTPASS_API_KEY: "k" })).toThrow(
      /VTPASS_PUBLIC_KEY is not set/,
    );
  });

  it("never echoes a bad value", () => {
    const secret = "not-a-telegram-token-supersecret";
    try {
      readEnv(telegramEnv, { TELEGRAM_BOT_TOKEN: secret });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain("TELEGRAM_BOT_TOKEN");
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it("validates NEAR account ids", () => {
    const env = {
      SERVICE_ACCOUNT_ID: "earmark-service.near",
      SETTLEMENT_ACCOUNT_ID: "earmark-settle.near",
      PAYOUT_ACCOUNT_ID: "Not An Account",
    };
    expect(() => readEnv(nearEnv, env)).toThrow(/PAYOUT_ACCOUNT_ID must be a NEAR account id/);
  });
});

describe("isConfigured", () => {
  it("ignores variables that have defaults or are optional", () => {
    expect(
      isConfigured(nearEnv, {
        SERVICE_ACCOUNT_ID: "a.near",
        SETTLEMENT_ACCOUNT_ID: "b.near",
        PAYOUT_ACCOUNT_ID: "c.near",
      }),
    ).toBe(true);
    expect(isConfigured(vtpassEnv, { VTPASS_API_KEY: "k" })).toBe(false);
  });
});

describe("redact", () => {
  it("removes every occurrence of each secret", () => {
    expect(redact("GET /bot123:abc/getMe failed for 123:abc", ["123:abc"])).toBe(
      "GET /bot[redacted]/getMe failed for [redacted]",
    );
  });
});
