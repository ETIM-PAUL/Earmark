import { useCallback, useEffect, useState } from "react";
import { setLocalRpc } from "../receipts.js";
import { ApiError, api, session } from "./api.js";
import { Dashboard } from "./Dashboard.js";
import { Onboarding } from "./Onboarding.js";
import { passkeysSupported, signIn, signUp } from "./passkey.js";
import type { Account, AppConfig, Invite } from "./types.js";

type Auth = { state: "loading" } | { state: "out" } | { state: "in"; account: Account };

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [auth, setAuth] = useState<Auth>({ state: "loading" });
  const [fatal, setFatal] = useState("");
  const [firstInvite, setFirstInvite] = useState<Invite | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api<AppConfig>("/api/config");
        setLocalRpc(cfg.rpcUrl);
        setConfig(cfg);
      } catch (e) {
        setFatal((e as Error).message);
        return;
      }
      if (!session.get()) return setAuth({ state: "out" });
      try {
        const me = await api<{ id: string; name: string; familyIds: string[] }>("/api/me");
        setAuth({ state: "in", account: me });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) session.set(null);
        setAuth({ state: "out" });
      }
    })();
  }, []);

  const signedIn = useCallback((token: string, account: Account) => {
    session.set(token);
    setAuth({ state: "in", account });
  }, []);

  const signOut = async () => {
    await api("/api/auth/logout", { body: {} }).catch(() => {});
    session.set(null);
    setFirstInvite(null);
    setAuth({ state: "out" });
  };

  if (fatal) {
    return (
      <Shell>
        <p role="alert" className="alert">
          {fatal}
        </p>
        <p className="muted">Is the bot running? Try `make demo`.</p>
      </Shell>
    );
  }
  if (!config || auth.state === "loading") {
    return (
      <Shell>
        <p className="muted center">Loading…</p>
      </Shell>
    );
  }
  if (auth.state === "out") {
    return (
      <Shell>
        <SignIn onDone={signedIn} />
      </Shell>
    );
  }

  const { account } = auth;
  const familyId = account.familyIds[0];
  return (
    <Shell name={account.name} onSignOut={signOut}>
      {familyId ? (
        <Dashboard familyId={familyId} config={config} firstInvite={firstInvite} />
      ) : (
        <Onboarding
          config={config}
          account={account}
          onCreated={(id, invite) => {
            setFirstInvite(invite);
            setAuth({ state: "in", account: { ...account, familyIds: [id] } });
          }}
          onJoined={(id) => setAuth({ state: "in", account: { ...account, familyIds: [id] } })}
        />
      )}
    </Shell>
  );
}

function Shell({
  children,
  name,
  onSignOut,
}: {
  children: React.ReactNode;
  name?: string;
  onSignOut?: () => void;
}) {
  return (
    <div className="app">
      <header className="top">
        <strong className="brand">Earmark</strong>
        {name && onSignOut && (
          <span className="who">
            {name}{" "}
            <button type="button" className="link" onClick={onSignOut}>
              Sign out
            </button>
          </span>
        )}
      </header>
      <main>{children}</main>
    </div>
  );
}

function SignIn({ onDone }: { onDone: (token: string, account: Account) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (f: () => Promise<{ token: string; account: Account }>) => {
    setBusy(true);
    setError("");
    try {
      const r = await f();
      onDone(r.token, r.account);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <header>
        <h1>Send money home, with rules.</h1>
        <p className="muted">
          Fund a family account once and set the rules. Your family asks an assistant to pay
          electricity, airtime, data and TV, and anything outside your rules comes to you first.
        </p>
      </header>
      {!passkeysSupported() && (
        <p role="alert" className="alert">
          This browser can't make passkeys. Try a recent Chrome, Safari or Edge.
        </p>
      )}
      <section className="card stack">
        <h2>Create your account</h2>
        <label>
          Your name
          <input
            autoComplete="name"
            placeholder="Ada Okafor"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || !name.trim()}
          onClick={() => run(() => signUp(name.trim()))}
        >
          {busy ? "Waiting for your device…" : "Create account with a passkey"}
        </button>
        <p className="muted small">
          A passkey is your fingerprint, face or PIN. There's no password to forget or leak.
        </p>
      </section>
      <button type="button" className="ghost" disabled={busy} onClick={() => run(signIn)}>
        I already have an account: sign in
      </button>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </div>
  );
}
