import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ReceiptWriter } from "@earmark/billers";
import type { Receipt, ReceiptInput } from "@earmark/shared";

// A local stand-in for the receipts contract and the NEAR RPC in front of
// it, for the keyless demo. It answers the same JSON-RPC calls the public
// page makes (call_function on the contract's views, and tx status), so the
// page runs unchanged. The real contract is tested against a NEAR sandbox
// in CI (contracts/receipts/tests); this only mimics what the page reads.
//
// Not a blockchain: nothing here is signed or durable. The page still
// checks each transaction (right contract, success, our event for this
// order), but against this process, not NEAR.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeHash = () => Array.from(randomBytes(44), (b) => B58[b % B58.length]).join("");

interface Tx {
  hash: string;
  receipt: Receipt;
}

export class MockChain implements ReceiptWriter {
  readonly contractId = "earmark-receipts.local";
  readonly serviceId = "earmark-service.local";
  private readonly byOrder = new Map<string, Tx>();
  private readonly byFamily = new Map<string, string[]>();
  private readonly byHash = new Map<string, Tx>();
  private server: Server | null = null;

  /** One receipt per order. A repeat returns the first transaction, like NearReceiptWriter. */
  async record(input: ReceiptInput): Promise<{ txHash: string }> {
    const prior = this.byOrder.get(input.orderId);
    if (prior) return { txHash: prior.hash };
    const tx: Tx = { hash: fakeHash(), receipt: { ...input, recordedAtMs: Date.now() } };
    this.byOrder.set(input.orderId, tx);
    this.byHash.set(tx.hash, tx);
    const ids = this.byFamily.get(input.familyId) ?? [];
    ids.push(input.orderId);
    this.byFamily.set(input.familyId, ids);
    return { txHash: tx.hash };
  }

  /** The contract's view methods, as JSON. */
  private view(method: string, args: Record<string, unknown>): unknown {
    const family = String(args.family_id ?? "");
    const ids = this.byFamily.get(family) ?? [];
    switch (method) {
      case "get_receipt":
        return this.byOrder.get(String(args.order_id))?.receipt ?? null;
      case "family_receipt_count":
        return ids.length;
      case "receipts_for_family": {
        const from = Number(args.from_index ?? 0);
        const limit = Math.min(Number(args.limit ?? 50), 50);
        return ids
          .slice(from, from + limit)
          .map((id) => this.byOrder.get(id)?.receipt)
          .filter(Boolean);
      }
      case "service":
        return this.serviceId;
      default:
        throw new Error(`no such view: ${method}`);
    }
  }

  /** The JSON-RPC subset the receipts page uses. */
  private rpc(method: string, params: Record<string, unknown>): unknown {
    if (method === "query") {
      const args = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8"));
      const result = this.view(String(params.method_name), args);
      return { result: [...Buffer.from(JSON.stringify(result))], logs: [] };
    }
    if (method === "EXPERIMENTAL_tx_status") {
      const tx = this.byHash.get(String(params.tx_hash));
      if (!tx)
        throw Object.assign(new Error("unknown"), { cause: { name: "UNKNOWN_TRANSACTION" } });
      const event = {
        standard: "earmark_receipts",
        version: "1.0.0",
        event: "receipt_recorded",
        data: tx.receipt,
      };
      return {
        status: { SuccessValue: "" },
        transaction: { receiver_id: this.contractId, signer_id: this.serviceId },
        transaction_outcome: { block_hash: fakeHash() },
        receipts_outcome: [{ outcome: { logs: [`EVENT_JSON:${JSON.stringify(event)}`] } }],
      };
    }
    throw new Error(`unsupported RPC method ${method}`);
  }

  /** Serve the RPC on `port` (0: any free port). Returns its URL. */
  async listen(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors).end();
        return;
      }
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString("utf8").slice(0, 64 * 1024);
      });
      req.on("end", () => {
        let id: unknown = "earmark";
        try {
          const call = JSON.parse(body) as { id?: unknown; method: string; params: never };
          id = call.id;
          const result = this.rpc(call.method, call.params);
          res.writeHead(200, { ...cors, "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (e) {
          res.writeHead(200, { ...cors, "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { message: String(e), cause: (e as { cause?: unknown }).cause },
            }),
          );
        }
      });
    });
    const server = this.server;
    await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    return new Promise((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }
}
