import { createHash, randomBytes } from "node:crypto";
import type { Order } from "@earmark/shared";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { SenderAccounts } from "./accounts.js";
import { type Decision, decisionMessage } from "./approvals.js";

/**
 * Passkeys for the sender: sign-in, and the owner's signature on every
 * approval. A passkey is a keypair in the sender's phone or laptop; the
 * server holds only the public key.
 *
 * A decision is signed by a WebAuthn assertion whose challenge is
 * SHA-256(order ID | request time | decision), so the signature covers
 * exactly one order and one decision, needs the sender's fingerprint or
 * PIN (user verification), and can't be replayed as a decline or moved to
 * another order. This is the real owner signature that replaces the demo
 * owner's HMAC from Phase 11 (`verifyDecision` plugs into `decide`).
 */

export interface PasskeyConfig {
  /** Registrable domain the passkeys belong to, e.g. "localhost" or "earmark.example". */
  rpID: string;
  rpName: string;
  /** The web app's origin, e.g. http://localhost:5173. */
  origin: string;
  accounts: SenderAccounts;
  now?: () => number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

type Pending =
  | { kind: "register"; challenge: string; accountId: string; name: string; expiresAt: number }
  | { kind: "login"; challenge: string; expiresAt: number };

export class Passkeys {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;

  constructor(private readonly cfg: PasskeyConfig) {
    this.now = cfg.now ?? Date.now;
  }

  private hold(p: Pending): string {
    // Forget stale challenges so the map stays small.
    for (const [k, v] of this.pending) if (v.expiresAt <= this.now()) this.pending.delete(k);
    const id = randomBytes(16).toString("base64url");
    this.pending.set(id, p);
    return id;
  }

  /** One use: a challenge is spent whether or not it verifies. */
  private take(id: string, kind: Pending["kind"]): Pending | null {
    const p = this.pending.get(id);
    this.pending.delete(id);
    return p && p.kind === kind && p.expiresAt > this.now() ? p : null;
  }

  // ── Sign up ─────────────────────────────────────────────────────────

  async registerOptions(
    name: string,
  ): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    const accountId = `acct_${randomBytes(8).toString("hex")}`;
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpID,
      userName: name,
      userID: new TextEncoder().encode(accountId),
      attestationType: "none",
      // A passkey the phone or laptop keeps, unlocked by fingerprint, face or PIN.
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const challengeId = this.hold({
      kind: "register",
      challenge: options.challenge,
      accountId,
      name,
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    });
    return { challengeId, options };
  }

  async registerVerify(
    challengeId: string,
    response: RegistrationResponseJSON,
  ): Promise<{ accountId: string } | null> {
    const p = this.take(challengeId, "register");
    if (p?.kind !== "register") return null;
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: p.challenge,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpID,
      requireUserVerification: true,
    }).catch(() => null);
    if (!v?.verified) return null;
    const { credential } = v.registrationInfo;
    if (this.cfg.accounts.byCredentialId(credential.id)) return null;
    this.cfg.accounts.create(p.accountId, p.name, {
      id: credential.id,
      publicKey: b64(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
    });
    return { accountId: p.accountId };
  }

  // ── Sign in ─────────────────────────────────────────────────────────

  async loginOptions(): Promise<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    // No allowCredentials: the device offers whichever passkey it holds for this site.
    const options = await generateAuthenticationOptions({
      rpID: this.cfg.rpID,
      userVerification: "required",
    });
    const challengeId = this.hold({
      kind: "login",
      challenge: options.challenge,
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    });
    return { challengeId, options };
  }

  async loginVerify(
    challengeId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ accountId: string } | null> {
    const p = this.take(challengeId, "login");
    if (!p) return null;
    const account = this.cfg.accounts.byCredentialId(response.id);
    return account && (await this.check(account.id, response, p.challenge, true))
      ? { accountId: account.id }
      : null;
  }

  // ── Signing a decision, or any other message ─────────────────────────

  /** The challenge a message is signed over. Anyone can recompute it; it isn't secret. */
  messageChallenge(message: string): string {
    return b64(createHash("sha256").update(message).digest());
  }

  /** The challenge a decision is signed over. */
  decisionChallenge(order: Order, decision: Decision): string {
    return this.messageChallenge(decisionMessage(order, decision));
  }

  async messageOptions(
    accountId: string,
    message: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
    const account = this.cfg.accounts.get(accountId);
    if (!account) return null;
    return generateAuthenticationOptions({
      rpID: this.cfg.rpID,
      userVerification: "required",
      challenge: Buffer.from(this.messageChallenge(message), "base64url"),
      allowCredentials: account.credentials.map((c) => ({
        id: c.id,
        ...(c.transports ? { transports: c.transports } : {}),
      })),
    });
  }

  decisionOptions(accountId: string, order: Order, decision: Decision) {
    return this.messageOptions(accountId, decisionMessage(order, decision));
  }

  /**
   * Which member of the family signed `message`: `proof` is the JSON of the
   * assertion a passkey made over it. Only a passkey of an account in the
   * family counts. Null if nobody valid did.
   */
  async signerOf(familyId: string, message: string, proof: string): Promise<string | null> {
    let response: AuthenticationResponseJSON;
    try {
      response = JSON.parse(proof) as AuthenticationResponseJSON;
    } catch {
      return null;
    }
    const member = this.cfg.accounts
      .membersOf(familyId)
      .find((m) => m.credentials.some((c) => c.id === response?.id));
    if (!member) return null;
    return (await this.check(member.id, response, this.messageChallenge(message), true))
      ? member.id
      : null;
  }

  signerOfDecision(order: Order, decision: Decision, proof: string): Promise<string | null> {
    return this.signerOf(order.familyId, decisionMessage(order, decision), proof);
  }

  /** The owner-signature check `decide` calls: any member of the family may sign. */
  async verifyDecision(order: Order, decision: Decision, proof: string): Promise<boolean> {
    return (await this.signerOfDecision(order, decision, proof)) !== null;
  }

  private async check(
    accountId: string,
    response: AuthenticationResponseJSON,
    challenge: string,
    requireUserVerification: boolean,
  ): Promise<boolean> {
    const credential = this.cfg.accounts
      .get(accountId)
      ?.credentials.find((c) => c.id === response.id);
    if (!credential) return false;
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpID,
      requireUserVerification,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey, "base64url"),
        counter: credential.counter,
        ...(credential.transports ? { transports: credential.transports } : {}),
      },
    }).catch(() => null);
    if (!v?.verified) return false;
    // A counter that goes backwards means a cloned authenticator; the library
    // rejects that above. Keep the new value for next time.
    credential.counter = v.authenticationInfo.newCounter;
    return true;
  }
}
