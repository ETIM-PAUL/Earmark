import { useState } from "react";
import { api } from "./api.js";
import { CATEGORY_NAMES, naira, statusLabel, timeLeft, usdToNaira } from "./format.js";
import { decide, signProposal } from "./passkey.js";
import type {
  AppConfig,
  ApprovalCard,
  ChangeResult,
  FamilyState,
  Invite,
  OrderRow,
  Overview,
  Proposal,
  Team,
} from "./types.js";
import { usePoll } from "./usePoll.js";

type Tab = "home" | "approvals" | "rules" | "topup";

export function Dashboard({
  familyId,
  config,
  firstInvite,
}: {
  familyId: string;
  config: AppConfig;
  firstInvite: Invite | null;
}) {
  const [tab, setTab] = useState<Tab>("home");
  const {
    value: state,
    error,
    refresh,
  } = usePoll(() => api<FamilyState>(`/api/families/${familyId}/state`), 3_000);
  if (!state) {
    return <p className="muted center">{error ? error.message : "Loading your family…"}</p>;
  }
  const waiting = state.approvals.length + state.proposals.length;
  return (
    <>
      {state.overview.frozen && (
        <p role="status" className="banner bad">
          Frozen. Nothing can be paid until you unfreeze.
        </p>
      )}
      <div className="view">
        {tab === "home" && (
          <Home
            familyId={familyId}
            state={state}
            config={config}
            invite={firstInvite}
            onChange={refresh}
            goApprovals={() => setTab("approvals")}
          />
        )}
        {tab === "approvals" && (
          <Approvals
            familyId={familyId}
            cards={state.approvals}
            proposals={state.proposals}
            onChange={refresh}
          />
        )}
        {tab === "rules" && (
          <Rules
            familyId={familyId}
            overview={state.overview}
            team={state.team}
            config={config}
            onChange={refresh}
          />
        )}
        {tab === "topup" && <TopUp config={config} overview={state.overview} />}
      </div>
      <nav className="tabs" aria-label="Sections">
        {(
          [
            ["home", "Home"],
            ["approvals", "Approvals"],
            ["rules", "Rules"],
            ["topup", "Top up"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "on" : ""}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "approvals" && waiting > 0 && <span className="badge">{waiting}</span>}
          </button>
        ))}
      </nav>
    </>
  );
}

/** The public receipt page for one payment: it reads the chain and checks the transaction itself. */
function receiptUrl(config: AppConfig, o: OrderRow): string | null {
  if (!config.contractId || !o.receiptTxHash) return null;
  const q = new URLSearchParams({
    network: config.network,
    contract: config.contractId,
    order: o.id,
    tx: o.receiptTxHash,
  });
  if (config.rpcUrl) q.set("rpc", config.rpcUrl);
  return `/receipt.html?${q}`;
}

/** Naira and dollars side by side: the sender thinks in dollars, the recipient in naira. */
function Money({ usd, ngn }: { usd: string; ngn: string | null }) {
  return (
    <span className="money">
      <strong>{usd}</strong>
      {ngn && <span className="muted"> ≈ {ngn}</span>}
    </span>
  );
}

// ── Home ───────────────────────────────────────────────────────────────

