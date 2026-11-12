import type { Category } from "./category.js";
import type { NgnKobo } from "./money.js";
import { type CategoryRule, FamilyRules } from "./rules.js";

/**
 * Rule presets: the sender's starting point, then adjusted one rule at a
 * time. A preset only sets layer 2 (category rules and the approval
 * threshold). Hard limits live in the signed Agent API policy and change
 * only with a fresh owner signature, so nothing here touches them.
 */

export const PRESET_NAMES = ["open", "essentials", "bills_only", "strict"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

const naira = (n: number): NgnKobo => n * 100;
const on = (cap: number | null): CategoryRule => ({
  enabled: true,
  monthlyCapNgnKobo: cap === null ? null : naira(cap),
  allowedCustomerRefs: [],
});
const off: CategoryRule = { enabled: false, monthlyCapNgnKobo: null, allowedCustomerRefs: [] };

export const PRESETS: Record<
  PresetName,
  {
    label: string;
    about: string;
    approvalAboveNgnKobo: NgnKobo | null;
    categories: Record<Category, CategoryRule>;
  }
> = {
  open: {
    label: "Open",
    about: "Everything on, no caps. Anything above ₦20,000 asks you first.",
    approvalAboveNgnKobo: naira(20_000),
    categories: { electricity: on(null), airtime: on(null), data: on(null), tv: on(null) },
  },
  essentials: {
    label: "Essentials",
    about: "Light, airtime and data, with monthly caps. TV off. Above ₦20,000 asks you first.",
    approvalAboveNgnKobo: naira(20_000),
    categories: {
      electricity: on(50_000),
      airtime: on(10_000),
      data: on(10_000),
      tv: off,
    },
  },
  bills_only: {
    label: "Bills only",
    about: "Light and TV only. Airtime and data off. Above ₦30,000 asks you first.",
    approvalAboveNgnKobo: naira(30_000),
    categories: { electricity: on(60_000), airtime: off, data: off, tv: on(15_000) },
  },
  strict: {
    label: "Strict",
    about: "Small caps on everything. Above ₦5,000 asks you first.",
    approvalAboveNgnKobo: naira(5_000),
    categories: {
      electricity: on(20_000),
      airtime: on(3_000),
      data: on(3_000),
      tv: on(8_000),
    },
  },
};

export const isPresetName = (s: unknown): s is PresetName =>
  typeof s === "string" && (PRESET_NAMES as readonly string[]).includes(s);

/** Same hard limits, new category rules. Bumps the version. */
export function applyPreset(rules: FamilyRules, name: PresetName, now: Date = new Date()) {
  const p = PRESETS[name];
  return FamilyRules.parse({
    ...rules,
    version: rules.version + 1,
    approvalAboveNgnKobo: p.approvalAboveNgnKobo,
    categories: structuredClone(p.categories),
    updatedAt: now.toISOString(),
  });
}

/** Freeze or unfreeze. Frozen refuses every new order at once. */
export function setFrozen(rules: FamilyRules, frozen: boolean, now: Date = new Date()) {
  return FamilyRules.parse({
    ...rules,
    version: rules.version + 1,
    frozen,
    updatedAt: now.toISOString(),
  });
}

export interface SoftRulesChange {
  approvalAboveNgnKobo?: NgnKobo | null;
  categories?: Partial<Record<Category, Partial<CategoryRule>>>;
}

/** Change layer 2 only. Hard limits can't be changed here, by design. */
export function updateSoftRules(rules: FamilyRules, change: SoftRulesChange, now = new Date()) {
  const categories = structuredClone(rules.categories);
  for (const [c, patch] of Object.entries(change.categories ?? {}) as [
    Category,
    Partial<CategoryRule>,
  ][]) {
    categories[c] = { ...categories[c], ...patch };
  }
  return FamilyRules.parse({
    ...rules,
    version: rules.version + 1,
    approvalAboveNgnKobo:
      change.approvalAboveNgnKobo === undefined
        ? rules.approvalAboveNgnKobo
        : change.approvalAboveNgnKobo,
    categories,
    updatedAt: now.toISOString(),
  });
}
