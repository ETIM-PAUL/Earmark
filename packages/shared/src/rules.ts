import { z } from "zod";
import { CATEGORIES, type Category } from "./category.js";
import { FamilyId, NearAccountId } from "./ids.js";
import { NgnKobo, UsdcAtomic } from "./money.js";

/**
 * Layer 1: hard limits. Written into the Agent API account policy that the
 * sender signs, and enforced there, so even a bug in our service cannot
 * move money outside them.
 */
export const HardLimits = z.object({
  /** The only destination the family account may send to. */
  settlementAccountId: NearAccountId,
  monthlyBudgetUsdcAtomic: UsdcAtomic,
  /** Transfers above this need the owner's signature. */
  approvalThresholdUsdcAtomic: UsdcAtomic,
});
export type HardLimits = z.infer<typeof HardLimits>;

/** Layer 2: category rules, enforced in the order service. */
export const CategoryRule = z.object({
  enabled: z.boolean(),
  /** null means no per-category cap; the monthly budget still applies. */
  monthlyCapNgnKobo: NgnKobo.nullable(),
  /**
   * Meter, phone or smartcard numbers this category may pay. Empty means any.
   * Stored off-chain only.
   */
  allowedCustomerRefs: z.array(z.string().min(1)),
});
export type CategoryRule = z.infer<typeof CategoryRule>;

/** Both layers must pass before an order runs. */
export const FamilyRules = z.object({
  familyId: FamilyId,
  /** Bumped on every change; a change to hardLimits needs a fresh owner signature. */
  version: z.number().int().positive(),
  frozen: z.boolean(),
  hardLimits: HardLimits,
  /** Orders above this naira amount go to the sender for approval. null means never. */
  approvalAboveNgnKobo: NgnKobo.nullable(),
  categories: z.object(
    Object.fromEntries(CATEGORIES.map((c) => [c, CategoryRule])) as Record<
      Category,
      typeof CategoryRule
    >,
  ),
  updatedAt: z.iso.datetime(),
});
export type FamilyRules = z.infer<typeof FamilyRules>;
