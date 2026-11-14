import { Account, actions, JsonRpcProvider, type KeyPairString } from "near-api-js";

/**
 * The family vault on NEAR testnet (contracts/vault). Two keys, two roles:
 * the agent key may only call `pay`; the admin key registers families,
 * their hard limits and their numbers, and funds them with test USDC.
 */

export interface VaultKey {
  accountId: string;
  privateKey: KeyPairString;
}

export interface NearVaultConfig {
  rpcUrl: string;
  vaultId: string;
  tokenId: string;
  /** Function-call key for vault.pay only. */
  agent?: VaultKey;
  admin?: VaultKey;
}

export interface VaultLimits {
  frozen: boolean;
  /** Test-USDC atomic units (6 decimals). */
  perPaymentMax: string;
  monthlyBudget: string;
}

export interface VaultPayment {
  familyId: string;
  orderId: string;
  category: "electricity" | "airtime" | "data" | "tv";
  amountUsdcAtomic: string;
  customerRefHash: string;
}

/** The vault refused the payment. Nothing moved. */
export class VaultRefusal extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly txHash: string,
  ) {
    super(`vault refused (${code}): ${detail}`);
  }
}

const GAS_PAY = 60_000_000_000_000n;
const GAS_ADMIN = 30_000_000_000_000n;
const GAS_FT_CALL = 100_000_000_000_000n;

type Outcome = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

function failureOf(o: Outcome): string | null {
  const status = o.status as { Failure?: unknown } | string;
  if (typeof status === "object" && status && "Failure" in status && status.Failure) {
    return JSON.stringify(status.Failure);
  }
  return null;
}

function returned(o: Outcome): unknown {
  const status = o.status as { SuccessValue?: string };
  if (!status?.SuccessValue) return null;
  try {
    return JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export class NearVault {
  private readonly provider: JsonRpcProvider;
  private readonly agent: Account | null;
  private readonly admin: Account | null;
  /** One access key, one nonce sequence: each key's calls go one at a time. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly cfg: NearVaultConfig) {
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.agent = cfg.agent
      ? new Account(cfg.agent.accountId, this.provider, cfg.agent.privateKey)
      : null;
    this.admin = cfg.admin
      ? new Account(cfg.admin.accountId, this.provider, cfg.admin.privateKey)
      : null;
  }

  get vaultId(): string {
    return this.cfg.vaultId;
  }

  private queued<T>(who: Account, work: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(who.accountId) ?? Promise.resolve();
    const run = prev.then(work);
    this.queues.set(
      who.accountId,
      run.catch(() => {}),
    );
    return run;
  }

  private send(
    who: Account,
    receiverId: string,
    method: string,
    args: object,
    gas: bigint,
    deposit = 0n,
  ): Promise<Outcome> {
    return this.queued(who, () =>
      who.signAndSendTransaction({
        receiverId,
        actions: [actions.functionCall(method, Buffer.from(JSON.stringify(args)), gas, deposit)],
        throwOnFailure: false,
      }),
    );
  }

  /**
   * Pay settlement for one order. Resolves with the transaction hash when
   * test USDC reached settlement; throws VaultRefusal when the vault said
   * no (nothing moved); any other error means "try again later".
   */
  async pay(p: VaultPayment): Promise<{ txHash: string }> {
    if (!this.agent) throw new Error("no agent key for the vault");
    const out = await this.send(
      this.agent,
      this.cfg.vaultId,
      "pay",
      {
        family_id: p.familyId,
        order_id: p.orderId,
        category: p.category,
        amount: p.amountUsdcAtomic,
        customer_ref_hash: p.customerRefHash,
      },
      GAS_PAY,
    );
    const txHash = out.transaction.hash;
    const failure = failureOf(out);
    if (failure) {
      const code = failure.match(/ERR_[A-Z_]+/)?.[0];
      // A family registered a moment ago may not be there yet: retry, don't refuse.
      if (!code || code === "ERR_NO_FAMILY")
        throw new Error(`vault call failed: ${failure.slice(0, 300)}`);
      const detail = failure.match(new RegExp(`${code}: ([^"\\\\]+)`))?.[1] ?? code;
      throw new VaultRefusal(code, detail, txHash);
    }
    // pay() returns on_paid's answer: false means the transfer failed and was put back.
    if (returned(out) === false) throw new Error(`vault transfer for ${p.orderId} was reverted`);
    return { txHash };
  }

  private async adminCall(method: string, args: object): Promise<string> {
    if (!this.admin) throw new Error("no admin key for the vault");
    const out = await this.send(this.admin, this.cfg.vaultId, method, args, GAS_ADMIN);
    const failure = failureOf(out);
    if (failure) throw new Error(`vault ${method} failed: ${failure.slice(0, 300)}`);
    return out.transaction.hash;
  }

  registerFamily(familyId: string, limits: VaultLimits): Promise<string> {
    return this.adminCall("register_family", {
      family_id: familyId,
      limits: {
        frozen: limits.frozen,
        per_payment_max: limits.perPaymentMax,
        monthly_budget: limits.monthlyBudget,
      },
    });
  }

  allow(familyId: string, hashes: string[]): Promise<string> {
    return this.adminCall("allow", { family_id: familyId, hashes });
  }

  disallow(familyId: string, hashes: string[]): Promise<string> {
    return this.adminCall("disallow", { family_id: familyId, hashes });
  }

  setFrozen(familyId: string, frozen: boolean): Promise<string> {
    return this.adminCall("set_frozen", { family_id: familyId, frozen });
  }

  /** Send test USDC from the admin's balance into a family's account. */
  async fund(familyId: string, amountUsdcAtomic: string): Promise<string> {
    if (!this.admin) throw new Error("no admin key for the vault");
    const out = await this.send(
      this.admin,
      this.cfg.tokenId,
      "ft_transfer_call",
      { receiver_id: this.cfg.vaultId, amount: amountUsdcAtomic, msg: familyId },
      GAS_FT_CALL,
      1n,
    );
    const failure = failureOf(out);
    if (failure) throw new Error(`vault funding failed: ${failure.slice(0, 300)}`);
    return out.transaction.hash;
  }

  async family(familyId: string): Promise<{
    balance: string;
    limits: { frozen: boolean; per_payment_max: string; monthly_budget: string };
    month: number;
    spent_this_month: string;
  } | null> {
    return (await this.provider.callFunction({
      contractId: this.cfg.vaultId,
      method: "family",
      args: { family_id: familyId },
    })) as never;
  }
}
