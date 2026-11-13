import { useState } from "react";
import { LoadingButton, Modal } from "../../ui/Modal.js";
import { api } from "../api.js";
import type { ChangeResult, Overview } from "../types.js";
import { waitingNotice } from "./Home.js";

type Kind = "phone" | "meter" | "smartcard";
type Saved = Overview["saved"][number];

const GROUPS: {
  kind: Kind;
  category: string;
  title: string;
  about: string;
  empty: string;
  add: string;
  limit: number;
}[] = [
  {
    kind: "phone",
    category: "airtime",
    title: "Phones for airtime and data",
    about: "The recipient's own phone is always included.",
    empty: "Only the recipient's phone. Add the others you want to top up.",
    add: "Add a phone",
    limit: 10,
  },
  {
    kind: "meter",
    category: "electricity",
    title: "Electricity meters",
    about: "Home, the office, the church: any meter you want paid.",
    empty: "No meters yet.",
    add: "Add a meter",
    limit: 10,
  },
  {
    kind: "smartcard",
    category: "tv",
    title: "TV decoders",
    about: "DStv, GOtv or StarTimes smartcards.",
    empty: "No decoders yet.",
    add: "Add a decoder",
    limit: 5,
  },
];

const DISCOS = [
  "Ikeja",
  "Eko",
  "Abuja",
  "Ibadan",
  "Kano",
  "Port Harcourt",
  "Jos",
  "Kaduna",
  "Enugu",
  "Benin",
  "Aba",
  "Yola",
];
const TV = ["DStv", "GOtv", "StarTimes"];

const EXAMPLE: Record<Kind, string> = {
  phone: "e.g. Uncle Tunde",
  meter: "e.g. Office, Church, Home",
  smartcard: "e.g. Parents' DStv",
};

/**
 * The numbers the family may pay for. The assistant refuses any phone,
 * meter or decoder that isn't here, so this list is what the sender
 * controls. Adding follows the family's signature rule; removing is always
 * immediate.
 */
export function Numbers({
  familyId,
  overview: o,
  onChange,
}: {
  familyId: string;
  overview: Overview;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState<Kind | null>(null);
  const [removing, setRemoving] = useState<Saved | null>(null);
  const [notice, setNotice] = useState("");
  return (
    <section aria-labelledby="numbers-h" className="stack">
      <h2 id="numbers-h">Numbers your family can pay for</h2>
      <p className="fine">
        The assistant only pays for what is listed here. If someone asks for another number, it says
        so and suggests they ask you.
      </p>
      {notice && (
        <p role="status" className="note-box">
          {notice}
        </p>
      )}
      {GROUPS.map((g) => {
        const items = o.saved.filter((s) => s.category === g.category);
        return (
          <div key={g.kind} className="numbers-group">
            <div className="section-head">
              <h3 className="group-h">{g.title}</h3>
              <button
                type="button"
                className="btn quiet small"
                disabled={items.length >= g.limit}
                onClick={() => setAdding(g.kind)}
              >
                {g.add}
              </button>
            </div>
            <p className="fine">{g.about}</p>
            {g.kind === "phone" && (
              <ul className="saved">
                <li>
                  <strong>Recipient</strong>
                  <span className="fine num">{o.recipientPhone}</span>
                </li>
                {items.map((s) => (
                  <Row key={s.id} s={s} onRemove={() => setRemoving(s)} />
                ))}
              </ul>
            )}
            {g.kind !== "phone" &&
              (items.length > 0 ? (
                <ul className="saved">
                  {items.map((s) => (
                    <Row key={s.id} s={s} onRemove={() => setRemoving(s)} />
                  ))}
                </ul>
              ) : (
                <p className="empty">{g.empty}</p>
              ))}
            {items.length >= g.limit && (
              <p className="fine">The list is full. Remove one to add another.</p>
            )}
          </div>
        );
      })}

      <Modal
        open={adding !== null}
        title={GROUPS.find((g) => g.kind === adding)?.add ?? ""}
        onClose={() => setAdding(null)}
      >
        {adding && (
          <AddForm
            kind={adding}
            familyId={familyId}
            onDone={(msg) => {
              setAdding(null);
              setNotice(msg);
              onChange();
            }}
            onCancel={() => setAdding(null)}
          />
        )}
      </Modal>
      <Modal open={removing !== null} title="Remove this number?" onClose={() => setRemoving(null)}>
        {removing && (
          <RemoveForm
            familyId={familyId}
            s={removing}
            onDone={() => {
              setRemoving(null);
              setNotice("");
              onChange();
            }}
            onCancel={() => setRemoving(null)}
          />
        )}
      </Modal>
    </section>
  );
}

function Row({ s, onRemove }: { s: Saved; onRemove: () => void }) {
  return (
    <li>
      <span>
        <strong>{s.label}</strong> <span className="fine num">{s.ref}</span>
      </span>
      <button
        type="button"
        className="btn quiet small"
        aria-label={`Remove ${s.label}`}
        onClick={onRemove}
      >
        Remove
      </button>
    </li>
  );
}

function AddForm({
  kind,
  familyId,
  onDone,
  onCancel,
}: {
  kind: Kind;
  familyId: string;
  onDone: (notice: string) => void;
  onCancel: () => void;
}) {
  const companies = kind === "meter" ? DISCOS : TV;
  const [company, setCompany] = useState(companies[0] ?? "");
  const [ref, setRef] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const what =
    kind === "phone" ? "Phone number" : kind === "meter" ? "Meter number" : "Smartcard number";
  const ready = ref.trim() !== "" && label.trim() !== "";
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<ChangeResult>(`/api/families/${familyId}/numbers`, {
        body: {
          kind,
          ref,
          label: label.trim(),
          ...(kind === "phone" ? {} : { company }),
        },
      });
      onDone(r.waiting ? waitingNotice(r.needed) : "");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <label className="field">
        Name
        <input
          placeholder={EXAMPLE[kind]}
          value={label}
          maxLength={30}
          onChange={(e) => setLabel(e.target.value)}
        />
        <span className="hint">What your family will call it in the chat.</span>
      </label>
      {kind !== "phone" && (
        <label className="field">
          {kind === "meter" ? "Electricity company" : "TV company"}
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            {companies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        {what}
        <input inputMode="numeric" value={ref} onChange={(e) => setRef(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn quiet" onClick={onCancel}>
          Cancel
        </button>
        <LoadingButton
          loading={busy}
          disabled={!ready}
          label="Add number"
          loadingLabel="Adding…"
          onClick={save}
        />
      </div>
    </div>
  );
}

function RemoveForm({
  familyId,
  s,
  onDone,
  onCancel,
}: {
  familyId: string;
  s: Saved;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/families/${familyId}/numbers/remove`, { body: { id: s.id } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <p>
        <strong>{s.label}</strong> <span className="num">{s.ref}</span> will come off the list. The
        assistant won't be able to pay for it. You can add it again later.
      </p>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn quiet" onClick={onCancel}>
          Keep it
        </button>
        <LoadingButton
          loading={busy}
          label="Remove number"
          loadingLabel="Removing…"
          onClick={remove}
        />
      </div>
    </div>
  );
}
