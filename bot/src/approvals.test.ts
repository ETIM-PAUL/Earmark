import { describe, expect, it } from "vitest";
import { BIG, BIG_PCM, EXTRACTIONS, LIGHT, rig } from "./test-rig.js";

/**
 * Phase 11 drills: an over-limit request reaches the sender, an approval
 * executes it, a decline tells the recipient, and a freeze blocks the next
 * order. The owner's signature is the demo owner's (Phase 12 brings the
 * wallet); everything after it is the real flow.
 */

const SIX = "buy 6k light for my meter";
EXTRACTIONS[SIX] = { category: "electricity", amountNaira: 6_000, customerRef: "SELF" };

type Rig = ReturnType<typeof rig>;

/** Ask for BIG and say YES: the order now waits for the sender. */
async function request(r: Rig, text = BIG) {
  await r.join();
  await r.say(text);
  const told = await r.say("yes");
  const [order] = await r.orders();
  if (!order) throw new Error("no order");
  return { order, told, family: order.familyId };
}

/** The sender decides, signing as the demo owner; returns what the recipient then heard. */
async function decide(r: Rig, orderId: string, decision: "approved" | "declined") {
  const from = r.outbox.length;
  const proof = await r.demo.sender.signAsDemoOwner(orderId, decision);
  const res = await r.demo.sender.decide(orderId, decision, proof ?? "");
  await r.bot.idle();
  return { res, heard: r.outbox.slice(from).join("\n") };
}

