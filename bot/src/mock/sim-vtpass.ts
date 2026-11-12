import { VtpassClient } from "@earmark/billers";

// Used by the failure drills and by the keyless local demo (make demo).
//
// A VTpass that keeps state, so the drills can break it the ways the real
// one breaks: down, slow, out of float, failing a bill, or paying a bill
// and then timing out before it answers. It records every bill it actually
// delivered, so a drill can prove nothing was bought twice.

export interface SimState {
  /** Every request fails as if the network were down. */
  down: boolean;
  /** The wallet balance, in naira. */
  balanceNgn: number;
  /** Meters and smartcards the lookup knows. */
  known: Set<string>;
  /** The next /pay calls answer with these codes instead of delivering. */
  failNextPay: string[];
  /** The next /pay calls deliver the bill but time out before answering. */
  payTimeouts: number;
}

export function simVtpass(init: Partial<SimState> = {}) {
  const state: SimState = {
    down: false,
    balanceNgn: 1_000_000,
    known: new Set(["1111111111111", "1212121212"]),
    failNextPay: [],
    payTimeouts: 0,
    ...init,
  };
  /** request_id → the delivered transaction. */
  const delivered = new Map<string, Record<string, unknown>>();
  /** request_id → how many times /pay was sent. */
  const pays = new Map<string, number>();
  let txn = 1000;

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    if (state.down) throw new TypeError("fetch failed");
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/api/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    switch (path) {
      case "/balance":
        return json({ code: 1, contents: { balance: state.balanceNgn.toFixed(2) } });
      case "/merchant-verify": {
        const ref = String(body.billersCode);
        return json(
          state.known.has(ref)
            ? { code: "000", content: { Customer_Name: "MAMA NGOZI", Address: "Ikeja" } }
            : {
                code: "000",
                content: { error: "This meter is not valid", WrongBillersCode: true },
              },
        );
      }
      case "/service-variations":
        return json({ code: "000", content: { variations: [] } });
      case "/pay": {
        const id = String(body.request_id);
        pays.set(id, (pays.get(id) ?? 0) + 1);
        const done = delivered.get(id);
        if (done) return json({ code: "014", response_description: "REQUEST ID ALREADY EXIST" });
        const fail = state.failNextPay.shift();
        if (fail) {
          return json({
            code: fail,
            response_description: "TRANSACTION FAILED",
            content: { transactions: { status: "failed", transactionId: String(txn++) } },
          });
        }
        const amount = Number(body.amount ?? 0);
        state.balanceNgn -= amount;
        const tx = {
          code: "000",
          response_description: "TRANSACTION SUCCESSFUL",
          requestId: id,
          amount,
          transaction_date: new Date().toISOString(),
          // Only electricity comes with a token.
          ...(String(body.serviceID).includes("electric")
            ? { token: "Token : 1234 5678 9012 3456 7890", units: "53.2 kWh" }
            : {}),
          content: { transactions: { status: "delivered", transactionId: String(txn++) } },
        };
        delivered.set(id, tx);
        if (state.payTimeouts > 0) {
          state.payTimeouts -= 1;
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        }
        return json(tx);
      }
      case "/requery": {
        const id = String(body.request_id);
        return json(
          delivered.get(id) ?? { code: "015", response_description: "INVALID REQUEST ID" },
        );
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;

  const client = new VtpassClient({
    baseUrl: "https://sandbox.vtpass.com/api",
    apiKey: "api",
    publicKey: "PK_sim",
    secretKey: "SK_sim",
    fetch: fetchFn,
  });
  return { client, state, delivered, pays };
}
