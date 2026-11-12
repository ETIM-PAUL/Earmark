import type { Receipt } from "@earmark/shared";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { lagosTime, ReceiptCard, S } from "./receipt-card.js";
import {
  EXPLORER,
  getFamilyReceipts,
  LOCAL_RPC,
  parseNetwork,
  type TxCheck,
  verifyReceiptTx,
} from "./receipts.js";

// Judge view: one demo family in three panes. The sender's app, the
// recipient's chat (from the bot, long numbers masked), and the chain,
// where every receipt's transaction is checked on-chain by this page.
//
//   /judge.html?family=<fam_…>&contract=<account>&network=testnet&bot=http://localhost:4003
//
// `pnpm start:bot` prints this link for its demo family.

const params = new URLSearchParams(location.search);
const network = parseNetwork(params.get("network"));
const contractId = params.get("contract") ?? import.meta.env.VITE_RECEIPTS_CONTRACT_ID ?? "";
const familyId = params.get("family") ?? "";
const botUrl = (params.get("bot") ?? "http://localhost:4003").replace(/\/+$/, "");

type Line = { from: "recipient" | "bot"; text: string; at: string };
type Demo = { transcript: Line[]; receipts: { orderId: string; txHash: string }[] };

function useEvery<T>(ms: number, load: () => Promise<T>): { value?: T; error?: string } {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    let stop = false;
    const tick = () =>
      load()
        .then((value) => !stop && setState({ value }))
        .catch((e) => !stop && setState((s) => ({ ...s, error: String(e) })));
    void tick();
    const id = setInterval(tick, ms);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [ms, load]);
  return state;
}

const loadDemo = async (): Promise<Demo> => {
  const res = await fetch(`${botUrl}/demo/family?family=${familyId}`);
  if (!res.ok) throw new Error(`bot HTTP ${res.status}`);
  return (await res.json()) as Demo;
};
const loadChain = () => getFamilyReceipts(network, contractId, familyId);

