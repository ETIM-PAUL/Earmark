import { useState } from "react";
import { api } from "../api.js";
import type { ChangeResult, Invite, Overview, Team } from "../types.js";
import { InviteCard } from "./Assistant.js";
import { waitingNotice } from "./Home.js";

const KIND: Record<string, string> = {
  electricity: "Meter",
  tv: "Decoder",
  airtime: "Phone",
  data: "Phone",
};

export function Family({
  familyId,
  overview: o,
  team,
  onChange,
}: {
  familyId: string;
  overview: Overview;
  team: Team;
  onChange: () => void;
}) {
  const [fresh, setFresh] = useState<Invite | null>(null);
  const [error, setError] = useState("");
  const again = async () => {
    setError("");
    try {
      setFresh(await api<Invite>(`/api/families/${familyId}/invite`, { body: {} }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>Family</h1>
      </div>

      <section aria-labelledby="rec-h" className="stack">
        <h2 id="rec-h">Who you're paying for</h2>
        <p>
          Recipient <strong className="num">{o.recipientPhone}</strong>
        </p>
        {o.saved.length > 0 ? (
          <ul className="saved">
            {o.saved.map((s) => (
              <li key={`${s.category}${s.ref}`}>
                <strong>{s.label}</strong>
                <span className="fine">
                  {KIND[s.category] ?? "Number"} <span className="num">{s.ref}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fine">No saved meters or decoders. They can type a number in the chat.</p>
        )}
        {team.isOwner &&
          (fresh ? (
            <InviteCard invite={fresh} />
          ) : (
            <button type="button" className="btn quiet" onClick={again}>
              Make a new invite link
            </button>
          ))}
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
      </section>

      <TeamCard familyId={familyId} team={team} onChange={onChange} />
    </div>
  );
}

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
    <section aria-labelledby="rel-h" className="stack">
      <h2 id="rel-h">Relatives</h2>
      <ul className="members">
        {team.members.map((m) => (
          <li key={m.id}>
            <span className="avatar" aria-hidden="true">
              {m.name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{m.name}</strong>
              {m.you && <span className="fine"> (you)</span>}
              {m.isOwner && <span className="fine"> set up the family</span>}
            </span>
          </li>
        ))}
      </ul>
      {team.members.length > 1 && (
        <label className="field">
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
      <p className="fine">
        {team.required > 1
          ? `A payment that needs your approval waits for ${team.required} relatives, each signing with their own passkey. Any one of you can decline it or freeze the account.`
          : "Invite a relative to share this family. You can then ask for more than one signature on large payments and rule changes."}
      </p>
      {team.isOwner && !full && !code && (
        <button type="button" className="btn quiet" onClick={invite}>
          Add a relative
        </button>
      )}
      {team.isOwner && full && (
        <p className="fine">The family is full ({team.maxMembers} relatives).</p>
      )}
      {code && (
        <div className="code-box">
          <p>
            Give them this code. They create an account, then choose “Join a family”. It works once
            and expires {new Date(code.expiresAt).toLocaleDateString("en-GB")}.
          </p>
          <p className="code">{code.code}</p>
          <div className="actions">
            <button type="button" className="btn quiet" onClick={copy}>
              {copied ? "Copied" : "Copy code"}
            </button>
            <button type="button" className="btn quiet" onClick={() => setCode(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="note-box">
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
