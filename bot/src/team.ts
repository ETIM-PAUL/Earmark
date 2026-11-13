import { createHash, randomBytes } from "node:crypto";
import { formatNaira, PRESETS, type PresetName, type SoftRulesChange } from "@earmark/shared";
import type { SenderAccounts } from "./accounts.js";

/**
 * A family's team of senders: how relatives join, how many of them must
 * sign, and the changes waiting for their signatures.
 *
 * A family starts with one sender (its creator). The creator hands out join
 * codes; a relative signs in with their own passkey and redeems one. From
 * then on the family can ask for several signatures:
 *
 *   - `required` relatives must each sign (with their own passkey) before a
 *     payment that needs the sender's approval goes ahead, and before any
 *     rule change, unfreeze, or change to this number takes effect.
 *   - Any one relative can decline a payment or freeze the account at once,
 *     because stopping money is always safe.
 *
 * In memory, like the accounts.
 */

export const JOIN_CODE_TTL_MS = 48 * 60 * 60 * 1000;
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OPEN_PROPOSALS = 10;
// No 0/O/1/I/L: a code is read aloud or typed from a message.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type ProposalKind = "preset" | "rules" | "unfreeze" | "policy" | "number";

export interface Proposal {
  id: string;
  familyId: string;
  kind: ProposalKind;
  /** What will be applied: a preset name, a SoftRulesChange, nothing, or a number. */
  payload: unknown;
  /** Plain words for the other relatives. */
  summary: string;
  proposedBy: string;
  createdAt: number;
  expiresAt: number;
  /** Account IDs that have signed. */
  signers: string[];
}

/** What a proposal's signature covers: this proposal and exactly this change. */
export const proposalMessage = (p: Proposal) =>
  `proposal|${p.id}|${p.kind}|${createHash("sha256")
    .update(JSON.stringify(p.payload ?? null))
    .digest("hex")}`;

/** "TV on, cap ₦12,000; ask me above ₦8,000" for a rules change. */
export function describeRules(change: SoftRulesChange): string {
  const parts: string[] = [];
  if (change.approvalAboveNgnKobo !== undefined) {
    parts.push(
      change.approvalAboveNgnKobo === null
        ? "no approval threshold"
        : `ask for approval above ${formatNaira(change.approvalAboveNgnKobo)}`,
    );
  }
  const names: Record<string, string> = {
    electricity: "Electricity",
    airtime: "Airtime",
    data: "Data",
    tv: "TV",
  };
  for (const [c, r] of Object.entries(change.categories ?? {})) {
    if (!r) continue;
    const bits: string[] = [];
    if (r.enabled !== undefined) bits.push(r.enabled ? "on" : "off");
    if (r.monthlyCapNgnKobo !== undefined) {
      bits.push(
        r.monthlyCapNgnKobo === null ? "no cap" : `cap ${formatNaira(r.monthlyCapNgnKobo)}`,
      );
    }
    if (bits.length) parts.push(`${names[c] ?? c} ${bits.join(", ")}`);
  }
  const text = parts.join("; ");
  return `Change the rules: ${text || "no change"}`;
}

export const summaries = {
  preset: (p: PresetName) => `Switch to the ${PRESETS[p].label} rules`,
  unfreeze: () => "Unfreeze the account",
  number: (label: string, what: string, masked: string) =>
    `Let the family pay for ${label} (${what} ${masked})`,
  policy: (n: number) =>
    n <= 1 ? "Let any one relative approve" : `Require ${n} relatives to approve`,
};

export class FamilyTeam {
  private readonly codes = new Map<string, { familyId: string; expiresAt: number }>();
  private readonly policy = new Map<string, number>();
  private readonly orderSigners = new Map<string, string[]>();
  private readonly open = new Map<string, Proposal>();

  constructor(
    private readonly accounts: SenderAccounts,
    private readonly now: () => number = Date.now,
  ) {}

  // ── Joining ─────────────────────────────────────────────────────────

  /** A single-use code a relative redeems after signing up. */
  newJoinCode(familyId: string): { code: string; expiresAt: string } {
    for (const [k, v] of this.codes) if (v.expiresAt <= this.now()) this.codes.delete(k);
    const code = Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(
      "",
    );
    const expiresAt = this.now() + JOIN_CODE_TTL_MS;
    this.codes.set(code, { familyId, expiresAt });
    return {
      code: `${code.slice(0, 4)}-${code.slice(4)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Spend a code. The code is gone whether or not the join works. */
  redeem(code: string, accountId: string): { familyId: string } | "bad_code" | "full" {
    const key = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const c = this.codes.get(key);
    this.codes.delete(key);
    if (!c || c.expiresAt <= this.now()) return "bad_code";
    if (this.accounts.isMember(accountId, c.familyId)) return { familyId: c.familyId };
    return this.accounts.addMember(accountId, c.familyId) ? { familyId: c.familyId } : "full";
  }

  // ── How many must sign ──────────────────────────────────────────────

  /** Signatures needed. Never more than the family has members. */
  required(familyId: string): number {
    const n = this.accounts.membersOf(familyId).length;
    return Math.max(1, Math.min(this.policy.get(familyId) ?? 1, n));
  }

  setRequired(familyId: string, n: number): boolean {
    if (!Number.isInteger(n) || n < 1 || n > this.accounts.membersOf(familyId).length) return false;
    this.policy.set(familyId, n);
    return true;
  }

  // ── Signatures on a waiting payment ─────────────────────────────────

  signersOfOrder(orderId: string): string[] {
    return this.orderSigners.get(orderId) ?? [];
  }

  /** Record one relative's approval. Returns how many have signed. */
  addOrderSigner(orderId: string, accountId: string): number {
    const list = this.orderSigners.get(orderId) ?? [];
    if (!list.includes(accountId)) list.push(accountId);
    this.orderSigners.set(orderId, list);
    return list.length;
  }

  forgetOrder(orderId: string): void {
    this.orderSigners.delete(orderId);
  }

  // ── Changes waiting for signatures ──────────────────────────────────

  propose(
    familyId: string,
    kind: ProposalKind,
    payload: unknown,
    summary: string,
    by: string,
  ): Proposal | "too_many" {
    if (this.proposals(familyId).length >= MAX_OPEN_PROPOSALS) return "too_many";
    const p: Proposal = {
      id: `prop_${randomBytes(8).toString("hex")}`,
      familyId,
      kind,
      payload,
      summary,
      proposedBy: by,
      createdAt: this.now(),
      expiresAt: this.now() + PROPOSAL_TTL_MS,
      signers: [],
    };
    this.open.set(p.id, p);
    return p;
  }

  proposals(familyId: string): Proposal[] {
    for (const [k, v] of this.open) if (v.expiresAt <= this.now()) this.open.delete(k);
    return [...this.open.values()]
      .filter((p) => p.familyId === familyId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  proposal(familyId: string, id: string): Proposal | null {
    return this.proposals(familyId).find((p) => p.id === id) ?? null;
  }

  /** Record a signature. Returns how many relatives have signed. */
  sign(p: Proposal, accountId: string): number {
    if (!p.signers.includes(accountId)) p.signers.push(accountId);
    return p.signers.length;
  }

  drop(id: string): void {
    this.open.delete(id);
  }
}