function Home({
  familyId,
  state,
  config,
  invite,
  onChange,
  goApprovals,
}: {
  familyId: string;
  state: FamilyState;
  config: AppConfig;
  invite: Invite | null;
  onChange: () => void;
  goApprovals: () => void;
}) {
  const { overview: o, orders, approvals, proposals, team } = state;
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
    <div className="stack">
      <section className="card">
        <p className="muted">Budget left this month</p>
        <p className="big">
          <Money usd={o.budget.leftUsd} ngn={usdToNaira(o.budget.leftUsd, o.rateNgnPerUsd)} />
        </p>
        <p className="muted">
          of {`$${o.budget.monthlyUsd}`} · {o.budget.spentUsd} spent · {o.budget.perPaymentMaxUsd}{" "}
          most per payment
        </p>
        {o.rateNgnPerUsd && (
          <p className="muted small">Rate ₦{o.rateNgnPerUsd} per $1, before fees.</p>
        )}
      </section>

      {approvals.length + proposals.length > 0 && (
        <button type="button" className="banner wait" onClick={goApprovals}>
          {approvals.length + proposals.length === 1
            ? "1 request is waiting for you"
            : `${approvals.length + proposals.length} requests are waiting for you`}{" "}
          →
        </button>
      )}

      <section className="card stack">
        <h2>Recent payments</h2>
        {orders.length === 0 ? (
          <p className="muted">
            Nothing yet. When {o.recipientPhone === "?" ? "your family" : "they"} ask the assistant
            to pay a bill, it shows up here within seconds.
          </p>
        ) : (
          <ul className="list">
            {orders.map((order) => (
              <OrderItem key={order.id} order={order} receipt={receiptUrl(config, order)} />
            ))}
          </ul>
        )}
      </section>

      {invite && <InviteCard invite={invite} />}
      <RecipientCard familyId={familyId} overview={o} />
      <TeamCard familyId={familyId} team={team} onChange={onChange} />

      <button
        type="button"
        className={o.frozen ? "primary" : "danger"}
        disabled={busy}
        onClick={toggleFreeze}
      >
        {o.frozen ? "Unfreeze payments" : "Freeze everything"}
      </button>
      {notice && (
        <p role="status" className="banner wait">
          {notice}
        </p>
      )}
      {!o.frozen && (
        <p className="muted small center">
          Freezing refuses every new payment and cancels anything waiting for you.
          {team.members.length > 1 && " Any relative can freeze; unfreezing needs the signatures."}
        </p>
      )}
    </div>
  );
}

function OrderItem({ order, receipt }: { order: OrderRow; receipt: string | null }) {
  const st = statusLabel(order.status);
  const when = new Date(order.createdAt).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  });
  return (
    <li className="order">
      <div>
        <strong>
          {CATEGORY_NAMES[order.category] ?? order.category} · {order.label}
        </strong>
        <div className="muted small">
          {order.who} · {when}
        </div>
        {order.note && order.status !== "fulfilled" && (
          <div className="small note">{order.note}</div>
        )}
      </div>
      <div className="right">
        <div>
          <strong>{order.amountNgn}</strong>
        </div>
        <div className="muted small">{order.amountUsd !== "?" ? `≈ ${order.amountUsd}` : ""}</div>
        <span className={`chip ${st.tone}`}>{st.text}</span>
        {receipt && (
          <div className="small">
            <a href={receipt} target="_blank" rel="noreferrer">
              Receipt
            </a>
          </div>
        )}
      </div>
    </li>
  );
}

function InviteCard({ invite }: { invite: Invite }) {
  const [copied, setCopied] = useState(false);
  const link = invite.telegram ?? invite.whatsapp;
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // the link is on screen to copy by hand
    }
  };
  return (
    <section className="card stack">
      <h2>Connect their phone</h2>
      <p className="muted">
        Send them this link. When they open it, the assistant is connected to your family. It works
        once and expires {new Date(invite.expiresAt).toLocaleDateString("en-GB")}.
      </p>
      <div className="actions">
        {invite.telegram && (
          <a className="button" href={invite.telegram}>
            Telegram link
          </a>
        )}
        {invite.whatsapp && (
          <a className="button" href={invite.whatsapp}>
            WhatsApp link
          </a>
        )}
        {link && (
          <button type="button" className="ghost" onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
        )}
        {invite.judge && (
          <a className="button ghost" href={invite.judge} target="_blank" rel="noreferrer">
            Open the demo chat
          </a>
        )}
      </div>
      {!link && !invite.judge && (
        <p className="muted">Chat links need the bot's Telegram or WhatsApp keys.</p>
      )}
    </section>
  );
}

