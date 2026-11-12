import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { ApiError, api } from "./api.js";
import type { Account } from "./types.js";

// Passkeys: the phone's or laptop's own fingerprint, face or PIN. Sign-in
// and every approval use one; the private key never leaves the device.

export const passkeysSupported = () => browserSupportsWebAuthn();

/** Turn the browser's errors into words a person can act on. */
function friendly(e: unknown): Error {
  if (e instanceof ApiError) return e;
  const name = (e as { name?: string }).name;
  if (name === "NotAllowedError" || name === "AbortError") {
    return new Error("That was cancelled. Try again when you're ready.");
  }
  if (name === "InvalidStateError") {
    return new Error("This device already has a passkey for Earmark. Use Sign in instead.");
  }
  if (name === "SecurityError") {
    return new Error(
      "Passkeys need a secure page. Open the app at http://localhost, not an IP address.",
    );
  }
  return new Error("Your device couldn't make a passkey. Please try again.");
}

interface Signed {
  token: string;
  account: Account;
}

export async function signUp(name: string): Promise<Signed> {
  try {
    const { challengeId, options } = await api<{ challengeId: string; options: never }>(
      "/api/auth/register/options",
      { body: { name } },
    );
    const response = await startRegistration({ optionsJSON: options });
    return await api<Signed>("/api/auth/register/verify", { body: { challengeId, response } });
  } catch (e) {
    throw friendly(e);
  }
}

export async function signIn(): Promise<Signed> {
  try {
    const { challengeId, options } = await api<{ challengeId: string; options: never }>(
      "/api/auth/login/options",
      { body: {} },
    );
    const response = await startAuthentication({ optionsJSON: options });
    return await api<Signed>("/api/auth/login/verify", { body: { challengeId, response } });
  } catch (e) {
    throw friendly(e);
  }
}

/**
 * Approve or decline with the passkey. The device signs a challenge made
 * from this order and this decision, so the signature is good for nothing else.
 */
export async function decide(
  orderId: string,
  decision: "approved" | "declined",
): Promise<{ status: string }> {
  try {
    const options = await api<never>("/api/decisions/options", { body: { orderId, decision } });
    const response = await startAuthentication({ optionsJSON: options });
    return await api<{ ok: true; status: string }>("/api/decisions", {
      body: { orderId, decision, response },
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      throw new Error(
        e.reason === "expired"
          ? "That request ran out of time, so it was cancelled."
          : "That request is no longer waiting.",
      );
    }
    throw friendly(e);
  }
}
