import { useState } from "react";
import { api } from "../api.js";
import { timeLeft } from "../format.js";
import { decide, signProposal } from "../passkey.js";
import type { ApprovalCard, Proposal } from "../types.js";

/** "1 of 2 relatives have signed: Ada" */
const progress = (signedBy: string[], needed: number) =>
  `${signedBy.length} of ${needed} relatives have signed${signedBy.length ? `: ${signedBy.join(", ")}` : ""}`;

export function Inbox({
  familyId,
  cards,
  proposals,
  onChange,
}: {
  familyId: string;
  cards: ApprovalCard[];
  proposals: Proposal[];
  onChange: () => void;
}) {
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Inbox</h1>
      </div>
      {cards.length === 0 && proposals.length === 0 && (
        <p className="empty">
          Nothing is waiting. When a request is outside your rules, it comes here for your yes or
          no, and you confirm with your fingerprint, face or PIN.
        </p>
      )}
      {cards.length > 0 && (
        <section aria-labelledby="pay-h" className="stack">
          <h2 id="pay-h">Payments waiting for you</h2>
          {cards.map((c) => (
            <ApprovalItem key={c.orderId} card={c} onChange={onChange} />
          ))}
        </section>
      )}
      {proposals.length > 0 && (
        <section aria-labelledby="chg-h" className="stack">
          <h2 id="chg-h">Changes waiting for signatures</h2>
          {proposals.map((p) => (
            <ProposalItem key={p.id} familyId={familyId} proposal={p} onChange={onChange} />
          ))}
        </section>
      )}
    </div>
  );
}

export function ApprovalItem({ card, onChange }: { card: ApprovalCard; onChange: () => void }) {
  const [busy, setBusy] = useState<"approved" | "declined" | null>(null);
  const [error, setError] = useState("");
  const answer = async (decision: "approved" | "declined") => {
    setBusy(decision);
    setError("");
    try {
      await decide(card.orderId, decision);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      onChange();
    }
  };
  return (
    <article className="request dogear">
      <p className="request-amount">{card.amountNgn}</p>
      <p className="fine">about {card.amountUsd}</p>
      <p className="request-what">{card.what}</p>
      <p className="fine">
        {card.customerName}, {card.who}
      </p>
      <ul className="reasons">
        {card.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {card.needed > 1 && <p className="fine">{progress(card.signedBy, card.needed)}.</p>}
      <p className="fine">Cancels itself {timeLeft(card.expiresAt)} if nobody answers.</p>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="actions">
        {card.youSigned ? (
          <p className="fine">You approved. Waiting for another relative.</p>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => answer("approved")}
          >
            {busy === "approved" ? "Confirm on your device…" : "Approve"}
          </button>
        )}
        <button
          type="button"
          className="btn quiet"
          disabled={busy !== null}
          onClick={() => answer("declined")}
        >
          {busy === "declined" ? "Confirm on your device…" : "Decline"}
        </button>
      </div>
    </article>
  );
}

function ProposalItem({
  familyId,
  proposal: p,
  onChange,
}: {
  familyId: string;
  proposal: Proposal;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  };
  return (
    <article className="request dogear">
      <p className="request-what">{p.summary}</p>
      <p className="fine">{p.proposedBy} suggested this.</p>
      <p className="fine">
        {progress(p.signedBy, p.needed)}. Cancels itself {timeLeft(p.expiresAt)}.
      </p>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="actions">
        {p.youSigned ? (
          <p className="fine">You signed. Waiting for another relative.</p>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => act(() => signProposal(familyId, p.id))}
          >
            {busy ? "Confirm on your device…" : "Sign"}
          </button>
        )}
        <button
          type="button"
          className="btn quiet"
          disabled={busy}
          onClick={() =>
            act(() => api(`/api/families/${familyId}/proposals/${p.id}/cancel`, { body: {} }))
          }
        >
          Turn down
        </button>
      </div>
    </article>
  );
}
