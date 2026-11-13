import { useState } from "react";
import { Icon } from "../../ui/Icon.js";
import { LoadingButton, Modal } from "../../ui/Modal.js";
import { api } from "../api.js";
import { CATEGORY_NAMES, naira } from "../format.js";
import type { AppConfig, ChangeResult, Overview, Team } from "../types.js";
import { waitingNotice } from "./Home.js";

const THRESHOLDS = [5_000, 10_000, 20_000, 50_000];

/**
 * The rules, in the two layers they really have: hard limits that are
 * signed into the account and can't be changed here, and soft rules that
 * can. A soft rule applies the moment it's changed, or waits for relatives'
 * signatures when the family asks for more than one.
 */
type Editing = { kind: "bill"; category: string } | { kind: "ask" } | { kind: "preset" } | null;

export function Rules({
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
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  /** Sends a change. Throws on failure, so the open dialog can show why. */
  const apply = async (path: string, body: object) => {
    const r = await api<ChangeResult>(`/api/families/${familyId}/${path}`, { body });
    setNotice(r.waiting ? waitingNotice(r.needed) : "");
    onChange();
  };
  const close = () => setEditing(null);
  const bill =
    editing?.kind === "bill"
      ? o.categories.find((c) => c.category === editing.category)
      : undefined;
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Rules</h1>
        <button type="button" className="btn quiet" onClick={() => setEditing({ kind: "preset" })}>
          Apply a preset
        </button>
      </div>
      {team.required > 1 && (
        <p className="note-box">
          Changes here wait for {team.required} relatives to sign before they take effect.
        </p>
      )}
      {notice && (
        <p role="status" className="note-box">
          {notice}
        </p>
      )}

      <section className="locked" aria-labelledby="hard-h">
        <div className="locked-head">
          <Icon name="lock" />
          <h2 id="hard-h">Hard limits</h2>
        </div>
        <p className="locked-figure">
          ${o.budget.monthlyUsd} a month, {o.budget.perPaymentMaxUsd} at most per payment
        </p>
        <p className="fine">
          These are signed into the family account when you fund it, so even a bug on our side can't
          go past them. Changing them takes a fresh signature, which comes with top-ups.
        </p>
      </section>

      <section aria-labelledby="bills-h2" className="stack">
        <h2 id="bills-h2">Each bill</h2>
        <p className="fine">
          Turn a bill off and requests for it come to you. A cap stops it for the month.
        </p>
        <ul className="rule-list">
          {o.categories.map((c) => {
            const name = CATEGORY_NAMES[c.category] ?? c.category;
            return (
              <li key={`${c.category}-${o.rulesVersion}`} className="rule-row">
                <div>
                  <strong>{name}</strong>{" "}
                  <span className={`pill ${c.enabled ? "ok" : "wait"}`}>
                    {c.enabled ? "On" : "Off"}
                  </span>
                  <p className="fine">
                    {c.enabled
                      ? `${c.capNaira === null ? "No monthly cap" : `Cap ${naira(c.capNaira)} a month`}. ${naira(c.spentNaira)} spent so far.`
                      : `Requests for ${name.toLowerCase()} come to you.`}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn quiet small"
                  aria-label={`Edit ${name} rule`}
                  onClick={() => setEditing({ kind: "bill", category: c.category })}
                >
                  Edit
                </button>
              </li>
            );
          })}
          <li className="rule-row">
            <div>
              <strong>Ask me above</strong>
              <p className="fine">
                {o.approvalAboveNaira === null
                  ? "Never. Every payment inside the other rules goes ahead."
                  : `A single payment above ${naira(o.approvalAboveNaira)} needs your yes first.`}
              </p>
            </div>
            <button
              type="button"
              className="btn quiet small"
              aria-label="Edit the approval amount"
              onClick={() => setEditing({ kind: "ask" })}
            >
              Edit
            </button>
          </li>
        </ul>
      </section>

      <Modal
        open={bill !== undefined}
        title={bill ? `${CATEGORY_NAMES[bill.category] ?? bill.category} rule` : ""}
        onClose={close}
      >
        {bill && <BillForm rule={bill} apply={apply} onDone={close} />}
      </Modal>
      <Modal open={editing?.kind === "ask"} title="Ask me above" onClose={close}>
        <AskForm value={o.approvalAboveNaira} apply={apply} onDone={close} />
      </Modal>
      <Modal open={editing?.kind === "preset"} title="Apply a preset" onClose={close}>
        <PresetForm presets={config.presets} apply={apply} onDone={close} />
      </Modal>
    </div>
  );
}

type Apply = (path: string, body: object) => Promise<void>;

