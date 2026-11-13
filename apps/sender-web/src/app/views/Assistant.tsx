import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { type Line, say } from "../chat.js";
import type { Invite } from "../types.js";

const TRY = [
  "buy 5k light for my meter",
  "abeg buy 25k light for my meter",
  "buy 1k airtime",
  "how much is left?",
];

/**
 * The recipient's chat. Only the local demo can show it: a real family
 * talks on Telegram or WhatsApp and the bot keeps none of those messages.
 */
export function ChatPanel({
  familyId,
  lines,
  refresh,
  compact,
}: {
  familyId: string;
  lines: Line[] | null | undefined;
  refresh: () => void;
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const end = useRef<HTMLLIElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a line arrives
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lines?.length]);

  const send = async (t: string) => {
    if (!t.trim()) return;
    setText("");
    setFailed(!(await say(familyId, t)));
    refresh();
    setTimeout(refresh, 700);
  };

  return (
    <section className={`chat-panel ${compact ? "compact" : ""}`} aria-labelledby="chat-h">
      <h2 id="chat-h">{compact ? "Family chat" : "Your family's chat"}</h2>
      <p className="fine">
        You're typing as the recipient. Real families use Telegram or WhatsApp.
      </p>
      <div className="phone-frame">
        <ol className="messages" aria-live="polite">
          {(lines ?? []).length === 0 && (
            <li className="msg-empty">No messages yet. Try one of the phrases below.</li>
          )}
          {(lines ?? []).map((l) => (
            <li key={`${l.at}-${l.from}-${l.text}`} className={`bubble ${l.from}`}>
              {l.text}
            </li>
          ))}
          <li ref={end} aria-hidden="true" />
        </ol>
        <fieldset className="try">
          <legend className="visually-hidden">Phrases to try</legend>
          {TRY.map((t) => (
            <button key={t} type="button" className="chip-btn" onClick={() => void send(t)}>
              {t}
            </button>
          ))}
          <button type="button" className="chip-btn" onClick={() => void send("yes")}>
            yes
          </button>
        </fieldset>
        <form
          className="say"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <input
            aria-label="Message as the recipient"
            placeholder="Type as the recipient"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn small">
            Send
          </button>
        </form>
      </div>
      {failed && (
        <p role="alert" className="alert">
          The demo chat couldn't be reached.
        </p>
      )}
    </section>
  );
}

export function InviteCard({ invite }: { invite: Invite }) {
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
    <div className="stack">
      <p>
        Send this link. When they open it, the assistant is connected to your family. It works once
        and expires {new Date(invite.expiresAt).toLocaleDateString("en-GB")}.
      </p>
      <div className="actions">
        {invite.telegram && (
          <a className="btn" href={invite.telegram}>
            Telegram link
          </a>
        )}
        {invite.whatsapp && (
          <a className="btn" href={invite.whatsapp}>
            WhatsApp link
          </a>
        )}
        {link && (
          <button type="button" className="btn quiet" onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
        )}
        {invite.judge && (
          <a className="btn quiet" href={invite.judge} target="_blank" rel="noreferrer">
            Open the demo view
          </a>
        )}
      </div>
      {!link && !invite.judge && (
        <p className="fine">Chat links need the bot's Telegram or WhatsApp keys.</p>
      )}
    </div>
  );
}

export function Assistant({
  familyId,
  invite,
  lines,
  refresh,
}: {
  familyId: string;
  invite: Invite | null;
  lines: Line[] | null | undefined;
  refresh: () => void;
}) {
  const [fresh, setFresh] = useState<Invite | null>(invite);
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
        <h1>Assistant</h1>
      </div>
      <p className="lede-app">
        Your family writes to the assistant in their own words, in English or Pidgin. It reads the
        request and finds the bill. Your rules decide whether it's paid.
      </p>

      {lines !== null && lines !== undefined ? (
        <ChatPanel familyId={familyId} lines={lines} refresh={refresh} />
      ) : (
        <p className="note-box">
          Chats happen on your family's phones, and Earmark doesn't keep or show their messages. The
          demo build shows a practice chat here.
        </p>
      )}

      <section aria-labelledby="connect-h" className="stack">
        <h2 id="connect-h">Connect their phone</h2>
        {fresh ? (
          <InviteCard invite={fresh} />
        ) : (
          <button type="button" className="btn quiet" onClick={again}>
            Make an invite link
          </button>
        )}
        {fresh && (
          <button type="button" className="link" onClick={again}>
            Make a new link
          </button>
        )}
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="say-h" className="stack">
        <h2 id="say-h">What they can say</h2>
        <ul className="plain">
          <li>"buy 5k light for my meter" pays the saved meter.</li>
          <li>"abeg buy 1k airtime for 0803…" works in Pidgin too.</li>
          <li>"how much is left?" shows what's left of the budget.</li>
          <li>Nothing is paid until they reply YES to the price.</li>
        </ul>
      </section>
    </div>
  );
}
