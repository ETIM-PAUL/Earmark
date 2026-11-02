import { describe, expect, it } from "vitest";
import { type Ctx, checkNear, checkTelegram, checkVtpass, runAll } from "./checks.js";

type Route = (url: string, init?: RequestInit) => unknown;

function fakeFetch(route: Route): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = route(String(input), init);
    if (body instanceof Error) throw body;
    return new Response(typeof body === "string" ? body : JSON.stringify(body));
  }) as typeof fetch;
}

const TOKEN = "123456:SECRET-token_value";

describe("checks", () => {
  it("skips providers with no keys and never fails for it", async () => {
    const ctx: Ctx = {
      env: {},
      fetch: fakeFetch((url) =>
        url.endsWith("/v0/tokens")
          ? ["base", "sol", "eth", "near"].map((b) => ({ symbol: "USDC", blockchain: b }))
          : { network: "mainnet", status: { overall: "operational" }, supported_owner_types: [] },
      ),
    };
    const results = await runAll(ctx);
    expect(results.filter((r) => r.status === "failed")).toEqual([]);
    expect(results.find((r) => r.name === "vtpass")?.status).toBe("skipped");
  });

  it("reads the VTpass balance with GET auth headers", async () => {
    let headers: RequestInit["headers"];
    const ctx: Ctx = {
      env: { VTPASS_API_KEY: "k", VTPASS_PUBLIC_KEY: "PK_1", VTPASS_SECRET_KEY: "SK_1" },
      fetch: fakeFetch((url, init) => {
        expect(url).toBe("https://sandbox.vtpass.com/api/balance");
        headers = init?.headers;
        return { code: 1, contents: { balance: 50000 } };
      }),
    };
    const [r] = await checkVtpass(ctx);
    expect(r?.status).toBe("ok");
    expect(r?.detail).toContain("sandbox");
    expect(headers).toEqual({ "api-key": "k", "public-key": "PK_1" });
  });

  it("reports VTpass credential refusals", async () => {
    const ctx: Ctx = {
      env: { VTPASS_API_KEY: "k", VTPASS_PUBLIC_KEY: "PK_1", VTPASS_SECRET_KEY: "SK_1" },
      fetch: fakeFetch(() => "Invalid Credentials."),
    };
    const [r] = await checkVtpass(ctx);
    expect(r?.status).toBe("failed");
  });

  it("removes the Telegram token from network errors", async () => {
    const ctx: Ctx = {
      env: { TELEGRAM_BOT_TOKEN: TOKEN },
      fetch: fakeFetch((url) => new Error(`request to ${url} failed`)),
    };
    const [r] = await checkTelegram(ctx);
    expect(r?.status).toBe("failed");
    expect(r?.detail).not.toContain(TOKEN);
    expect(r?.detail).toContain("[redacted]");
  });

  it("flags NEAR accounts that do not exist and shows settlement USDC", async () => {
    const ctx: Ctx = {
      env: {
        SERVICE_ACCOUNT_ID: "earmark-service.near",
        SETTLEMENT_ACCOUNT_ID: "earmark-settle.near",
        PAYOUT_ACCOUNT_ID: "earmark-payout.near",
      },
      fetch: fakeFetch((_url, init) => {
        const { params } = JSON.parse(String(init?.body));
        if (params.account_id === "earmark-payout.near") {
          return { error: { cause: { name: "UNKNOWN_ACCOUNT" } } };
        }
        if (params.request_type === "call_function") {
          return { result: { result: [...Buffer.from(JSON.stringify("2500000"))] } };
        }
        return { result: { amount: "1500000000000000000000000" } };
      }),
    };
    const results = await checkNear(ctx);
    const by = (n: string) => results.find((r) => r.name === `near: ${n}`);
    expect(by("service")?.detail).toBe("earmark-service.near: 1.500 NEAR");
    expect(by("settlement")?.detail).toBe("earmark-settle.near: 1.500 NEAR, 2.50 USDC");
    expect(by("payout")?.status).toBe("failed");
    expect(by("receipts contract")?.status).toBe("skipped");
  });
});
