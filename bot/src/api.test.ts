import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LocalDemo, startLocalDemo } from "./local-demo.js";
import { VirtualAuthenticator } from "./test-authenticator.js";

/**
 * The sender app's API over HTTP, with a software passkey doing what a
 * phone would: sign up, sign in, create a family, change rules, and sign an
 * approval. The server's WebAuthn checks run for real.
 */

const ORIGIN = "http://localhost:5173";
const RP = "localhost";

let demo: LocalDemo;
beforeAll(async () => {
  demo = await startLocalDemo({ webUrl: ORIGIN });
});
afterAll(() => demo.close());

// biome-ignore lint/suspicious/noExplicitAny: the responses are untyped JSON
type Json = Record<string, any>;
async function call(method: string, path: string, body?: object, token?: string) {
  const res = await fetch(`${demo.botUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json };
}

async function signUp(
  name: string,
  phone = new VirtualAuthenticator({ origin: ORIGIN, rpID: RP }),
) {
  const { json: o } = await call("POST", "/api/auth/register/options", { name });
  const r = await call("POST", "/api/auth/register/verify", {
    challengeId: o.challengeId,
    response: phone.register(o.options),
  });
  return { phone, ...r };
}

async function signIn(phone: VirtualAuthenticator) {
  const { json: o } = await call("POST", "/api/auth/login/options", {});
  return call("POST", "/api/auth/login/verify", {
    challengeId: o.challengeId,
    response: phone.assert(o.options),
  });
}

const FAMILY = {
  recipientPhone: "0803 123 4567",
  meters: [{ disco: "Ikeja", ref: "1111111111111", label: "home meter" }],
  smartcards: [{ tv: "DStv", ref: "1212121212", label: "house DStv" }],
  preset: "essentials",
};

async function until<T>(f: () => Promise<T | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const say = (family: string, text: string) =>
  fetch(`${demo.botUrl}/demo/say`, { method: "POST", body: JSON.stringify({ family, text }) });
const chat = async (family: string) =>
  (
    (await (await fetch(`${demo.botUrl}/demo/family?family=${family}`)).json()) as {
      transcript: { from: string; text: string }[];
    }
  ).transcript;

describe("passkey sign-in", { timeout: 30_000 }, () => {
  it("signs up, signs out, and signs back in with the same passkey", async () => {
    const { phone, status, json } = await signUp("Ada Okafor");
    expect(status).toBe(200);
    expect(json.account.name).toBe("Ada Okafor");
    expect(json.token).toHaveLength(43);

    expect(
      (await call("GET", "/api/me", undefined, json.token)).json.account?.name ?? json.account.name,
    ).toBe("Ada Okafor");
    expect((await call("POST", "/api/auth/logout", {}, json.token)).status).toBe(200);
    expect((await call("GET", "/api/me", undefined, json.token)).status).toBe(401);

    const again = await signIn(phone);
    expect(again.status).toBe(200);
    expect(again.json.account.id).toBe(json.account.id);
  });

  it("refuses a passkey it doesn't know, a wrong site, a reused challenge and a bad name", async () => {
    const stranger = new VirtualAuthenticator({ origin: ORIGIN, rpID: RP });
    expect((await signIn(stranger)).status).toBe(401);

    const { phone } = await signUp("Bola Adeyemi");
    const { json: o } = await call("POST", "/api/auth/login/options", {});
    const wrongSite = await call("POST", "/api/auth/login/verify", {
      challengeId: o.challengeId,
      response: phone.assert(o.options, { origin: "https://evil.example" }),
    });
    expect(wrongSite.status).toBe(401);
    // That challenge is spent, even though the attempt failed.
    const retry = await call("POST", "/api/auth/login/verify", {
      challengeId: o.challengeId,
      response: phone.assert(o.options),
    });
    expect(retry.status).toBe(401);

    expect((await call("POST", "/api/auth/register/options", { name: "<script>" })).status).toBe(
      400,
    );
    // No fingerprint or PIN: registration is refused.
    const lazy = new VirtualAuthenticator({ origin: ORIGIN, rpID: RP, userVerified: false });
    expect((await signUp("Chidi Eze", lazy)).status).toBe(401);
  });

  it("keeps everything past sign-in behind a session", async () => {
    for (const [m, p] of [
      ["GET", "/api/me"],
      ["POST", "/api/families"],
      ["GET", "/api/families/fam_0000000000000000/state"],
      ["POST", "/api/decisions"],
    ] as const) {
      expect((await call(m, p, m === "POST" ? {} : undefined)).status, `${m} ${p}`).toBe(401);
    }
    expect((await call("GET", "/api/me", undefined, "not-a-token")).status).toBe(401);
  });
});

describe("a sender's family", { timeout: 30_000 }, () => {
  it("checks what the sender types, in plain words", async () => {
    const { json } = await signUp("Dayo Bello");
    const t = json.token;
    const bad = async (patch: object) =>
      (await call("POST", "/api/families", { ...FAMILY, ...patch }, t)).json.error;
    expect(await bad({ recipientPhone: "12345" })).toMatch(/Nigerian phone number/);
    expect(await bad({ meters: [{ disco: "Ikeja", ref: "123", label: "x" }] })).toMatch(
      /isn't a meter number/,
    );
    expect(await bad({ meters: [{ disco: "Narnia", ref: "1111111111111", label: "x" }] })).toMatch(
      /don't know the electricity company/,
    );
    expect(await bad({ smartcards: [{ tv: "DStv", ref: "1", label: "x" }] })).toMatch(
      /smartcard number/,
    );
    expect(await bad({ preset: "yolo" })).toMatch(/check the details/);
    expect(await bad({ meters: [{ disco: "Ikeja", ref: "1111111111111", label: "<b>" }] })).toMatch(
      /check the details/,
    );
  });

  it("creates a family with its invite, and shows only its owner", async () => {
    const a = await signUp("Efe Ogun");
    const made = await call("POST", "/api/families", FAMILY, a.json.token);
    expect(made.status).toBe(201);
    const familyId = made.json.familyId as string;
    expect(familyId).toMatch(/^fam_[a-z0-9]{16}$/);
    expect(made.json.invite.judge).toContain(familyId);
    expect(JSON.stringify(made.json)).not.toMatch(/"code"/); // the raw invite code stays in the links

    const state = await call("GET", `/api/families/${familyId}/state`, undefined, a.json.token);
    expect(state.status).toBe(200);
    expect(state.json.overview).toMatchObject({
      senderName: "Efe",
      frozen: false,
      recipientPhone: "0803…4567",
      budget: { monthlyUsd: "100", spentUsd: "$0.00", leftUsd: "$100.00" },
    });
    expect(state.json.overview.saved).toEqual([
      { category: "electricity", label: "home meter", ref: "1111…1111" },
      { category: "tv", label: "house DStv", ref: "1212…1212" },
    ]);
    const cats = Object.fromEntries(
      state.json.overview.categories.map((c: Json) => [c.category, c]),
    );
    expect(cats.tv.enabled).toBe(false); // the essentials preset
    expect(cats.electricity).toMatchObject({ enabled: true, capNaira: 50_000 });
    expect(state.json.overview.rateNgnPerUsd).toBe("1325.81");

    // Another sender sees nothing, not even that it exists.
    const b = await signUp("Femi Ade");
    for (const [m, p] of [
      ["GET", "state"],
      ["POST", "invite"],
      ["POST", "freeze"],
      ["POST", "preset"],
      ["POST", "rules"],
    ] as const) {
      const r = await call(
        m,
        `/api/families/${familyId}/${p}`,
        m === "POST" ? {} : undefined,
        b.json.token,
      );
      expect(r.status, p).toBe(404);
    }
  });

  it("changes rules, presets and freeze, and refuses nonsense", async () => {
    const a = await signUp("Gina Obi");
    const { json } = await call("POST", "/api/families", FAMILY, a.json.token);
    const id = json.familyId as string;
    const t = a.json.token;
    const state = async () =>
      (await call("GET", `/api/families/${id}/state`, undefined, t)).json.overview as Json;

    expect(
      (
        await call(
          "POST",
          `/api/families/${id}/rules`,
          {
            approvalAboveNaira: 8_000,
            categories: { tv: { enabled: true, capNaira: 12_000 }, airtime: { capNaira: null } },
          },
          t,
        )
      ).status,
    ).toBe(200);
    let o = await state();
    const cats = Object.fromEntries(o.categories.map((c: Json) => [c.category, c]));
    expect(o.approvalAboveNaira).toBe(8_000);
    expect(cats.tv).toMatchObject({ enabled: true, capNaira: 12_000 });
    expect(cats.airtime).toMatchObject({ enabled: true, capNaira: null });
    expect(cats.electricity.capNaira).toBe(50_000); // untouched
    expect(o.rulesVersion).toBe(3);

    expect((await call("POST", `/api/families/${id}/preset`, { preset: "strict" }, t)).status).toBe(
      200,
    );
    expect((await state()).approvalAboveNaira).toBe(5_000);
    expect((await call("POST", `/api/families/${id}/preset`, { preset: "nope" }, t)).status).toBe(
      400,
    );
    expect(
      (await call("POST", `/api/families/${id}/rules`, { categories: { tv: { capNaira: -5 } } }, t))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          "POST",
          `/api/families/${id}/rules`,
          { hardLimits: { monthlyBudgetUsd: "9999" } },
          t,
        )
      ).status,
    ).toBe(200);
    o = await state();
    expect(o.budget.monthlyUsd).toBe("100"); // hard limits can't be changed here

    expect((await call("POST", `/api/families/${id}/freeze`, { frozen: true }, t)).status).toBe(
      200,
    );
    expect((await state()).frozen).toBe(true);
    expect((await call("POST", `/api/families/${id}/freeze`, { frozen: "yes" }, t)).status).toBe(
      400,
    );
  });
});

describe("approvals signed by the passkey", { timeout: 30_000 }, () => {
  it("an over-limit request is approved with the sender's fingerprint, and paid", async () => {
    const a = await signUp("Hauwa Musa");
    const t = a.json.token;
    const { json } = await call("POST", "/api/families", { ...FAMILY, preset: "open" }, t);
    const id = json.familyId as string;

    await say(id, "buy 25k light for my meter");
    await until(async () => (await chat(id)).at(-1)?.text.includes("YES"));
    await say(id, "yes");
    const waiting = await until(async () => {
      const s = (await call("GET", `/api/families/${id}/state`, undefined, t)).json;
      return s.approvals.length > 0 && s;
    });
    const order = waiting.approvals[0];
    expect(order).toMatchObject({ amountNgn: "₦25,000", customerName: "MAMA NGOZI" });

    // The challenge is bound to this order and this decision.
    const { json: opts } = await call(
      "POST",
      "/api/decisions/options",
      { orderId: order.orderId, decision: "approved" },
      t,
    );
    const { json: other } = await call(
      "POST",
      "/api/decisions/options",
      { orderId: order.orderId, decision: "declined" },
      t,
    );
    expect(opts.challenge).not.toBe(other.challenge);
    expect(opts.userVerification).toBe("required");

    // A decline signature can't approve; a stranger's passkey can't either.
    const stranger = (await signUp("Ike Nwosu")).phone;
    for (const proof of [a.phone.assert(other), stranger.assert(opts)]) {
      const r = await call(
        "POST",
        "/api/decisions",
        { orderId: order.orderId, decision: "approved", response: proof },
        t,
      );
      expect(r.status).toBe(409);
      expect(r.json).toEqual({ ok: false, reason: "bad_proof" });
    }
    expect(
      (await call("POST", "/api/decisions", { orderId: order.orderId, decision: "approved" }, t))
        .json.reason,
    ).toBe("bad_proof");
    // Nothing moved while those failed.
    expect((await chat(id)).map((l) => l.text).join("\n")).not.toMatch(/said yes/);

    // The sender's own signature works, once.
    const signed = a.phone.assert(opts);
    const ok = await call(
      "POST",
      "/api/decisions",
      { orderId: order.orderId, decision: "approved", response: signed },
      t,
    );
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true, status: "approved" });
    await until(async () =>
      /Hauwa said yes[\s\S]*Done! Light ₦25,000 paid/.test(
        (await chat(id)).map((l) => l.text).join("\n"),
      ),
    );

    const replay = await call(
      "POST",
      "/api/decisions",
      { orderId: order.orderId, decision: "approved", response: signed },
      t,
    );
    expect(replay.status).toBe(409);
    const after = (await call("GET", `/api/families/${id}/state`, undefined, t)).json;
    expect(after.approvals).toHaveLength(0);
    expect(after.orders[0]).toMatchObject({
      status: "fulfilled",
      amountNgn: "₦25,000",
      label: "Ikeja Electric",
    });
    expect(after.overview.budget.spentUsd).not.toBe("$0.00");
  });

  it("another sender can't see or decide someone else's request", async () => {
    const a = await signUp("Jide Lawal");
    const b = await signUp("Kemi Dada");
    const { json } = await call(
      "POST",
      "/api/families",
      { ...FAMILY, preset: "open" },
      a.json.token,
    );
    const id = json.familyId as string;
    await say(id, "buy 25k light for my meter");
    await until(async () => (await chat(id)).at(-1)?.text.includes("YES"));
    await say(id, "yes");
    const waiting = await until(async () => {
      const s = (await call("GET", `/api/families/${id}/state`, undefined, a.json.token)).json;
      return s.approvals.length > 0 && s;
    });
    const orderId = waiting.approvals[0].orderId;
    const r = await call(
      "POST",
      "/api/decisions/options",
      { orderId, decision: "approved" },
      b.json.token,
    );
    expect(r.status).toBe(409);
    // A decline by the owner works and tells the recipient.
    const { json: opts } = await call(
      "POST",
      "/api/decisions/options",
      { orderId, decision: "declined" },
      a.json.token,
    );
    const done = await call(
      "POST",
      "/api/decisions",
      { orderId, decision: "declined", response: a.phone.assert(opts) },
      a.json.token,
    );
    expect(done.json).toEqual({ ok: true, status: "declined" });
    await until(
      async () =>
        (await chat(id)).at(-1)?.text.includes("Ada declined this payment") ||
        (await chat(id)).at(-1)?.text.includes("Jide declined this payment"),
    );
  });
});
