import { randomBytes } from "node:crypto";

/**
 * Sender accounts: who signed up, which passkeys they hold, which families
 * they own, and their sessions. In memory, like the rest of the demo state;
 * the order service (Phase 8) brings the database.
 */

export interface PasskeyCredential {
  /** base64url credential ID. */
  id: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  transports?: string[] | undefined;
}

export interface SenderAccount {
  id: string;
  name: string;
  credentials: PasskeyCredential[];
  familyIds: string[];
  createdAt: string;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The creator plus relatives who joined with a code. */
export const MAX_MEMBERS = 5;

export class SenderAccounts {
  private readonly accounts = new Map<string, SenderAccount>();
  private readonly byCredential = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  /** Everyone who may act for a family, creator first. */
  private readonly members = new Map<string, string[]>();
  private readonly sessions = new Map<string, { accountId: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  create(id: string, name: string, credential: PasskeyCredential): SenderAccount {
    const account: SenderAccount = {
      id,
      name,
      credentials: [credential],
      familyIds: [],
      createdAt: new Date(this.now()).toISOString(),
    };
    this.accounts.set(id, account);
    this.byCredential.set(credential.id, id);
    return account;
  }

  get(id: string): SenderAccount | null {
    return this.accounts.get(id) ?? null;
  }

  byCredentialId(credentialId: string): SenderAccount | null {
    const id = this.byCredential.get(credentialId);
    return id ? this.get(id) : null;
  }

  linkFamily(accountId: string, familyId: string): void {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error("no such account");
    a.familyIds.push(familyId);
    this.owners.set(familyId, accountId);
    this.members.set(familyId, [accountId]);
  }

  /** A relative joins a family. False if they're already in it or it is full. */
  addMember(accountId: string, familyId: string): boolean {
    const a = this.accounts.get(accountId);
    const list = this.members.get(familyId);
    if (!a || !list || list.includes(accountId) || list.length >= MAX_MEMBERS) return false;
    list.push(accountId);
    a.familyIds.push(familyId);
    return true;
  }

  membersOf(familyId: string): SenderAccount[] {
    return (this.members.get(familyId) ?? []).flatMap((id) => {
      const a = this.accounts.get(id);
      return a ? [a] : [];
    });
  }

  isMember(accountId: string, familyId: string): boolean {
    return this.members.get(familyId)?.includes(accountId) ?? false;
  }

  ownerOf(familyId: string): SenderAccount | null {
    const id = this.owners.get(familyId);
    return id ? this.get(id) : null;
  }

  ownsFamily(accountId: string, familyId: string): boolean {
    return this.owners.get(familyId) === accountId;
  }

  /** A session token for a signed-in account. 256 random bits. */
  newSession(accountId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { accountId, expiresAt: this.now() + SESSION_TTL_MS });
    return token;
  }

  sessionAccount(token: string | undefined): SenderAccount | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (this.now() >= s.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return this.get(s.accountId);
  }

  endSession(token: string): void {
    this.sessions.delete(token);
  }
}
