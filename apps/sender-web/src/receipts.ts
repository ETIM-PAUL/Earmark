import { Receipt } from "@earmark/shared";

// Read-only access to the receipts contract over NEAR JSON-RPC. No wallet,
// no backend: anyone can check a receipt, and its transaction, themselves.

export type Network = "mainnet" | "testnet";

export const RPC: Record<Network, string> = {
  mainnet: "https://rpc.mainnet.fastnear.com",
  testnet: "https://rpc.testnet.fastnear.com",
};

/** Regular nodes forget transactions after about two days; archival ones don't. */
export const ARCHIVAL_RPC: Record<Network, string> = {
  mainnet: "https://archival-rpc.mainnet.fastnear.com",
  testnet: "https://archival-rpc.testnet.fastnear.com",
};

export const EXPLORER: Record<Network, string> = {
  mainnet: "https://nearblocks.io",
  testnet: "https://testnet.nearblocks.io",
};

export function parseNetwork(v: string | null | undefined): Network {
  return v === "mainnet" ? "mainnet" : "testnet";
}

const toBase64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

type RpcError = { cause?: { name?: string }; message?: string };

async function rpc<T>(url: string, method: string, params: object): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "earmark", method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: RpcError };
  if (body.error || body.result === undefined) {
    throw new Error(
      `RPC ${method} failed: ${body.error?.cause?.name ?? body.error?.message ?? "no result"}`,
    );
  }
  return body.result;
}

async function view(network: Network, contractId: string, method: string, args: object) {
  const r = await rpc<{ result?: number[]; error?: string }>(RPC[network], "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: toBase64(JSON.stringify(args)),
  });
  if (r.error || !r.result) throw new Error(`view ${method} failed: ${r.error ?? "no result"}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as unknown;
}

/** The receipt, or null if the contract has none for this order. */
export async function getReceipt(
  network: Network,
  contractId: string,
  orderId: string,
): Promise<Receipt | null> {
  const raw = await view(network, contractId, "get_receipt", { order_id: orderId });
  // Strict: an unexpected key means the contract changed shape. Refuse to show it.
  return raw === null ? null : Receipt.parse(raw);
}

/** A family's latest receipts, newest first. */
export async function getFamilyReceipts(
  network: Network,
  contractId: string,
  familyId: string,
  limit = 20,
): Promise<Receipt[]> {
  const count = Number(
    await view(network, contractId, "family_receipt_count", { family_id: familyId }),
  );
  const from = Math.max(0, count - limit);
  const raw = await view(network, contractId, "receipts_for_family", {
    family_id: familyId,
    from_index: from,
    limit,
  });
  if (!Array.isArray(raw)) throw new Error("receipts_for_family did not return a list");
  return raw.map((r) => Receipt.parse(r)).reverse();
}

export type TxCheck = { verified: true; blockHash: string } | { verified: false; why: string };

interface TxStatus {
  status: { SuccessValue?: string; Failure?: unknown };
  transaction: { receiver_id: string; signer_id: string };
  transaction_outcome: { block_hash: string };
  receipts_outcome: { outcome: { logs: string[] } }[];
}

/**
 * Checks, on-chain, that a transaction recorded this order's receipt: it
 * went to the receipts contract, succeeded, and logged our NEP-297 event
 * for this order ID. A link can't fake that.
 */
export async function verifyReceiptTx(
  network: Network,
  contractId: string,
  txHash: string,
  orderId: string,
): Promise<TxCheck> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash))
    return { verified: false, why: "not a transaction hash" };
  const service = String(await view(network, contractId, "service", {}));
  let tx: TxStatus;
  try {
    tx = await rpc<TxStatus>(ARCHIVAL_RPC[network], "EXPERIMENTAL_tx_status", {
      tx_hash: txHash,
      sender_account_id: service,
      wait_until: "FINAL",
    });
  } catch (e) {
    return { verified: false, why: String(e) };
  }
  if (tx.transaction.receiver_id !== contractId)
    return { verified: false, why: "sent to another contract" };
  if (tx.status.Failure !== undefined) return { verified: false, why: "the transaction failed" };
  const logged = tx.receipts_outcome
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice("EVENT_JSON:".length)) as {
          standard?: string;
          event?: string;
          data?: { orderId?: string };
        };
      } catch {
        return null;
      }
    })
    .some(
      (e) =>
        e?.standard === "earmark_receipts" &&
        e.event === "receipt_recorded" &&
        e.data?.orderId === orderId,
    );
  return logged
    ? { verified: true, blockHash: tx.transaction_outcome.block_hash }
    : { verified: false, why: "no receipt event for this order" };
}
