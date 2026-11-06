import type { Receipt } from "@earmark/shared";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { lagosTime, ReceiptCard, S } from "./receipt-card.js";
import {
  EXPLORER,
  getFamilyReceipts,
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

function Chat({ demo }: { demo: { value?: Demo; error?: string } }) {
  if (demo.error && !demo.value)
    return <p role="alert">Can't reach the bot at {botUrl}: is pnpm start:bot running?</p>;
  const lines = demo.value?.transcript ?? [];
  if (lines.length === 0)
    return <p style={S.muted}>Open the invite link and message the bot. The chat appears here.</p>;
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
    return <p role="alert">Open the judge link that pnpm start:bot prints.</p>;
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
          <a href={`${EXPLORER[network]}/address/${contractId}`}>{contractId}</a> on NEAR {network}
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
          <iframe
            title="Sender app"
            src="/"
            style={{ width: "100%", height: 280, border: 0, background: "#fff", borderRadius: 8 }}
          />
          <p style={S.muted}>The sender's receipts feed, read from the chain:</p>
          <iframe
            title="Receipts feed"
            src={`/receipt.html?network=${network}&contract=${contractId}&family=${familyId}`}
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