describe("Phase 11: approvals and freeze", () => {
  it("an over-limit request reaches the sender, who sees a clear card", async () => {
    const r = rig();
    const { order, told, family } = await request(r);
    expect(told).toMatch(/needs Ada's OK first.*₦25,000 is above the ₦20,000 that needs approval/);
    const [card, ...more] = await r.demo.sender.approvals(family);
    expect(more).toHaveLength(0);
    expect(card).toMatchObject({
      orderId: order.id,
      what: "Ikeja Electric prepaid electricity",
      customerName: "MAMA NGOZI",
      amountNgn: "₦25,000",
      who: "1111…1111",
    });
    expect(card?.reasons).toEqual(["₦25,000 is above the ₦20,000 that needs approval."]);
    // Nothing is bought or paid while it waits.
    expect(r.sim.pays.size).toBe(0);
    expect((await r.orders())[0]?.status).toBe("awaiting_approval");
  });

  it("an approval runs the order: paid once, token, receipt", async () => {
    const r = rig();
    const { order } = await request(r);
    const { res, heard } = await decide(r, order.id, "approved");
    expect(res.ok).toBe(true);
    expect(heard).toMatch(
      /Ada said yes\. Paying now[\s\S]*Done! Light ₦25,000 paid[\s\S]*1234 5678/,
    );
    const [o] = await r.noLostMoney();
    expect(o?.status).toBe("fulfilled");
    expect(o?.approval?.decision).toBe("approved");
    expect(r.sim.pays.get(order.id)).toBe(1);
    expect(await r.demo.sender.approvals(order.familyId)).toHaveLength(0);
  });

  it("a decline tells the recipient, in English and in Pidgin, and nothing is paid", async () => {
    const en = rig();
    const a = await request(en);
    expect((await decide(en, a.order.id, "declined")).heard).toBe(
      "Ada declined this payment. Nothing was paid.",
    );
    expect((await en.orders())[0]?.status).toBe("declined");
    expect(en.sim.pays.size).toBe(0);

    const pcm = rig();
    const b = await request(pcm, BIG_PCM);
    expect((await decide(pcm, b.order.id, "declined")).heard).toBe(
      "Ada don decline this payment. Nothing comot.",
    );
    await en.noLostMoney();
    await pcm.noLostMoney();
  });

  it("a decision can't be done twice, or after the fact", async () => {
    const r = rig();
    const { order } = await request(r);
    await decide(r, order.id, "declined");
    const again = await decide(r, order.id, "approved");
    expect(again.res).toEqual({ ok: false, reason: "not_pending" });
    expect(again.heard).toBe("");
    expect((await r.orders())[0]?.status).toBe("declined");
  });

  it("only the owner's signature counts, for this order and this decision", async () => {
    const r = rig();
    const { order } = await request(r);
    const sender = r.demo.sender;
    const declineProof = (await sender.signAsDemoOwner(order.id, "declined")) ?? "";
    // A decline signature can't be used to approve; a guess can't either.
    for (const proof of [declineProof, "", "deadbeef", "0".repeat(64)]) {
      expect(await sender.decide(order.id, "approved", proof)).toEqual({
        ok: false,
        reason: "bad_proof",
      });
    }
    // A signature for another order doesn't carry over.
    const other = rig();
    const o2 = await request(other);
    const proof2 = (await other.demo.sender.signAsDemoOwner(o2.order.id, "approved")) ?? "";
    expect((await sender.decide(order.id, "approved", proof2)).ok).toBe(false);
    expect((await r.orders())[0]?.status).toBe("awaiting_approval");
    expect(r.sim.pays.size).toBe(0);
  });

  it("freeze blocks the next order, and unfreezing lets it through", async () => {
    const r = rig();
    await r.join();
    await r.demo.sender.setFrozen(r.familyId, true);
    await r.say(LIGHT);
    const told = await r.say("yes");
    expect(told).toMatch(/I can't pay this one: The account is frozen by the sender/);
    expect((await r.orders())[0]?.status).toBe("rejected");
    expect(r.sim.pays.size).toBe(0);

    await r.demo.sender.setFrozen(r.familyId, false);
    await r.say(LIGHT);
    expect(await r.say("yes")).toMatch(/Done! Light ₦5,000 paid/);
    await r.noLostMoney();
  });

  it("freeze also cancels requests waiting for approval", async () => {
    const r = rig();
    const { order } = await request(r);
    const from = r.outbox.length;
    await r.demo.sender.setFrozen(r.familyId, true);
    await r.bot.idle();
    expect(r.outbox.slice(from).join("\n")).toBe(
      "The account is frozen by the sender. Nothing was paid.",
    );
    // A later approval goes nowhere.
    expect((await decide(r, order.id, "approved")).res).toEqual({
      ok: false,
      reason: "not_pending",
    });
    expect(r.sim.pays.size).toBe(0);
    await r.noLostMoney();
  });

  it("freeze stops a payment that hasn't been sent yet", async () => {
    let tries = 0;
    const r = rig({
      payer: {
        pay: async (o) => {
          tries += 1;
          if (tries === 1) throw new Error("Agent API HTTP 503");
          return { txHash: `pay-${o.id}` };
        },
      },
    });
    await r.join();
    await r.say(LIGHT);
    await r.say("yes");
    expect((await r.orders())[0]?.status).toBe("paying");
    await r.demo.sender.setFrozen(r.familyId, true);
    await r.bot.idle();
    expect((await r.orders())[0]?.status).toBe("rejected");
    expect(tries).toBe(1); // never retried once frozen
    expect(r.outbox.at(-1)).toBe("The account is frozen by the sender. Nothing was paid.");
    await r.noLostMoney();
  });

  it("an unanswered request is cancelled after 24 hours, and the recipient is told", async () => {
    const clock = { now: new Date("2026-11-04T10:00:00Z") };
    const r = rig({ clock });
    const { order } = await request(r);
    clock.now = new Date("2026-11-04T20:00:00Z"); // 10 hours: still waiting
    expect(await r.tick()).toBe("");
    expect(await r.demo.sender.approvals(order.familyId)).toHaveLength(1);

    clock.now = new Date("2026-11-05T10:01:00Z");
    expect(await r.tick()).toBe(
      "Ada didn't answer in time, so this payment was cancelled. Nothing was paid. Please ask again if you still need it.",
    );
    expect((await r.orders())[0]?.status).toBe("expired");
    expect((await decide(r, order.id, "approved")).res).toEqual({
      ok: false,
      reason: "not_pending",
    });
    await r.noLostMoney();
  });

  it("an approval that arrives after the deadline expires instead of paying", async () => {
    const clock = { now: new Date("2026-11-04T10:00:00Z") };
    const r = rig({ clock });
    const { order } = await request(r);
    clock.now = new Date("2026-11-05T11:00:00Z");
    const { res, heard } = await decide(r, order.id, "approved");
    expect(res).toMatchObject({ ok: false, reason: "expired" });
    expect(heard).toMatch(/didn't answer in time/);
    expect(r.sim.pays.size).toBe(0);
  });

  it("an approval hours later gets a fresh price, never the old one", async () => {
    const clock = { now: new Date("2026-11-04T08:00:00Z") };
    const r = rig({ clock });
    const { order } = await request(r);
    const before = r.quoteCalls();
    clock.now = new Date("2026-11-04T11:00:00Z"); // quote was valid 10 minutes
    const { res } = await decide(r, order.id, "approved");
    expect(res.ok).toBe(true);
    expect(r.quoteCalls()).toBe(before + 1);
    const [o] = await r.noLostMoney();
    expect(Date.parse(o?.quote?.quotedAt ?? "")).toBe(clock.now.getTime());
    expect(o?.status).toBe("fulfilled");
  });

  it("an approval after midnight is carried onto a new order, and bought once", async () => {
    const clock = { now: new Date("2026-11-04T22:30:00Z") }; // 23:30 in Lagos
    const r = rig({ clock });
    const { order } = await request(r);
    expect(order.id.startsWith("20261104")).toBe(true);
    clock.now = new Date("2026-11-04T23:30:00Z"); // 00:30, next day in Lagos
    const { res, heard } = await decide(r, order.id, "approved");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.order.id).not.toBe(order.id);
    expect(res.order.id.startsWith("20261105")).toBe(true);
    expect(heard).toMatch(/Ada said yes[\s\S]*Done! Light ₦25,000 paid/);
    const all = await r.noLostMoney();
    expect(all.find((o) => o.id === order.id)?.status).toBe("expired");
    expect(all.find((o) => o.id === res.order.id)?.status).toBe("fulfilled");
    expect(r.sim.pays.has(order.id)).toBe(false);
    expect(r.sim.pays.get(res.order.id)).toBe(1);
    // The recipient heard about one bill, not two.
    expect(r.outbox.join("\n").match(/Done!/g)).toHaveLength(1);
  });

  it("a stricter preset sends smaller bills to the sender", async () => {
    const r = rig();
    await r.join();
    await r.say(SIX);
    expect(await r.say("yes")).toMatch(/Paying now/); // open preset: allowed
    expect(r.demo.sender.applyPreset(r.familyId, "strict")).toBe(true);
    await r.bot.idle();
    // The same request is now over the ₦5,000 threshold.
    await r.say(SIX);
    expect(await r.say("yes")).toMatch(/needs Ada's OK first.*₦6,000 is above the ₦5,000/);
    expect(await r.demo.sender.approvals(r.familyId)).toHaveLength(1);
  });
});
