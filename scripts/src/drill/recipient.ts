import { resolve } from "node:path";
import { Dialog, demoPorts, NearAiModel, newSession } from "@earmark/bot";
import { billersEnv, nearAiEnv, readEnv, vtpassEnv } from "@earmark/config";
import type { Order } from "@earmark/shared";
import { getReceipt, verifyReceiptTx } from "../../../apps/sender-web/src/receipts.js";

// Phase 13 drill: one payment from the recipient's message to the public
// receipts page, timed.
//
//   pnpm drill:recipient
//
// Real: the NEAR AI model, the VTpass sandbox purchase, the testnet receipt,
// and the page's own chain reads and transaction check. Simulated: the
// payment into settlement (Phase 8). Done when the receipt is on the page
// within 30 seconds of the bill being paid, with no personal data.

const ROOT = resolve(import.meta.dirname, "../../..");
try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  // fall back to the process environment
}
const LIMIT_MS = 30_000;
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function main() {
  const ai = readEnv(nearAiEnv);
  const vt = readEnv(vtpassEnv);
  const knobs = readEnv(billersEnv);
  const updates: { order: Order; at: number }[] = [];
  const demo = await demoPorts({
    vtpass: {
      baseUrl: vt.VTPASS_BASE_URL,
      apiKey: vt.VTPASS_API_KEY,
      publicKey: vt.VTPASS_PUBLIC_KEY,
      secretKey: vt.VTPASS_SECRET_KEY,
    },
    spreadBps: knobs.QUOTE_SPREAD_BPS,
    floatFloorNgn: knobs.VTPASS_FLOAT_FLOOR_NGN,
    model: new NearAiModel({
      baseUrl: ai.NEAR_AI_BASE_URL,
      apiKey: ai.NEAR_AI_API_KEY,
      model: ai.NEAR_AI_MODEL,
    }),
    testnetStateFile: resolve(ROOT, ".earmark/receipts-testnet.json"),
    receiptsPageUrl: "http://localhost:5173/receipt.html",
    onOrderUpdate: (order) => updates.push({ order, at: Date.now() }),
  });
  if (!demo.contractId)
    throw new Error("no testnet receipts contract. Run: pnpm deploy:receipts:testnet");
  const family = demo.createFamily("Ada");
  demo.connect("drill", family.familyId);
  const dialog = new Dialog(demo.ports);

  const text = "abeg buy 150 naira airtime for my line";
  let turn = await dialog.handle("drill", newSession(), text);
  log(`recipient: "${text}"\n  bot: ${turn.replies.join("\n  ")}`);
  if (turn.session.asking !== "confirm") throw new Error("no summary to confirm");
  const yesAt = Date.now();
  turn = await dialog.handle("drill", turn.session, "yes");
  log(`recipient: "yes"\n  bot: ${turn.replies.join("\n  ")}`);

  // Wait for the bill and its receipt (the executor runs in the background).
  const deadline = Date.now() + 5 * 60_000;
  const find = (pred: (o: Order) => boolean) => updates.find((u) => pred(u.order));
  while (!find((o) => (o.status === "fulfilled" || o.status === "refunded") && !!o.receiptTxHash)) {
    if (Date.now() > deadline) throw new Error("no receipt after 5 minutes");
    await new Promise((r) => setTimeout(r, 250));
  }
  const done = find((o) => o.status === "fulfilled" || o.status === "refunded");
  const written = find((o) => !!o.receiptTxHash);
  if (!done || !written) throw new Error("unreachable");
  const order = written.order;
  log(`bill ${order.status} ${secs(done.at - yesAt)} after YES; receipt tx ${order.receiptTxHash}`);

  // What the public page does: read the contract until the receipt shows.
  let onPage = 0;
  let receipt = null;
  while (!receipt) {
    receipt = await getReceipt("testnet", demo.contractId, order.id);
    if (!receipt) await new Promise((r) => setTimeout(r, 1_000));
  }
  onPage = Date.now();
  const check = await verifyReceiptTx(
    "testnet",
    demo.contractId,
    order.receiptTxHash as string,
    order.id,
  );

  const json = JSON.stringify(receipt);
  const secrets = [
    order.customerRef,
    order.customerName,
    order.fulfillment?.token,
    order.customerRefHash === receipt.customerRefHash ? null : "hash-mismatch",
  ].filter((s): s is string => !!s);
  const leaks = secrets.filter((s) => json.includes(s));
  const paidToPage = onPage - done.at;
  const pass =
    paidToPage <= LIMIT_MS &&
    check.verified &&
    leaks.length === 0 &&
    receipt.status === order.status;

  log(
    `on the public page ${secs(paidToPage)} after the bill was paid (${secs(onPage - yesAt)} after YES)`,
  );
  log(`transaction check: ${check.verified ? "verified on-chain" : `NOT verified: ${check.why}`}`);
  log(`personal data on the page: ${leaks.length ? leaks.join(", ") : "none"}`);
  log(
    `page: http://localhost:5173/receipt.html?network=testnet&contract=${demo.contractId}&order=${order.id}&tx=${order.receiptTxHash}`,
  );
  log(
    `${pass ? "PASS" : "FAIL"}: receipt on the page in ${secs(paidToPage)} (limit ${secs(LIMIT_MS)})`,
  );
  if (!pass) process.exitCode = 1;
  process.exit();
}

main().catch((e) => {
  console.error(`drill stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
