import { Receipt, type ReceiptInput } from "@earmark/shared";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

/** Writes receipts to the receipts contract (contracts/receipts). */
export interface ReceiptWriter {
  /**
   * Record one receipt. Idempotent: if the contract already holds an
   * identical receipt for this order, that counts as success.
   */
  record(receipt: ReceiptInput): Promise<{ txHash: string }>;
}

export class ReceiptConflictError extends Error {
  constructor(readonly orderId: string) {
    super(`the contract already holds a different receipt for order ${orderId}`);
    this.name = "ReceiptConflictError";
  }
}

export interface NearReceiptWriterConfig {
  rpcUrl: string;
  contractId: string;
  /** The contract's service account: the only one allowed to write. */
  serviceAccountId: string;
  servicePrivateKey: KeyPairString;
}

export class NearReceiptWriter implements ReceiptWriter {
  private readonly provider: JsonRpcProvider;
  private readonly service: Account;
  /** One access key means one nonce sequence: writes go one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: NearReceiptWriterConfig) {
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.service = new Account(cfg.serviceAccountId, this.provider, cfg.servicePrivateKey);
  }

  record(receipt: ReceiptInput): Promise<{ txHash: string }> {
    const run = this.queue.then(() => this.write(receipt));
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(receipt: ReceiptInput): Promise<{ txHash: string }> {
    try {
      const out = await this.service.callFunctionRaw({
        contractId: this.cfg.contractId,
        methodName: "record_receipt",
        args: { receipt },
      });
      return { txHash: out.transaction.hash };
    } catch (e) {
      // A retry after a lost response: the first write landed.
      if (!String(e).includes("receipt already recorded")) throw e;
      const stored = await this.get(receipt.orderId);
      if (!stored || !sameReceipt(stored, receipt)) throw new ReceiptConflictError(receipt.orderId);
      return { txHash: `already-recorded:${receipt.orderId}` };
    }
  }

  async get(orderId: string): Promise<Receipt | null> {
    const raw = await this.provider.callFunction({
      contractId: this.cfg.contractId,
      method: "get_receipt",
      args: { order_id: orderId },
    });
    return raw ? Receipt.parse(raw) : null;
  }
}

function sameReceipt(a: Receipt, b: ReceiptInput): boolean {
  return (Object.keys(b) as (keyof ReceiptInput)[]).every((k) => a[k] === b[k]);
}
