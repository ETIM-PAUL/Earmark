import { Receipt } from "@earmark/shared";

// Read-only access to the receipts contract over NEAR JSON-RPC. No wallet,
// no backend: anyone can check a receipt.

export type Network = "mainnet" | "testnet";

export const RPC: Record<Network, string> = {
  mainnet: "https://rpc.mainnet.fastnear.com",
  testnet: "https://rpc.testnet.fastnear.com",
};

export const EXPLORER: Record<Network, string> = {
  mainnet: "https://nearblocks.io",
  testnet: "https://testnet.nearblocks.io",
};

const toBase64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

async function view(network: Network, contractId: string, method: string, args: object) {
  const res = await fetch(RPC[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "earmark",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: toBase64(JSON.stringify(args)),
      },
    }),
  });
  const body = (await res.json()) as {
    result?: { result?: number[]; error?: string };
    error?: { cause?: { name?: string }; message?: string };
  };
  const err = body.error?.cause?.name ?? body.error?.message ?? body.result?.error;
  if (err || !body.result?.result) throw new Error(`RPC ${method} failed: ${err ?? "no result"}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as unknown;
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
