import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LocalDemo, startLocalDemo } from "./local-demo.js";
import { ruleExtraction } from "./mock/rule-model.js";

/** make demo, end to end over HTTP: no keys, no network, no money. */

let demo: LocalDemo;
beforeAll(async () => {
  demo = await startLocalDemo();
});
afterAll(() => demo.close());

const say = (text: string) =>
  fetch(`${demo.botUrl}/demo/say`, {
    method: "POST",
    body: JSON.stringify({ family: demo.familyId, text }),
  });
const view = async () =>
  (await (await fetch(`${demo.botUrl}/demo/family?family=${demo.familyId}`)).json()) as {
    transcript: { from: string; text: string }[];
    receipts: { orderId: string; txHash: string }[];
  };
async function rpc(method: string, params: object) {
  const res = await fetch(demo.chainUrl, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as { result?: { result: number[] } }).result;
}
async function until<T>(f: () => Promise<T | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("the keyless local demo", () => {
  it("pays a bill from a chat message and writes a receipt the page can read", async () => {
    await say("abeg buy 5k light for my meter");
    const summary = await until(async () => {
      const t = (await view()).transcript.at(-1);
      return t?.from === "bot" && /YES/.test(t.text) ? t.text : false;
    });
    expect(summary).toMatch(/MAMA NGOZI/);
    expect(summary).toMatch(/₦5,000/);

    await say("yes");
    const seen = await until(async () => {
      const v = await view();
      return v.receipts.length > 0 ? v : false;
    });
    const receipt = seen.receipts[0];
    expect(receipt?.txHash).toHaveLength(44);

    // What the public page reads from the chain, with no personal data.
    const read = await rpc("query", {
      request_type: "call_function",
      account_id: "earmark-receipts.local",
      method_name: "get_receipt",
      args_base64: Buffer.from(JSON.stringify({ order_id: receipt?.orderId })).toString("base64"),
    });
    const onChain = Buffer.from(read?.result ?? []).toString();
    expect(JSON.parse(onChain)).toMatchObject({ status: "fulfilled", category: "electricity" });
    expect(onChain).not.toMatch(/MAMA|1111111111111|08011111111/);

    const chat = (await view()).transcript.map((l) => l.text).join("\n");
    expect(chat).toMatch(/E don do! Light ₦5,000 don pay/); // "abeg" → Pidgin
    expect(chat).toMatch(/Your token: 1234…7890/); // the judge view masks long numbers
    expect(chat).toMatch(/Receipt: http:\/\/localhost:5173\/receipt\.html/);
  });

  it("is what the public page reads: same code, local chain, tx verified", async () => {
    // The page picks the local chain from ?rpc=…; set it before the page's code loads.
    (globalThis as { location?: unknown }).location = {
      search: `?rpc=${encodeURIComponent(demo.chainUrl)}`,
    };
    const page = await import("../../apps/sender-web/src/receipts.js");
    expect(page.LOCAL_RPC).toBe(demo.chainUrl);
    const receipts = await page.getFamilyReceipts(
      "testnet",
      "earmark-receipts.local",
      demo.familyId,
    );
    expect(receipts).toHaveLength(1);
    const [r] = receipts;
    const tx = (await view()).receipts[0]?.txHash ?? "";
    expect(
      await page.verifyReceiptTx("testnet", "earmark-receipts.local", tx, r?.orderId ?? ""),
    ).toMatchObject({
      verified: true,
    });
    // A hash for another order, or an invented one, is not verified.
    expect(
      await page.verifyReceiptTx(
        "testnet",
        "earmark-receipts.local",
        tx,
        "202601010000aaaaaaaaaaaa",
      ),
    ).toMatchObject({
      verified: false,
    });
    expect(
      await page.verifyReceiptTx(
        "testnet",
        "earmark-receipts.local",
        "1".repeat(44),
        r?.orderId ?? "",
      ),
    ).toMatchObject({
      verified: false,
    });
  });

  it("refuses what the family's rules refuse, in code", async () => {
    await say("buy 600k light for my meter"); // above the pilot limit
    const t = await until(async () => {
      const l = (await view()).transcript.at(-1);
      return l?.from === "bot" && /more than/.test(l.text) ? l.text : false;
    });
    expect(t).toMatch(/₦500,000/);
  });
});

describe("the sender's side over HTTP", () => {
  const sender = (path: string, body?: object) =>
    fetch(`${demo.botUrl}/sender/${path}`, {
      method: body ? "POST" : "GET",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const state = async () =>
    (await (await sender(`state?family=${demo.familyId}`)).json()) as {
      overview: { frozen: boolean };
      approvals: { orderId: string; amountNgn: string; reasons: string[] }[];
    };

  it("shows an over-limit request, and an approval pays it", async () => {
    await say("buy 25k light for my meter");
    await until(async () => (await view()).transcript.at(-1)?.text.includes("YES"));
    await say("yes");
    const waiting = await until(async () => {
      const s = await state();
      return s.approvals.length > 0 && s;
    });
    expect(waiting.approvals[0]).toMatchObject({ amountNgn: "₦25,000" });
    expect(waiting.approvals[0]?.reasons[0]).toMatch(/above the ₦20,000/);

    const res = await sender("decide", {
      orderId: waiting.approvals[0]?.orderId,
      decision: "approved",
    });
    expect(res.status).toBe(200);
    await until(async () => {
      const t = (await view()).transcript.map((l) => l.text).join("\n");
      return /Ada said yes[\s\S]*Done! Light ₦25,000 paid/.test(t);
    });
    expect((await state()).approvals).toHaveLength(0);
    // Deciding twice is refused.
    const again = await sender("decide", {
      orderId: waiting.approvals[0]?.orderId,
      decision: "declined",
    });
    expect(again.status).toBe(409);
  });

  it("freezes the account, and refuses what it shouldn't take", async () => {
    expect((await sender("freeze", { family: demo.familyId, frozen: true })).status).toBe(200);
    expect((await state()).overview.frozen).toBe(true);
    await say("buy 5k light for my meter");
    await until(async () => (await view()).transcript.at(-1)?.text.includes("YES"));
    await say("yes");
    await until(async () =>
      (await view()).transcript.at(-1)?.text.includes("The account is frozen by the sender"),
    );
    expect((await sender("freeze", { family: demo.familyId, frozen: false })).status).toBe(200);
    expect((await sender("preset", { family: demo.familyId, preset: "nonsense" })).status).toBe(
      400,
    );
    expect((await sender("decide", { orderId: 1, decision: "approved" })).status).toBe(400);
    expect((await sender("state?family=fam_0000000000000000")).status).toBe(404);
  });
});

describe("the rule-based reader", () => {
  it("reads the demo phrasings, English and Pidgin", () => {
    expect(ruleExtraction("abeg buy 10k light for my meter")).toMatchObject({
      intent: "pay_bill",
      language: "pcm",
      category: "electricity",
      amountNaira: 10_000,
      customerRef: "SELF",
    });
    expect(ruleExtraction("1,500 MTN airtime for 0803 123 4567")).toMatchObject({
      category: "airtime",
      provider: "mtn",
      amountNaira: 1500,
      customerRef: "08031234567",
      language: "en",
    });
    expect(ruleExtraction("how much is left?").intent).toBe("balance");
    expect(ruleExtraction("I am fine").language).toBe("en");
  });
});
