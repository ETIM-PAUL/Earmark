import { useState } from "react";
import { type TxCheck, verifyReceiptTx } from "../../receipts.js";
import { CATEGORY_NAMES } from "../format.js";
import type { AppConfig, OrderRow } from "../types.js";
import { receiptUrl } from "./Home.js";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  });

/** Every paid or refunded order, as the receipt the chain holds, plus the line only you see. */
export function Receipts({ orders, config }: { orders: OrderRow[]; config: AppConfig }) {
  const done = orders.filter((o) => o.status === "fulfilled" || o.status === "refunded");
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Receipts</h1>
      </div>
      <p className="lede-app">
        Each payment is recorded on NEAR with the amount, the kind of bill and the time. Names,
        numbers and tokens stay off the chain. Check any receipt yourself.
      </p>
      {done.length === 0 ? (
        <p className="empty">
          No receipts yet. A paid bill gets one within a minute, and it appears here.
        </p>
      ) : (
        <div className="stubs">
          {done.map((o) => (
            <OrderStub key={o.id} order={o} config={config} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderStub({ order: o, config }: { order: OrderRow; config: AppConfig }) {
  const [check, setCheck] = useState<TxCheck | "checking" | null>(null);
  const paid = o.status === "fulfilled";
  const link = receiptUrl(config, o);
  const run = async () => {
    if (!config.contractId || !o.receiptTxHash) return;
    setCheck("checking");
    try {
      setCheck(await verifyReceiptTx(config.network, config.contractId, o.receiptTxHash, o.id));
    } catch (e) {
      setCheck({ verified: false, why: String(e) });
    }
  };
  return (
    <div className="stub-wrap">
      <article className="stub" data-order={o.id}>
        <div className="stub-body">
          <span className="kind">{CATEGORY_NAMES[o.category] ?? o.category}</span>
          <span className="amount">{o.amountNgn}</span>
          <span className="fine">
            {o.amountUsd !== "?" ? `About ${o.amountUsd} USDC, ` : ""}
            {when(o.createdAt)} Lagos time
          </span>
          <span className={paid ? "status-paid" : "status-refunded"}>
            {paid ? "Paid" : "Refunded"}
          </span>
          <span className="fine">
            {o.label}, {o.who}. Only you see this line.
          </span>
        </div>
        <div className="stub-foot">
          {!o.receiptTxHash ? (
            <span>Being recorded on NEAR…</span>
          ) : check === "checking" ? (
            <span>Checking on NEAR…</span>
          ) : check?.verified ? (
            <span className="verified">Checked on NEAR just now</span>
          ) : check ? (
            <span className="unverified">Not verified: {check.why}</span>
          ) : (
            <span className="foot-actions">
              <button type="button" className="link-dark" onClick={run}>
                Check on NEAR
              </button>
              {link && (
                <a className="link-dark" href={link} target="_blank" rel="noreferrer">
                  Public page
                </a>
              )}
            </span>
          )}
        </div>
      </article>
    </div>
  );
}
