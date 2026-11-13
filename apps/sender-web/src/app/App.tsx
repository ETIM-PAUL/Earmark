import { useCallback, useEffect, useState } from "react";
import { setLocalRpc } from "../receipts.js";
import { AuthPage } from "./Auth.js";
import { ApiError, api, session } from "./api.js";
import { Dashboard } from "./Dashboard.js";
import { Onboarding } from "./Onboarding.js";
import { VIEWS, type View } from "./Shell.js";
import type { Account, AppConfig, Invite } from "./types.js";

type Auth = { state: "loading" } | { state: "out" } | { state: "in"; account: Account };

/** The page is `#/signin`, `#/signup`, or `#/<view>` once signed in. */
const readHash = () => location.hash.replace(/^#\/?/, "");

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [auth, setAuth] = useState<Auth>({ state: "loading" });
  const [fatal, setFatal] = useState("");
  const [firstInvite, setFirstInvite] = useState<Invite | null>(null);
  const [route, setRoute] = useState(readHash);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

  const go = useCallback((v: string) => {
    location.hash = `#/${v}`;
  }, []);

  const signedIn = useCallback(
    (token: string, account: Account) => {
      session.set(token);
      setAuth({ state: "in", account });
      go("home");
    },
    [go],
  );

  const signOut = async () => {
    await api("/api/auth/logout", { body: {} }).catch(() => {});
    session.set(null);
    setFirstInvite(null);
    setAuth({ state: "out" });
    go("signin");
  };

  if (fatal) {
    return (
      <div className="splash">
        <p role="alert" className="alert">
          {fatal}
        </p>
        <p className="fine">Is the bot running? Try `make demo`.</p>
      </div>
    );
  }
  if (!config || auth.state === "loading") {
    return (
      <div className="splash" role="status">
        Loading…
      </div>
    );
  }
  if (auth.state === "out") {
    return <AuthPage mode={route === "signin" ? "signin" : "signup"} onDone={signedIn} />;
  }

  const { account } = auth;
  const familyId = account.familyIds[0];
  if (!familyId) {
    return (
      <div className="setup">
        <header className="setup-top">
          <a className="wordmark" href="/">
            Earmark
          </a>
          <span className="who">
            {account.name}{" "}
            <button type="button" className="link" onClick={signOut}>
              Sign out
            </button>
          </span>
        </header>
        <main className="setup-main">
          <Onboarding
            config={config}
            account={account}
            onCreated={(id, invite) => {
              setFirstInvite(invite);
              setAuth({ state: "in", account: { ...account, familyIds: [id] } });
              go("home");
            }}
            onJoined={(id) => {
              setAuth({ state: "in", account: { ...account, familyIds: [id] } });
              go("home");
            }}
          />
        </main>
      </div>
    );
  }
  const view: View = (VIEWS as string[]).includes(route) ? (route as View) : "home";
  return (
    <Dashboard
      familyId={familyId}
      config={config}
      firstInvite={firstInvite}
      name={account.name}
      view={view}
      setView={(v) => go(v)}
      onSignOut={signOut}
    />
  );
}
