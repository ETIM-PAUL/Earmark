import type { Receipt } from "@earmark/shared";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReceiptCard } from "./receipt-card.js";
import "./ui/tokens.css";
import "./ui/pages.css";
import {
  EXPLORER,
  getFamilyReceipts,
  getReceipt,
  LOCAL_RPC,
  parseNetwork,
  type TxCheck,
  verifyReceiptTx,
} from "./receipts.js";

// Public receipts page. Reads straight from the receipts contract; no
// backend, no sign-in.
//
//   /receipt.html?order=<id>[&tx=<hash>]   one payment, with its on-chain proof
//   /receipt.html?family=<fam_…>           a family's receipts, live
//
// Both take &contract=<account> and &network=testnet|mainnet, or fall back
// to VITE_RECEIPTS_CONTRACT_ID and VITE_NEAR_NETWORK.

const params = new URLSearchParams(location.search);
const network = parseNetwork(params.get("network") ?? import.meta.env.VITE_NEAR_NETWORK);
const contractId = params.get("contract") ?? import.meta.env.VITE_RECEIPTS_CONTRACT_ID ?? "";
const orderId = params.get("order") ?? "";
const txHash = params.get("tx");
const familyId = params.get("family") ?? "";

/** New receipts show up within one poll of being written. */
const POLL_MS = 3_000;

function usePoll<T>(load: () => Promise<T>, done: (v: T) => boolean) {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const value = await load();
        if (stop) return;
        setState({ value });
        if (done(value)) return;
      } catch (e) {
        if (!stop) setState((s) => ({ ...s, error: String(e) }));
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [load, done]);
  return state;
}

const loadOne = () => getReceipt(network, contractId, orderId);
const oneDone = (r: Receipt | null) => r !== null;

function OnePayment() {
  const { value, error } = usePoll(loadOne, oneDone);
  const [check, setCheck] = useState<TxCheck | "checking" | null>(null);
  useEffect(() => {
    if (!value || !txHash) return;
    setCheck("checking");
    verifyReceiptTx(network, contractId, txHash, value.orderId)
      .then(setCheck)
      .catch((e) => setCheck({ verified: false, why: String(e) }));
  }, [value]);

  if (value) return <ReceiptCard r={value} network={network} txHash={txHash} check={check} />;
  if (error && value === undefined)
    return (
      <p role="alert" className="alert">
        {error}
      </p>
    );
  if (value === undefined) return <p>Reading the receipt from NEAR {network}…</p>;
  return <p>No receipt for order {orderId} yet. This page checks again every few seconds.</p>;
}

const loadFamily = () => getFamilyReceipts(network, contractId, familyId);
const never = () => false;

function FamilyFeed() {
  const { value, error } = usePoll(loadFamily, never);
  if (error && !value)
    return (
      <p role="alert" className="alert">
        {error}
      </p>
    );
  if (!value) return <p>Reading receipts from NEAR {network}…</p>;
  if (value.length === 0) return <p>No receipts yet. New ones appear here by themselves.</p>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {value.map((r) => (
        <ReceiptCard key={r.orderId} r={r} network={network} compact />
      ))}
    </div>
  );
}

function Page() {
  const body = !contractId ? (
    <p role="alert" className="alert">
      Add ?contract=… to the link.
    </p>
  ) : orderId ? (
    <OnePayment />
  ) : familyId ? (
    <FamilyFeed />
  ) : (
    <p role="alert" className="alert">
      Add ?order=… or ?family=… to the link.
    </p>
  );
  return (
    <div className="rp">
      <header className="rp-top">
        <a className="rp-brand" href="/">
          Earmark
        </a>
        <h1>{orderId ? "Public receipt" : "Public receipts"}</h1>
        <p>
          Read live from the receipts contract. Nothing on this page comes from our servers, and it
          checks the transaction itself.
        </p>
      </header>
      <main className="rp-main">{body}</main>
      <footer className="rp-foot">
        <p>
          Contract{" "}
          {LOCAL_RPC ? (
            <>{contractId} on a local demo chain, not NEAR</>
          ) : (
            <>
              <a href={`${EXPLORER[network]}/address/${contractId}`}>{contractId || "(not set)"}</a>{" "}
              on NEAR {network}
            </>
          )}
          . Names, phone numbers, meter numbers and tokens are never on-chain.
        </p>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
