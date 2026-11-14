import { type NearVault, VaultRefusal } from "@earmark/billers";
import { hashCustomerRef } from "@earmark/shared";
import { describe, expect, it } from "vitest";
import { ATTACKS, fooledModel, runAttack } from "./attack-drill.js";
import type { DemoWiring } from "./demo.js";
import { VaultSync } from "./vault.js";

/** The bot's side of the testnet vault, against a fake vault: no network. */

function fakeVault(refuse?: string) {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string, out: unknown = "tx") =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return out;
    };
  const vault = {
    registerFamily: rec("registerFamily"),
    allow: rec("allow"),
    disallow: rec("disallow"),
    setFrozen: rec("setFrozen"),
    fund: rec("fund"),
    pay: async (...args: unknown[]) => {
      calls.push({ method: "pay", args });
      if (refuse) throw new VaultRefusal(refuse, "refused by the vault", "FakeTx111");
      return { txHash: "VaultTx111" };
    },
  } as unknown as NearVault;
  return { vault, calls };
}

const control = ATTACKS.find((a) => a.id === "control");
if (!control) throw new Error("control attack missing");

describe("the testnet vault, wired into the bot", () => {
  it("a new family is registered with its hard limits, numbers and money, and the vault pays the bill", async () => {
    const { vault, calls } = fakeVault();
    const sync = new VaultSync(vault, () => {});
    let demo: DemoWiring | null = null;
    const o = await runAttack(control, fooledModel(control), {
      payer: sync.payer(),
      onDemo: (d) => {
        demo = d;
        sync.attach(d);
      },
    });
    expect(o.bills).toBe(1);
    const order = o.orders[0];
    expect(order?.paymentTxHash).toBe("VaultTx111");

    const [familyId, limits] = calls.find((c) => c.method === "registerFamily")?.args ?? [];
    expect(familyId).toBe(order?.familyId);
    expect(limits).toEqual({
      frozen: false,
      perPaymentMax: "50000000",
      monthlyBudget: "100000000",
    });
    // The meter this bill was for is on the vault's list, as the same salted hash.
    const allowed = calls.find((c) => c.method === "allow")?.args[1] as string[];
    expect(allowed).toContain(order?.customerRefHash);
    expect(calls.find((c) => c.method === "fund")?.args[1]).toBe("100000000");
    const pay = calls.find((c) => c.method === "pay")?.args[0] as { customerRefHash: string };
    expect(pay.customerRefHash).toBe(order?.customerRefHash);

    // A freeze in the app reaches the vault.
    await (demo as DemoWiring | null)?.sender.setFrozen(familyId as string, true);
    expect(calls.find((c) => c.method === "setFrozen")?.args).toEqual([familyId, true]);
  });

  it("when the vault refuses, nothing is bought and the recipient is told", async () => {
    const { vault } = fakeVault("ERR_OVER_MONTHLY");
    const sync = new VaultSync(vault, () => {});
    const o = await runAttack(control, fooledModel(control), {
      payer: sync.payer(),
      onDemo: (d) => sync.attach(d),
    });
    expect(o.bills).toBe(0);
    expect(o.statuses).toEqual(["rejected"]);
    expect(o.replies.join("\n")).toMatch(/couldn't|can't|not/i);
  });

  it("the hashes it allows match the ones orders carry", async () => {
    const salt = "s".repeat(64);
    const a = await hashCustomerRef(salt, "airtime", "0801 111 1111");
    const b = await hashCustomerRef(salt, "airtime", "08011111111");
    expect(a).toBe(b);
  });
});
