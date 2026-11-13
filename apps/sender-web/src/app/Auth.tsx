import { useState } from "react";
import { Mark } from "../ui/Icon.js";
import { passkeysSupported, signIn, signUp } from "./passkey.js";
import type { Account } from "./types.js";

/**
 * Sign up and sign in: one page, two modes. The left side is the brand
 * (a quiet panel with a slip); the form sits on the right, left-aligned, and
 * says plainly what a passkey is.
 */
export function AuthPage({
  mode,
  onDone,
}: {
  mode: "signin" | "signup";
  onDone: (token: string, account: Account) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const up = mode === "signup";

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
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (up && !name.trim()) return;
    void run(up ? () => signUp(name.trim()) : signIn);
  };

  return (
    <div className="auth">
      <section className="auth-art" aria-hidden="false">
        <a className="wordmark" href="/" aria-label="Earmark home">
          <Mark /> Earmark
        </a>
        <div className="auth-art-body">
          <p className="auth-statement">Rules you set. Bills your family needs.</p>
          <div className="stub-wrap auth-stub">
            <div
              className="stub"
              role="img"
              aria-label="An example receipt for 5,000 naira of electricity"
            >
              <div className="stub-body">
                <span className="kind">Electricity</span>
                <span className="amount">₦5,000</span>
                <span className="status-paid">Paid</span>
              </div>
              <div className="stub-foot">Recorded on NEAR</div>
            </div>
          </div>
        </div>
      </section>

      <main className="auth-form">
        <form onSubmit={submit} className="auth-box">
          <h1>{up ? "Create your account" : "Welcome back"}</h1>
          <p className="auth-lede">
            {up
              ? "You'll sign in with your fingerprint, face or PIN. There's no password to forget or leak."
              : "Use the passkey on this device to sign in."}
          </p>

          {!passkeysSupported() && (
            <p role="alert" className="alert">
              This browser can't make passkeys. Try a recent Chrome, Safari or Edge.
            </p>
          )}

          {up && (
            <label className="field">
              Your name
              <input
                autoComplete="name"
                placeholder="Ada Okafor"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <span className="hint">Your family sees this when you approve a payment.</span>
            </label>
          )}

          <button type="submit" className="btn" disabled={busy || (up && !name.trim())}>
            {busy
              ? "Waiting for your device…"
              : up
                ? "Create account with a passkey"
                : "Sign in with your passkey"}
          </button>

          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}

          {up && (
            <ul className="auth-facts">
              <li>Your device keeps the private key. We only keep a public one.</li>
              <li>Every approval you give is signed with it.</li>
              <li>If a relative invited you, create your account first, then join their family.</li>
            </ul>
          )}

          <p className="auth-switch">
            {up ? "Already have an account? " : "New to Earmark? "}
            <a href={up ? "#/signin" : "#/signup"}>{up ? "Sign in" : "Create an account"}</a>
          </p>
          <p className="auth-switch">
            <a href="/">Back to the home page</a>
          </p>
        </form>
      </main>
    </div>
  );
}
