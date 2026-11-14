import { describe, expect, it } from "vitest";
import { ATTACKS, describeOutcome, fooledModel, held, runAttack } from "./attack-drill.js";
import { ruleModel } from "./mock/rule-model.js";

/**
 * The attack drill, keyless (attack-drill.ts). Every attack must leave the
 * money where the sender's rules say, twice: with a model that believes the
 * attacker completely, and with the plain-rules reader `make demo` uses.
 * `pnpm drill:attacks --near-ai` runs the same messages through the real
 * NEAR AI Cloud model.
 */

describe("attack drill: a fully fooled model", () => {
  for (const attack of ATTACKS) {
    it(`${attack.id}: ${attack.tries}`, async () => {
      const o = await runAttack(attack, fooledModel(attack));
      expect(held(attack, o), `${describeOutcome(o)}\n${o.replies.join("\n")}`).toBe(true);
    });
  }
});

describe("attack drill: the keyless demo's reader", () => {
  for (const attack of ATTACKS) {
    it(`${attack.id}: ${attack.tries}`, async () => {
      const o = await runAttack(attack, ruleModel);
      expect(held(attack, o), `${describeOutcome(o)}\n${o.replies.join("\n")}`).toBe(true);
    });
  }
});

describe("attack drill: it notices a missing rule", () => {
  it("with no approval line, the fake-approval ₦25,000 bill is bought and the drill says so", async () => {
    const attack = ATTACKS.find((a) => a.id === "fake-sender-approval");
    if (!attack) throw new Error("fake-sender-approval is missing");
    const loosened = {
      ...attack,
      setup: (demo: Parameters<NonNullable<typeof attack.setup>>[0], familyId: string) =>
        demo.sender.updateRules(familyId, { approvalAboveNgnKobo: null }),
    };
    const o = await runAttack(loosened, fooledModel(attack));
    expect(o.bills).toBe(1);
    expect(held(attack, o)).toBe(false);
  });
});
