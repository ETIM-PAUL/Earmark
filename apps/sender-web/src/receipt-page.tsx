import { formatNaira, formatUsdc, type Receipt } from "@earmark/shared";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EXPLORER, getReceipt, type Network } from "./receipts.js";

// Stub public receipts page (Phase 7). Phase 13 turns it into the real
// page per payment. It shows only what the contract holds: no names, no
// phone or meter numbers, no electricity token.
//
//   /receipt.html?order=<order id>[&contract=<account>][&network=testnet|mainnet]

const params = new URLSearchParams(location.search);
const network: Network =
  (params.get("network") ?? import.meta.env.VITE_NEAR_NETWORK) === "mainnet"
    ? "mainnet"
    : "testnet";
const contractId = params.get("contract") ?? import.meta.env.VITE_RECEIPTS_CONTRACT_ID ?? "";
const orderId = params.get("order") ?? "";

const CATEGORY_LABEL: Record<Receipt["category"], string> = {
  electricity: "Electricity",
  airtime: "Airtime",
  data: "Data",
  tv: "TV",
};

type State =
  | { kind: "loading" }
  | { kind: "found"; receipt: Receipt }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function ReceiptPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!contractId || !orderId) {
      setState({ kind: "error", message: "Add ?order=… (and ?contract=… if not configured)." });
      return;
    }
    getReceipt(network, contractId, orderId)
      .then((receipt) => setState(receipt ? { kind: "found", receipt } : { kind: "missing" }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }));
  }, []);

  return (
    <main
      style={{ fontFamily: "system-ui, sans-serif", maxWidth: 480, margin: "0 auto", padding: 16 }}
    >
      <h1>Earmark receipt</h1>
      {state.kind === "loading" && <p>Reading the receipt from NEAR {network}…</p>}
      {state.kind === "missing" && <p>No receipt for order {orderId} yet.</p>}
      {state.kind === "error" && <p role="alert">{state.message}</p>}
      {state.kind === "found" && <ReceiptCard r={state.receipt} />}
      <p style={{ color: "#666", fontSize: 14 }}>
        Contract{" "}
        <a href={`${EXPLORER[network]}/address/${contractId}`}>{contractId || "(not set)"}</a> on{" "}
        {network}. Names, phone and meter numbers are never on-chain.
      </p>
    </main>
  );
}

function ReceiptCard({ r }: { r: Receipt }) {
  const rows: [string, string][] = [
    ["Bill", CATEGORY_LABEL[r.category]],
    ["Amount", `${formatNaira(r.amountNgnKobo)} (${formatUsdc(r.amountUsdcAtomic)} USDC)`],
    ["Status", r.status === "fulfilled" ? "Paid" : "Refunded to the family"],
    ["Recorded", new Date(r.recordedAtMs).toLocaleString("en-GB", { timeZone: "Africa/Lagos" })],
    ["Order", r.orderId],
    ["Family", r.familyId],
  ];
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "8px 16px" }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt style={{ color: "#666" }}>{k}</dt>
          <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ReceiptPage />
  </StrictMode>,
);