/** Runs one save: shows the spinner, closes on success, explains on failure. */
function useSave(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Footer({
  error,
  onCancel,
  children,
}: {
  error: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn quiet" onClick={onCancel}>
          Cancel
        </button>
        {children}
      </div>
    </>
  );
}

function BillForm({
  rule,
  apply,
  onDone,
}: {
  rule: Overview["categories"][number];
  apply: Apply;
  onDone: () => void;
}) {
  const startCap = rule.capNaira === null ? "" : String(rule.capNaira);
  const [enabled, setEnabled] = useState(rule.enabled);
  const [cap, setCap] = useState(startCap);
  const { busy, error, run } = useSave(onDone);
  const name = CATEGORY_NAMES[rule.category] ?? rule.category;
  const changed = enabled !== rule.enabled || cap !== startCap;
  const save = () =>
    run(() =>
      apply("rules", {
        categories: {
          [rule.category]: {
            ...(enabled !== rule.enabled ? { enabled } : {}),
            ...(cap !== startCap ? { capNaira: cap === "" ? null : Number(cap) } : {}),
          },
        },
      }),
    );
  return (
    <div className="stack">
      <label className="switch">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="track" aria-hidden="true" />
        <span>
          <strong>{enabled ? `${name} is on` : `${name} is off`}</strong>
          <span className="fine"> {naira(rule.spentNaira)} spent this month</span>
        </span>
      </label>
      <label className="field">
        Monthly cap (₦)
        <input
          inputMode="numeric"
          placeholder="No cap"
          value={cap}
          disabled={!enabled}
          onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ""))}
        />
        <span className="hint">Leave empty for no cap.</span>
      </label>
      {!enabled && <p className="fine">Off. Requests for {name.toLowerCase()} come to you.</p>}
      <Footer error={error} onCancel={onDone}>
        <LoadingButton
          loading={busy}
          disabled={!changed}
          label="Save changes"
          loadingLabel="Saving…"
          onClick={save}
        />
      </Footer>
    </div>
  );
}

function AskForm({
  value,
  apply,
  onDone,
}: {
  value: number | null;
  apply: Apply;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  const [text, setText] = useState(value === null ? "" : String(value));
  const { busy, error, run } = useSave(onDone);
  const pick = (n: number | null) => {
    setDraft(n);
    setText(n === null ? "" : String(n));
  };
  return (
    <div className="stack">
      <p className="fine">A single payment above this amount needs your yes first.</p>
      <fieldset className="quick">
        <legend className="visually-hidden">Common amounts</legend>
        {THRESHOLDS.map((n) => (
          <button
            key={n}
            type="button"
            className={`chip-btn ${draft === n ? "on" : ""}`}
            aria-pressed={draft === n}
            onClick={() => pick(n)}
          >
            {naira(n)}
          </button>
        ))}
        <button
          type="button"
          className={`chip-btn ${draft === null ? "on" : ""}`}
          aria-pressed={draft === null}
          onClick={() => pick(null)}
        >
          Never ask
        </button>
      </fieldset>
      <label className="field">
        Another amount (₦)
        <input
          inputMode="numeric"
          placeholder="Never ask"
          value={text}
          onChange={(e) => {
            const t = e.target.value.replace(/[^\d]/g, "");
            setText(t);
            setDraft(t === "" ? null : Number(t));
          }}
        />
      </label>
      <Footer error={error} onCancel={onDone}>
        <LoadingButton
          loading={busy}
          disabled={draft === value}
          label="Save changes"
          loadingLabel="Saving…"
          onClick={() => run(() => apply("rules", { approvalAboveNaira: draft }))}
        />
      </Footer>
    </div>
  );
}

function PresetForm({
  presets,
  apply,
  onDone,
}: {
  presets: AppConfig["presets"];
  apply: Apply;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState("");
  const { busy, error, run } = useSave(onDone);
  return (
    <div className="stack">
      <p className="fine">
        This replaces the bill rules and the amount above. Your monthly budget isn't touched.
      </p>
      <fieldset className="choices" disabled={busy}>
        <legend className="visually-hidden">Preset</legend>
        {presets.map((p) => (
          <label key={p.name} className={`choice ${picked === p.name ? "on" : ""}`}>
            <input
              type="radio"
              name="preset"
              value={p.name}
              checked={picked === p.name}
              onChange={() => setPicked(p.name)}
            />
            <strong>{p.label}</strong>
            <span>{p.about}</span>
          </label>
        ))}
      </fieldset>
      <Footer error={error} onCancel={onDone}>
        <LoadingButton
          loading={busy}
          disabled={picked === ""}
          label="Apply preset"
          loadingLabel="Applying…"
          onClick={() => run(() => apply("preset", { preset: picked }))}
        />
      </Footer>
    </div>
  );
}
