import { useState } from "react";
import { api } from "../api.js";
import { CATEGORY_NAMES, naira, statusLabel, usdNumber, usdToNaira } from "../format.js";
import type { AppConfig, ChangeResult, FamilyState, OrderRow, Overview } from "../types.js";

export const receiptUrl = (config: AppConfig, o: OrderRow): string | null => {
  if (!config.contractId || !o.receiptTxHash) return null;
  const q = new URLSearchParams({
    network: config.network,
    contract: config.contractId,
    order: o.id,
    tx: o.receiptTxHash,
  });
  if (config.rpcUrl) q.set("rpc", config.rpcUrl);
  return `/receipt.html?${q}`;
};

export const waitingNotice = (needed?: number) =>
  `Sent to your relatives. It takes effect when ${needed ?? "enough"} of you have signed. They'll see it in the Inbox.`;

/** A bar that fills as money is used. */
function Meter({ used, of, label }: { used: number; of: number; label: string }) {
  const pct = of > 0 ? Math.min(100, Math.round((used / of) * 100)) : 0;
  return (
    <div className="meter" role="img" aria-label={`${label}: ${pct}%`}>
      <span style={{ width: `${pct}%` }} className={pct >= 90 ? "hot" : ""} />
    </div>
  );
}

function Ledger({ o }: { o: Overview }) {
  const monthly = Number(o.budget.monthlyUsd);
  const spent = usdNumber(o.budget.spentUsd);
  const left = usdToNaira(o.budget.leftUsd, o.rateNgnPerUsd);
  return (
    <section className="ledger" aria-labelledby="ledger-h">
      <h2 id="ledger-h" className="quiet-h">
        Left this month
      </h2>
      <p className="ledger-big">{o.budget.leftUsd}</p>
      {left && <p className="ledger-naira">about {left}</p>}
      <Meter used={spent} of={monthly} label="Share of the monthly budget spent" />
      <p className="fine">
        {o.budget.spentUsd} spent of ${monthly}. At most {o.budget.perPaymentMaxUsd} in one payment.
        {o.rateNgnPerUsd && ` The rate is ₦${o.rateNgnPerUsd} per $1, before fees.`}
      </p>
    </section>
  );
}

function BillMeters({ o }: { o: Overview }) {
  return (
    <section aria-labelledby="bills-h">
      <h2 id="bills-h">Each bill</h2>
      <ul className="bills">
        {o.categories.map((c) => (
          <li key={c.category}>
            <div className="bill-row">
              <strong>{CATEGORY_NAMES[c.category]}</strong>
              <span className="fine">
                {!c.enabled
                  ? "Off. Requests come to you."
                  : c.capNaira === null
                    ? `${naira(c.spentNaira)} spent, no cap`
                    : `${naira(c.spentNaira)} of ${naira(c.capNaira)}`}
              </span>
            </div>
            {c.enabled && c.capNaira !== null && (
              <Meter
                used={c.spentNaira}
                of={c.capNaira}
                label={`${CATEGORY_NAMES[c.category]} spent against its monthly cap`}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  });

export function Activity({
  orders,
  config,
  limit,
}: {
  orders: OrderRow[];
  config: AppConfig;
  limit?: number;
}) {
  const rows = limit ? orders.slice(0, limit) : orders;
  if (rows.length === 0) {
    return (
      <p className="empty">
        Nothing yet. When your family asks the assistant to pay a bill, it shows up here within
        seconds.
      </p>
    );
  }
  return (
    <ul className="activity">
      {rows.map((order) => {
        const st = statusLabel(order.status);
        const receipt = receiptUrl(config, order);
        return (
          <li key={order.id}>
            <div>
              <strong>
                {CATEGORY_NAMES[order.category] ?? order.category}, {order.label}
              </strong>
              <div className="fine">
                {order.who}, {when(order.createdAt)}
              </div>
              {order.note && order.status !== "fulfilled" && (
                <div className="fine note">{order.note}</div>
              )}
            </div>
            <div className="act-right">
              <strong className="num">{order.amountNgn}</strong>
              {order.amountUsd !== "?" && <span className="fine">about {order.amountUsd}</span>}
              <span className={`pill ${st.tone}`}>{st.text}</span>
              {receipt && (
                <a className="fine" href={receipt} target="_blank" rel="noreferrer">
                  Receipt
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function Home({
  familyId,
  state,
  config,
  onChange,
  go,
}: {
  familyId: string;
  state: FamilyState;
  config: AppConfig;
  onChange: () => void;
  go: (v: "inbox" | "receipts" | "topup") => void;
}) {
  const { overview: o, orders, approvals, proposals, team } = state;
  const waiting = approvals.length + proposals.length;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const toggleFreeze = async () => {
    setBusy(true);
    setNotice("");
    try {
      const r = await api<ChangeResult>(`/api/families/${familyId}/freeze`, {
        body: { frozen: !o.frozen },
      });
      if (r.waiting) setNotice(waitingNotice(r.needed));
      onChange();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>{o.senderName}'s family</h1>
        <span className={`pill ${o.frozen ? "bad" : "ok"}`}>{o.frozen ? "Frozen" : "Active"}</span>
      </div>

      {waiting > 0 && (
        <button type="button" className="needs dogear" onClick={() => go("inbox")}>
          <strong>
            {waiting === 1
              ? "1 request is waiting for you"
              : `${waiting} requests are waiting for you`}
          </strong>
          <span>Open your inbox</span>
        </button>
      )}

      <Ledger o={o} />
      <BillMeters o={o} />

      <section aria-labelledby="recent-h">
        <div className="section-head">
          <h2 id="recent-h">Recent payments</h2>
          {orders.length > 0 && (
            <button type="button" className="link" onClick={() => go("receipts")}>
              All receipts
            </button>
          )}
        </div>
        <Activity orders={orders} config={config} limit={6} />
      </section>

      <section className="home-actions" aria-label="Account actions">
        <button
          type="button"
          className={`btn ${o.frozen ? "" : "stop"}`}
          disabled={busy}
          onClick={toggleFreeze}
        >
          {o.frozen ? "Unfreeze payments" : "Freeze everything"}
        </button>
        <button type="button" className="btn quiet" onClick={() => go("topup")}>
          Add money
        </button>
        {notice && (
          <p role="status" className="note-box">
            {notice}
          </p>
        )}
        {!o.frozen && (
          <p className="fine">
            Freezing refuses every new payment and cancels anything waiting for you.
            {team.members.length > 1 &&
              " Any relative can freeze. Unfreezing takes the signatures you set."}
          </p>
        )}
      </section>
    </div>
  );
}
