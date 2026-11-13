import { useState } from "react";
import { api } from "./api.js";
import type { Account, AppConfig, Invite } from "./types.js";

// Set up a family: the recipient's number, their meters and decoders, and a
// preset to start from. Rules can be tuned later, one at a time.

interface Row {
  key: number;
  company: string;
  ref: string;
  label: string;
}

let nextKey = 1;
const newRow = (label = ""): Row => ({ key: nextKey++, company: "", ref: "", label });

export function Onboarding({
  config,
  onCreated,
  onJoined,
}: {
  config: AppConfig;
  account: Account;
  onCreated: (familyId: string, invite: Invite) => void;
  onJoined: (familyId: string) => void;
}) {
  const [joining, setJoining] = useState(false);
  if (joining) return <Join onJoined={onJoined} onBack={() => setJoining(false)} />;
  return (
    <>
      <button type="button" className="btn quiet" onClick={() => setJoining(true)}>
        A relative invited me: join their family
      </button>
      <CreateFamily config={config} onCreated={onCreated} />
    </>
  );
}

/** Redeem the code a relative sent, to share their family. */
function Join({ onJoined, onBack }: { onJoined: (familyId: string) => void; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ familyId: string }>("/api/join", { body: { code } });
      onJoined(r.familyId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack-lg" onSubmit={join}>
      <header>
        <h1>Join a family</h1>
        <p className="lede-app">
          Type the code your relative gave you. You'll see the same budget and payments, and sign
          large payments and rule changes with your own passkey.
        </p>
      </header>
      <label className="field">
        Code
        <input
          autoCapitalize="characters"
          autoComplete="off"
          placeholder="ABCD-EFGH"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <button type="submit" className="btn" disabled={busy || code.trim().length < 8}>
        {busy ? "Joining…" : "Join"}
      </button>
      <button type="button" className="btn quiet" onClick={onBack}>
        Back
      </button>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function CreateFamily({
  config,
  onCreated,
}: {
  config: AppConfig;
  onCreated: (familyId: string, invite: Invite) => void;
}) {
  const [phone, setPhone] = useState("");
  const [meters, setMeters] = useState<Row[]>([newRow("Home meter")]);
  const [cards, setCards] = useState<Row[]>([]);
  const [preset, setPreset] = useState("essentials");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const edit = (set: typeof setMeters, key: number, patch: Partial<Row>) =>
    set((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const made = await api<{ familyId: string; invite: Invite }>("/api/families", {
        body: {
          recipientPhone: phone,
          meters: meters
            .filter((m) => m.ref.trim())
            .map((m) => ({ disco: m.company || "ikeja", ref: m.ref, label: m.label || "Meter" })),
          smartcards: cards
            .filter((c) => c.ref.trim())
            .map((c) => ({ tv: c.company || "dstv", ref: c.ref, label: c.label || "Decoder" })),
          preset,
        },
      });
      onCreated(made.familyId, made.invite);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack-lg" onSubmit={create}>
      <header>
        <h1>Set up your family</h1>
        <p className="lede-app">Three short steps. You can change everything later.</p>
      </header>

      <section className="stack">
        <h2>1. Who are you paying for?</h2>
        <label className="field">
          Their phone number
          <input
            inputMode="tel"
            autoComplete="off"
            placeholder="0803 123 4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </label>
      </section>

      <section className="stack">
        <h2>2. Their meters and decoders</h2>
        <p className="fine">
          Optional. Saved numbers let them say "my meter" instead of typing it. The demo meter
          1111111111111 and decoder 1212121212 work in this build.
        </p>
        {meters.map((m) => (
          <fieldset key={m.key} className="row">
            <legend>Electricity meter</legend>
            <input
              aria-label="Company"
              placeholder="Company, e.g. Ikeja"
              value={m.company}
              onChange={(e) => edit(setMeters, m.key, { company: e.target.value })}
            />
            <input
              aria-label="Meter number"
              inputMode="numeric"
              placeholder="Meter number"
              value={m.ref}
              onChange={(e) => edit(setMeters, m.key, { ref: e.target.value })}
            />
            <input
              aria-label="Name for it"
              placeholder="Name, e.g. Home meter"
              value={m.label}
              onChange={(e) => edit(setMeters, m.key, { label: e.target.value })}
            />
          </fieldset>
        ))}
        {cards.map((c) => (
          <fieldset key={c.key} className="row">
            <legend>TV decoder</legend>
            <input
              aria-label="TV company"
              placeholder="DStv, GOtv, StarTimes…"
              value={c.company}
              onChange={(e) => edit(setCards, c.key, { company: e.target.value })}
            />
            <input
              aria-label="Smartcard number"
              inputMode="numeric"
              placeholder="Smartcard number"
              value={c.ref}
              onChange={(e) => edit(setCards, c.key, { ref: e.target.value })}
            />
            <input
              aria-label="Name for it"
              placeholder="Name, e.g. House DStv"
              value={c.label}
              onChange={(e) => edit(setCards, c.key, { label: e.target.value })}
            />
          </fieldset>
        ))}
        <div className="actions">
          {meters.length < 5 && (
            <button
              type="button"
              className="btn quiet small"
              onClick={() => setMeters([...meters, newRow()])}
            >
              + Another meter
            </button>
          )}
          {cards.length < 3 && (
            <button
              type="button"
              className="btn quiet small"
              onClick={() => setCards([...cards, newRow("House TV")])}
            >
              + TV decoder
            </button>
          )}
        </div>
      </section>

      <section className="stack">
        <h2>3. Your rules</h2>
        <p className="fine">Start from one. Anything outside it comes to you for a yes or no.</p>
        <div className="choices" role="radiogroup" aria-label="Rule preset">
          {config.presets.map((p) => (
            <label key={p.name} className={`choice ${preset === p.name ? "on" : ""}`}>
              <input
                type="radio"
                name="preset"
                value={p.name}
                checked={preset === p.name}
                onChange={() => setPreset(p.name)}
              />
              <strong>{p.label}</strong>
              <span>{p.about}</span>
            </label>
          ))}
        </div>
      </section>

      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Creating…" : "Create family"}
      </button>
    </form>
  );
}
