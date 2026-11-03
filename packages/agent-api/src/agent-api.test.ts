import type { GenerateIntentResponse } from "@near-intents-agent-api/sdk";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import {
  describeRefusal,
  familyPolicy,
  findUsdc,
  loadDevOwner,
  MAX_PAYMENTS_PER_HOUR,
  signAsNearOwner,
} from "./index.js";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const hard = {
  settlementAccountId: "earmark-settle.near",
  monthlyBudgetUsd: "100",
  perTransactionMaxUsdcAtomic: "50000000",
};

describe("familyPolicy", () => {
  it("allows only USDC transfers to settlement, within the signed limits", () => {
    const p = familyPolicy(hard, USDC);
    expect(p.actions).toEqual(["transfer"]);
    expect(p.assets).toEqual([USDC]);
    expect(p.destinations).toEqual({
      mode: "only",
      list: [{ action: "transfer", address: "earmark-settle.near", confidential: false }],
    });
    expect(p.limits.per_transaction).toEqual({ [USDC]: "50000000" });
    expect(p.budget.monthly_usd).toBe("100");
    expect(p.max_actions_per_hour).toBe(MAX_PAYMENTS_PER_HOUR);
    expect(p.owner_approval).toBe(false);
    expect(p.frozen).toBe(false);
    expect(p.timelock_ms).toBe(0);
  });
});

describe("findUsdc", () => {
  const tokens = [
    { assetId: "nep141:wrap.near", symbol: "wNEAR", blockchain: "near", decimals: 24 },
    { assetId: USDC, symbol: "USDC", blockchain: "near", decimals: 6 },
    {
      asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      symbol: "USDC",
      blockchain: "base",
      decimals: 6,
    },
  ];
  it("reads asset ids from the catalog", () => {
    expect(findUsdc(tokens)).toBe(USDC);
    expect(findUsdc(tokens, "base")).toMatch(/^nep141:base-/);
    expect(() => findUsdc(tokens, "sol")).toThrow(/not in the token catalog/);
  });
});

describe("describeRefusal", () => {
  const err = (code: string) =>
    Object.assign(Object.create(AgentApiError.prototype), { code }) as AgentApiError;

  it("explains known refusals and confirms nothing moved", () => {
    expect(describeRefusal(err("wallet_frozen"))?.recipient).toMatch(/paused.*No money/);
    expect(describeRefusal(err("spend_budget_exceeded"))?.sender).toMatch(/budget/);
  });

  it("never claims nothing moved for unknown codes", () => {
    const r = describeRefusal(err("internal_error"));
    expect(r?.recipient).not.toMatch(/No money/);
    expect(r?.recipient).toMatch(/don't send it again/);
  });

  it("ignores errors that are not from the Agent API", () => {
    expect(describeRefusal(new Error("boom"))).toBeNull();
  });
});

describe("dev owner signing", () => {
  const keyPair = KeyPair.fromRandom("ed25519");
  const owner = loadDevOwner("earmark-dev-owner.near", keyPair.toString(), "http://unused");

  function nep413(accountId: string, publicKey: string): GenerateIntentResponse {
    return {
      type: "agent_freeze",
      correlation_id: "op_1",
      signer: { type: "near", account_id: accountId, public_key: publicKey },
      intent: {
        standard: "nep413",
        payload: {
          message: "freeze",
          nonce: Buffer.alloc(32, 7).toString("base64"),
          recipient: "api.agentsonintents.com",
        },
      },
    } as unknown as GenerateIntentResponse;
  }

  it("derives the owner wallet from the key", () => {
    expect(owner.owner).toEqual({
      type: "near",
      account_id: "earmark-dev-owner.near",
      public_key: keyPair.getPublicKey().toString(),
    });
  });

  it("signs nep413 intents with the owner key, deterministically", async () => {
    const intent = nep413("earmark-dev-owner.near", owner.owner.public_key);
    const a = (await owner.sign(intent)) as unknown as { signature: string; public_key: string };
    const b = (await owner.sign(intent)) as unknown as { signature: string };
    expect(Buffer.from(a.signature, "base64")).toHaveLength(64);
    expect(a.public_key).toBe(owner.owner.public_key);
    expect(a.signature).toBe(b.signature);
  });

  it("refuses intents for another key", async () => {
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    await expect(
      signAsNearOwner(nep413("earmark-dev-owner.near", other), keyPair, "http://unused"),
    ).rejects.toThrow(/different owner key/);
  });
});
