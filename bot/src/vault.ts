import type { NearVault, VaultLimits } from "@earmark/billers";
import { VaultRefusal } from "@earmark/billers";
import { CATEGORIES, hashCustomerRef, type Order } from "@earmark/shared";
import { type DemoWiring, type Payer, PaymentRefused } from "./demo.js";
import { type Family, knownRefs } from "./dialog.js";

/**
 * The family vault on NEAR testnet, wired into the demo. Settlement is paid
 * by the vault contract, which checks the sender's hard limits itself:
 * freeze, the per-payment cap, the monthly budget and the list of numbers
 * (as the same salted hashes the receipts carry). The payment path holds a
 * key that can only call `pay`; registering families and their numbers
 * uses the admin key, after the sender's change in the app.
 */

/** Test USDC each new demo family starts with: its whole monthly budget. */
const START_BALANCE_USDC = 100;

/** Every number a family may pay for, as the hashes the vault checks. */
export async function vaultHashes(family: Family): Promise<string[]> {
  const out = new Set<string>();
  for (const category of CATEGORIES) {
    for (const ref of knownRefs(family, category)) {
      out.add(await hashCustomerRef(family.salt, category, ref));
    }
  }
  return [...out];
}

function limitsOf(family: Family): VaultLimits {
  const usdc = (n: string | number) => String(Math.round(Number(n) * 1e6));
  return {
    frozen: family.rules.frozen,
    perPaymentMax: family.rules.hardLimits.perTransactionMaxUsdcAtomic,
    monthlyBudget: usdc(family.rules.hardLimits.monthlyBudgetUsd),
  };
}

/** What the recipient hears when the vault refuses (nothing moved). */
const REFUSALS: Record<string, string> = {
  ERR_FROZEN: "The account is frozen by the sender.",
  ERR_NOT_ON_LIST: "That number isn't on the sender's list.",
  ERR_OVER_PER_PAYMENT: "That's more than the sender allows in one payment.",
  ERR_OVER_MONTHLY: "That would pass the sender's budget for this month.",
  ERR_BALANCE: "There isn't enough money in the family account.",
  ERR_ALREADY_PAID: "This bill was already paid.",
};

export class VaultSync {
  private readonly ready = new Map<string, Promise<void>>();
  private readonly families = new Map<string, Family>();
  private readonly allowed = new Map<string, Set<string>>();

  constructor(
    private readonly vault: NearVault,
    private readonly log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  /** Resolves once the family is registered, funded and its numbers allowed. */
  whenReady(familyId: string): Promise<void> {
    return this.ready.get(familyId) ?? Promise.resolve();
  }

  /** The payer for wireDemo: the vault pays settlement, or refuses. */
  payer(): Payer {
    return {
      pay: async (order: Order) => {
        await this.whenReady(order.familyId);
        if (!order.quote) throw new Error(`order ${order.id} has no quote to pay against`);
        try {
          return await this.vault.pay({
            familyId: order.familyId,
            orderId: order.id,
            category: order.category,
            amountUsdcAtomic: order.quote.amountUsdcAtomic,
            customerRefHash: order.customerRefHash,
          });
        } catch (e) {
          if (e instanceof VaultRefusal) {
            throw new PaymentRefused(
              `${REFUSALS[e.code] ?? e.detail} (vault ${e.code}, tx ${e.txHash})`,
            );
          }
          throw e;
        }
      },
    };
  }

  private register(family: Family): void {
    const id = family.familyId;
    this.families.set(id, family);
    const work = (async () => {
      await this.vault.registerFamily(id, limitsOf(family));
      const hashes = await vaultHashes(family);
      await this.vault.allow(id, hashes);
      this.allowed.set(id, new Set(hashes));
      await this.vault.fund(id, String(START_BALANCE_USDC * 1e6));
    })();
    this.ready.set(
      id,
      work.catch((e) => this.log(`vault: family ${id} not set up: ${String(e)}`)),
    );
  }

  /** The numbers changed: allow the new ones, remove the ones taken off. */
  private async numbers(familyId: string): Promise<void> {
    const family = this.families.get(familyId);
    if (!family) return;
    await this.whenReady(familyId);
    const now = new Set(await vaultHashes(family));
    const before = this.allowed.get(familyId) ?? new Set<string>();
    const added = [...now].filter((h) => !before.has(h));
    const removed = [...before].filter((h) => !now.has(h));
    if (added.length) await this.vault.allow(familyId, added);
    if (removed.length) await this.vault.disallow(familyId, removed);
    this.allowed.set(familyId, now);
  }

  /** Mirror family creation, freezes and number changes onto the vault. */
  attach(demo: DemoWiring): void {
    const create = demo.createFamily;
    demo.createFamily = (input) => {
      const family = create(input);
      this.register(family);
      return family;
    };
    const side = demo.sender;
    const setFrozen = side.setFrozen;
    side.setFrozen = async (familyId, frozen) => {
      const ok = await setFrozen(familyId, frozen);
      if (ok) {
        await this.whenReady(familyId);
        await this.vault
          .setFrozen(familyId, frozen)
          .catch((e) => this.log(`vault: freeze for ${familyId} failed: ${String(e)}`));
      }
      return ok;
    };
    const addNumber = side.addNumber;
    side.addNumber = (familyId, entry, dryRun) => {
      const r = addNumber(familyId, entry, dryRun);
      if (!dryRun && r === "ok")
        void this.numbers(familyId).catch((e) => this.log(`vault: ${String(e)}`));
      return r;
    };
    const removeNumber = side.removeNumber;
    side.removeNumber = (familyId, id) => {
      const ok = removeNumber(familyId, id);
      if (ok) void this.numbers(familyId).catch((e) => this.log(`vault: ${String(e)}`));
      return ok;
    };
  }
}