interface Card {
  orderId: string;
  what: string;
  who: string;
  customerName: string;
  amountNgn: string;
  amountUsd: string;
  reasons: string[];
  expiresAt: string;
}
interface SenderState {
  overview: {
    senderName: string;
    frozen: boolean;
    rulesVersion: number;
    approvalAboveNaira: number | null;
    categories: { category: string; enabled: boolean; capNaira: number | null }[];
  };
  approvals: Card[];
  presets: { name: string; label: string; about: string }[];
}
const loadSender = async (): Promise<SenderState> => {
  const res = await fetch(`${botUrl}/sender/state?family=${familyId}`);
  if (!res.ok) throw new Error(`bot HTTP ${res.status}`);
  return (await res.json()) as SenderState;
};
const post = (path: string, body: object) =>
  fetch(`${botUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const btn = { padding: "6px 12px", borderRadius: 8, fontSize: 13 } as const;

/** The sender's side: requests waiting for a yes, freeze, and rule presets. */
function SenderPanel() {
  const { value: st, error } = useEvery(2_000, loadSender);
  const [note, setNote] = useState("");
  if (!st) return <p style={S.muted}>{error ? "The sender side isn't reachable." : "Loading…"}</p>;
  const { overview: o, approvals } = st;
  const decide = async (orderId: string, decision: "approved" | "declined") => {
    const res = await post("/sender/decide", { orderId, decision });
    setNote(res?.ok ? "" : "That request is no longer waiting.");
  };
  return (
    <div style={{ display: "grid", gap: 10, fontSize: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>
          <strong>{o.senderName}'s account</strong>{" "}
          <span style={o.frozen ? S.warn : S.ok}>{o.frozen ? "frozen" : "active"}</span>
        </span>
        <button
          type="button"
          style={btn}
          onClick={() => void post("/sender/freeze", { family: familyId, frozen: !o.frozen })}
        >
          {o.frozen ? "Unfreeze" : "Freeze everything"}
        </button>
      </div>

      <div style={{ ...S.card, padding: 12 }}>
        <strong>Waiting for you ({approvals.length})</strong>
        {approvals.length === 0 && (
          <p style={{ ...S.muted, margin: "6px 0 0" }}>
            Nothing yet. Ask for more than{" "}
            {o.approvalAboveNaira ? naira(o.approvalAboveNaira) : "the limit"} in the recipient
            chat, e.g. "buy 25k light for my meter", then "yes".
          </p>
        )}
        {approvals.map((c) => (
          <div
            key={c.orderId}
            style={{ borderTop: "1px solid #e4e4e7", marginTop: 8, paddingTop: 8 }}
          >
            <div>
              <strong>{c.amountNgn}</strong> <span style={S.muted}>(about ${c.amountUsd})</span>
            </div>
            <div>
              {c.what} · {c.customerName} · {c.who}
            </div>
            <ul style={{ margin: "4px 0", paddingLeft: 18, ...S.warn }}>
              {c.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={btn} onClick={() => void decide(c.orderId, "approved")}>
                Approve
              </button>
              <button type="button" style={btn} onClick={() => void decide(c.orderId, "declined")}>
                Decline
              </button>
            </div>
          </div>
        ))}
        {note && <p role="alert">{note}</p>}
      </div>

      <div style={{ ...S.card, padding: 12 }}>
        <strong>Rules</strong> <span style={S.muted}>v{o.rulesVersion}</span>
        <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
          {o.categories.map((c) => (
            <li key={c.category}>
              {c.category}:{" "}
              {c.enabled
                ? c.capNaira === null
                  ? "on, no cap"
                  : `on, ${naira(c.capNaira)} a month`
                : "off"}
            </li>
          ))}
          <li>
            asks you above {o.approvalAboveNaira === null ? "(never)" : naira(o.approvalAboveNaira)}
          </li>
        </ul>
        <select
          aria-label="Apply a rule preset"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value)
              void post("/sender/preset", { family: familyId, preset: e.target.value });
            e.target.value = "";
          }}
          style={{ padding: 6, borderRadius: 8 }}
        >
          <option value="">Apply a preset…</option>
          {st.presets.map((p) => (
            <option key={p.name} value={p.name} title={p.about}>
              {p.label}: {p.about}
            </option>
          ))}
        </select>
      </div>
      <p style={{ ...S.muted, margin: 0 }}>
        Demo: the demo owner signs your decisions. The real sender app signs with a NEAR or EVM
        wallet.
      </p>
    </div>
  );
}

function Pane({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        border: "1px solid #e4e4e7",
        borderRadius: 12,
        background: "#fafafa",
        overflow: "hidden",
      }}
    >
      <h2
        style={{
          fontSize: 14,
          margin: 0,
          padding: "10px 14px",
          borderBottom: "1px solid #e4e4e7",
          background: "#fff",
        }}
      >
        {title}
      </h2>
      <div style={{ flex: 1, overflow: "auto", padding: 12 }}>{children}</div>
    </section>
  );
}

/** Local demo only: type as the recipient. Real chats are Telegram and WhatsApp. */
function Say() {
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const send = async (t: string) => {
    if (!t.trim()) return;
    setText("");
    const res = await fetch(`${botUrl}/demo/say`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ family: familyId, text: t }),
    }).catch(() => null);
    setFailed(!res?.ok);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send(text);
      }}
      style={{ display: "grid", gap: 6, marginTop: 12 }}
    >
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type as the recipient…"
          aria-label="Message the bot as the recipient"
          style={{
            flex: 1,
            padding: 8,
            borderRadius: 8,
            border: "1px solid #d4d4d8",
            fontSize: 14,
          }}
        />
        <button type="submit" style={{ padding: "8px 14px", borderRadius: 8 }}>
          Send
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[
          "abeg buy 5k light for my meter",
          "buy 500 naira airtime for my line",
          "yes",
          "how much remain?",
        ].map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => void send(t)}
            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 12 }}
          >
            {t}
          </button>
        ))}
      </div>
      {failed && <span role="alert">The bot didn't take that message.</span>}
    </form>
  );
}

function Chat({ demo }: { demo: { value?: Demo; error?: string } }) {
  if (demo.error && !demo.value)
    return <p role="alert">Can't reach the bot at {botUrl}: is it running?</p>;
  const lines = demo.value?.transcript ?? [];
  if (lines.length === 0)
    return (
      <>
        <p style={S.muted}>Open the invite link and message the bot. The chat appears here.</p>
        {LOCAL_RPC && <Say />}
      </>
    );
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {lines.map((l) => (
        <div
          key={`${l.at}${l.from}${l.text.slice(0, 20)}`}
          style={{
            justifySelf: l.from === "recipient" ? "end" : "start",
            maxWidth: "85%",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            padding: "8px 10px",
            borderRadius: 10,
            background: l.from === "recipient" ? "#dcf8c6" : "#fff",
            border: "1px solid #e4e4e7",
            fontSize: 14,
          }}
        >
          {l.text}
          <div style={{ ...S.muted, fontSize: 11, marginTop: 2 }}>
            {lagosTime(Date.parse(l.at))}
          </div>
        </div>
      ))}
      {LOCAL_RPC && <Say />}
    </div>
  );
}

function Chain({
  receipts,
  demo,
}: {
  receipts: { value?: Receipt[]; error?: string };
  demo?: Demo | undefined;
}) {
  const [checks, setChecks] = useState<Record<string, TxCheck | "checking">>({});
  const txOf = (orderId: string) =>
    demo?.receipts.find((r) => r.orderId === orderId)?.txHash ?? null;
  useEffect(() => {
    for (const r of receipts.value ?? []) {
      const tx = txOf(r.orderId);
      if (!tx || checks[r.orderId]) continue;
      setChecks((c) => ({ ...c, [r.orderId]: "checking" }));
      verifyReceiptTx(network, contractId, tx, r.orderId)
        .then((v) => setChecks((c) => ({ ...c, [r.orderId]: v })))
        .catch((e) =>
          setChecks((c) => ({ ...c, [r.orderId]: { verified: false, why: String(e) } })),
        );
    }
  });
  if (receipts.error && !receipts.value) return <p role="alert">{receipts.error}</p>;
  if (!receipts.value) return <p>Reading the contract…</p>;
  if (receipts.value.length === 0)
    return <p style={S.muted}>No receipts yet. Each payment lands here within seconds.</p>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {receipts.value.map((r) => (
        <ReceiptCard
          key={r.orderId}
          r={r}
          network={network}
          txHash={txOf(r.orderId)}
          check={checks[r.orderId]}
          compact
        />
      ))}
    </div>
  );
}

function Judge() {
  const demo = useEvery(2_000, loadDemo);
  const receipts = useEvery(3_000, loadChain);
  if (!familyId || !contractId)
    return <p role="alert">Open the judge link that pnpm start:bot (or make demo) prints.</p>;
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        height: "100vh",
        boxSizing: "border-box",
        padding: 12,
        display: "grid",
        gridTemplateRows: "auto 1fr",
        gap: 12,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <strong>Earmark · one family, three views</strong>
        <span style={S.muted}>
          {familyId} · contract{" "}
          {LOCAL_RPC ? (
            <>{contractId} on a local chain (demo)</>
          ) : (
            <>
              <a href={`${EXPLORER[network]}/address/${contractId}`}>{contractId}</a> on NEAR{" "}
              {network}
            </>
          )}
        </span>
      </header>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 12,
          minHeight: 0,
        }}
      >
        <Pane title="Sender app (abroad)">
          <SenderPanel />
          <p style={{ ...S.muted, marginTop: 16 }}>
            The sender's receipts feed, read from the chain:
          </p>
          <iframe
            title="Receipts feed"
            src={`/receipt.html?network=${network}&contract=${contractId}&family=${familyId}${LOCAL_RPC ? `&rpc=${encodeURIComponent(LOCAL_RPC)}` : ""}`}
            style={{ width: "100%", height: 480, border: 0, background: "#fff", borderRadius: 8 }}
          />
        </Pane>
        <Pane title="Recipient chat (Nigeria)">
          <Chat demo={demo} />
        </Pane>
        <Pane title="NEAR explorer (public)">
          <Chain receipts={receipts} demo={demo.value} />
        </Pane>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Judge />
  </StrictMode>,
);