function RecipientCard({ familyId, overview: o }: { familyId: string; overview: Overview }) {
  const [fresh, setFresh] = useState<Invite | null>(null);
  const again = async () =>
    setFresh(await api<Invite>(`/api/families/${familyId}/invite`, { body: {} }));
  return (
    <section className="card stack">
      <h2>Your family</h2>
      <p>
        Recipient <strong>{o.recipientPhone}</strong>
      </p>
      {o.saved.length > 0 && (
        <ul className="list">
          {o.saved.map((s) => (
            <li key={`${s.category}${s.ref}`} className="muted">
              {s.label} · {s.ref}
            </li>
          ))}
        </ul>
      )}
      {fresh ? (
        <InviteCard invite={fresh} />
      ) : (
        <button type="button" className="ghost" onClick={again}>
          New invite link
        </button>
      )}
    </section>
  );
}

const waitingNotice = (needed?: number) =>
  `Sent to your relatives. It takes effect when ${needed ?? "enough"} of you have signed. They'll see it under Approvals.`;

// ── Team ───────────────────────────────────────────────────────────────

/** Relatives who share this family, and how many must sign. */
export function TeamCard({
  familyId,
  team,
  onChange,
}: {
  familyId: string;
  team: Team;
  onChange: () => void;
}) {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const full = team.members.length >= team.maxMembers;
  const run = async (f: () => Promise<void>) => {
    setError("");
    setNotice("");
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const invite = () =>
    run(async () => {
      setCopied(false);
      setCode(await api(`/api/families/${familyId}/members/invite`, { body: {} }));
    });
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
    } catch {
      // the code is on screen to copy by hand
    }
  };
  const setRequired = (n: number) =>
    run(async () => {
      const r = await api<ChangeResult>(`/api/families/${familyId}/policy`, {
        body: { required: n },
      });
      if (r.waiting) setNotice(waitingNotice(r.needed));
      onChange();
    });
  return (
    <section className="card stack">
      <h2>Relatives</h2>
      <ul className="list">
        {team.members.map((m) => (
          <li key={m.id}>
            <strong>{m.name}</strong>
            {m.you && <span className="muted"> (you)</span>}
            {m.isOwner && <span className="muted small"> · set up the family</span>}
          </li>
        ))}
      </ul>
      {team.members.length > 1 && (
        <label>
          Signatures needed for large payments and rule changes
          <select
            value={team.required}
            onChange={(e) => setRequired(Number(e.target.value))}
            aria-label="Signatures needed"
          >
            {team.members.map((m, i) => (
              <option key={m.id} value={i + 1}>
                {i === 0 ? "1 (any one relative)" : `${i + 1} relatives`}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="muted small">
        {team.required > 1
          ? `A payment that needs your approval waits for ${team.required} relatives, each signing with their own passkey. Any one of you can decline it or freeze the account.`
          : "Invite a relative to share this family. You can then ask for more than one signature on large payments and rule changes."}
      </p>
      {team.isOwner && !full && !code && (
        <button type="button" className="ghost" onClick={invite}>
          Add a relative
        </button>
      )}
      {team.isOwner && full && (
        <p className="muted small">The family is full ({team.maxMembers} relatives).</p>
      )}
      {code && (
        <div className="stack">
          <p>
            Give them this code. They create an account, then choose “Join a family”. It works once
            and expires {new Date(code.expiresAt).toLocaleDateString("en-GB")}.
          </p>
          <p className="big code">{code.code}</p>
          <div className="actions">
            <button type="button" className="ghost" onClick={copy}>
              {copied ? "Copied" : "Copy code"}
            </button>
            <button type="button" className="ghost" onClick={() => setCode(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="banner wait">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ── Approvals ──────────────────────────────────────────────────────────

function Approvals({
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
  if (cards.length === 0 && proposals.length === 0) {
    return (
      <section className="card">
        <h2>Nothing waiting</h2>
        <p className="muted">
          When a request is outside your rules, it comes here for your yes or no. You confirm with
          your fingerprint, face or PIN.
        </p>
      </section>
    );
  }
  return (
    <div className="stack">
      {cards.map((c) => (
        <ApprovalItem key={c.orderId} card={c} onChange={onChange} />
      ))}
      {proposals.length > 0 && <h2>Changes waiting for signatures</h2>}
      {proposals.map((p) => (
        <ProposalItem key={p.id} familyId={familyId} proposal={p} onChange={onChange} />
      ))}
    </div>
  );
}

/** "1 of 2 relatives have approved: Ada" */
const progress = (signedBy: string[], needed: number) =>
  `${signedBy.length} of ${needed} relatives have signed${signedBy.length ? `: ${signedBy.join(", ")}` : ""}`;

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
    <section className="card stack approval">
      <p>
        <strong>{p.summary}</strong>
        <br />
        <span className="muted">{p.proposedBy} suggested this.</span>
      </p>
      <p className="muted small">
        {progress(p.signedBy, p.needed)}. Cancels itself {timeLeft(p.expiresAt)}.
      </p>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="actions">
        {p.youSigned ? (
          <p className="muted">You signed. Waiting for another relative.</p>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => act(() => signProposal(familyId, p.id))}
          >
            {busy ? "Confirm on your device…" : "Sign"}
          </button>
        )}
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() =>
            act(() => api(`/api/families/${familyId}/proposals/${p.id}/cancel`, { body: {} }))
          }
        >
          Turn down
        </button>
      </div>
    </section>
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
      onChange();
    } catch (e) {
      setError((e as Error).message);
      onChange();
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card stack approval">
      <div>
        <p className="big">{card.amountNgn}</p>
        <p className="muted">≈ {card.amountUsd}</p>
      </div>
      <p>
        <strong>{card.what}</strong>
        <br />
        <span className="muted">
          {card.customerName} · {card.who}
        </span>
      </p>
      <ul className="reasons">
        {card.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {card.needed > 1 && <p className="muted small">{progress(card.signedBy, card.needed)}.</p>}
      <p className="muted small">Cancels itself {timeLeft(card.expiresAt)} if you don't answer.</p>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="actions">
        {card.youSigned ? (
          <p className="muted">You approved. Waiting for another relative.</p>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={() => answer("approved")}
          >
            {busy === "approved" ? "Confirm on your device…" : "Approve"}
          </button>
        )}
        <button
          type="button"
          className="ghost"
          disabled={busy !== null}
          onClick={() => answer("declined")}
        >
          {busy === "declined" ? "Confirm on your device…" : "Decline"}
        </button>
      </div>
    </section>
  );
}

// ── Rules ──────────────────────────────────────────────────────────────

function Rules({
  familyId,
  overview: o,
  team,
  config,
  onChange,
}: {
  familyId: string;
  overview: Overview;
  team: Team;
  config: AppConfig;
  onChange: () => void;
}) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const send = async (path: string, body: object) => {
    setError("");
    setNotice("");
    try {
      const r = await api<ChangeResult>(`/api/families/${familyId}/${path}`, { body });
      if (r.waiting) setNotice(waitingNotice(r.needed));
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="stack">
      {team.required > 1 && (
        <p className="muted small">
          Changes here wait for {team.required} relatives to sign before they take effect.
        </p>
      )}
      {notice && (
        <p role="status" className="banner wait">
          {notice}
        </p>
      )}
      <section className="card stack">
        <h2>Start from a preset</h2>
        <p className="muted">This replaces the rules below. Your monthly budget isn't touched.</p>
        <div className="choices">
          {config.presets.map((p) => (
            <button
              key={p.name}
              type="button"
              className="choice"
              onClick={() => send("preset", { preset: p.name })}
            >
              <strong>{p.label}</strong>
              <span>{p.about}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card stack">
        <h2>Each bill</h2>
        {o.categories.map((c) => (
          <CategoryRule
            key={`${c.category}-${o.rulesVersion}`}
            rule={c}
            onSave={(patch) => send("rules", { categories: { [c.category]: patch } })}
          />
        ))}
      </section>

      <ThresholdCard
        key={`t-${o.rulesVersion}`}
        value={o.approvalAboveNaira}
        onSave={(v) => send("rules", { approvalAboveNaira: v })}
      />

      <section className="card stack">
        <h2>Your budget</h2>
        <p>
          {`$${o.budget.monthlyUsd}`} a month, {o.budget.perPaymentMaxUsd} at most per payment.
        </p>
        <p className="muted small">
          These limits are signed into your account when you fund it, so even a bug on our side
          can't go past them. Changing them needs a new signature, which comes with top-ups.
        </p>
      </section>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function CategoryRule({
  rule,
  onSave,
}: {
  rule: Overview["categories"][number];
  onSave: (patch: { enabled?: boolean; capNaira?: number | null }) => void;
}) {
  const [cap, setCap] = useState(rule.capNaira === null ? "" : String(rule.capNaira));
  const dirty = cap !== (rule.capNaira === null ? "" : String(rule.capNaira));
  return (
    <div className="rule">
      <label className="switch">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onSave({ enabled: e.target.checked })}
        />
        <span>
          <strong>{CATEGORY_NAMES[rule.category]}</strong>
          <span className="muted small"> {naira(rule.spentNaira)} this month</span>
        </span>
      </label>
      <div className="inline">
        <label>
          Monthly cap (₦)
          <input
            inputMode="numeric"
            placeholder="No cap"
            value={cap}
            onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ""))}
          />
        </label>
        {dirty && (
          <button
            type="button"
            className="ghost"
            onClick={() => onSave({ capNaira: cap === "" ? null : Number(cap) })}
          >
            Save
          </button>
        )}
      </div>
      {!rule.enabled && (
        <p className="muted small">Off: requests for this come to you for approval.</p>
      )}
    </div>
  );
}

function ThresholdCard({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (v: number | null) => void;
}) {
  const [v, setV] = useState(value === null ? "" : String(value));
  const dirty = v !== (value === null ? "" : String(value));
  return (
    <section className="card stack">
      <h2>Ask me above</h2>
      <p className="muted">A single payment above this amount needs your yes first.</p>
      <div className="inline">
        <label>
          Amount (₦)
          <input
            inputMode="numeric"
            placeholder="Never ask"
            value={v}
            onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ""))}
          />
        </label>
        {dirty && (
          <button
            type="button"
            className="ghost"
            onClick={() => onSave(v === "" ? null : Number(v))}
          >
            Save
          </button>
        )}
      </div>
    </section>
  );
}

// ── Top up ─────────────────────────────────────────────────────────────

function TopUp({ config, overview: o }: { config: AppConfig; overview: Overview }) {
  return (
    <div className="stack">
      <section className="card stack">
        <h2>Top up</h2>
        <p role="status" className="banner wait">
          Not available in this build
        </p>
        <p>{config.topUp.why}</p>
        <p className="muted">
          When it is on, you pick a chain and a token, we show a fresh deposit address, and the
          money arrives in your family account as USDC. Nothing is simulated here: no balance is
          shown because there is no real account behind it.
        </p>
      </section>
      <section className="card">
        <h2>What a top-up will cover</h2>
        <p className="muted">
          Your monthly budget is {`$${o.budget.monthlyUsd}`}
          {usdToNaira(`$${o.budget.monthlyUsd}`, o.rateNgnPerUsd)
            ? ` (about ${usdToNaira(`$${o.budget.monthlyUsd}`, o.rateNgnPerUsd)})`
            : ""}
          .
        </p>
      </section>
    </div>
  );
}
