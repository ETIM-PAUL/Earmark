import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FIELDS, plainHashes, problems, type Receipt } from "./receipts-privacy.js";

// The receipts privacy audit: reads every receipt the contract holds,
// straight from NEAR RPC, and checks that none carries a name, phone,
// meter or smartcard number. No keys, no backend, nothing written on chain.
//
//   pnpm audit:receipts                                  the testnet contract
//   pnpm audit:receipts --contract <id> [--rpc <url>]    any other deployment
//
// Every receipt: the order IDs come from the contract's own storage (the
// keys of its receipts map), their number must equal receipt_count(), and
// each one is read back through get_receipt(). Writes
// evidence/receipts-privacy-audit.md.

const ROOT = resolve(import.meta.dirname, "../..");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const CONTRACT = arg("--contract") ?? "earmark-receipts-9e9730f1.testnet";
const RPC = arg("--rpc") ?? "https://rpc.testnet.fastnear.com";

async function rpc<T>(params: Record<string, unknown>): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "audit", method: "query", params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (!body.result) throw new Error(`RPC ${JSON.stringify(body.error ?? res.status)}`);
  return body.result;
}

async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>({
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

/** Order IDs, from the keys of the contract's receipts map (storage prefix 0). */
async function orderIdsFromStorage(): Promise<{ ids: string[]; blockHeight: number }> {
  const r = await rpc<{ values: { key: string }[]; block_height: number }>({
    request_type: "view_state",
    finality: "final",
    account_id: CONTRACT,
    prefix_base64: Buffer.from([0]).toString("base64"),
  });
  const ids = r.values.map(({ key }) => {
    const k = Buffer.from(key, "base64");
    return k.subarray(5, 5 + k.readUInt32LE(1)).toString("utf8");
  });
  return { ids, blockHeight: r.block_height };
}

async function main() {
  console.log(`Receipts privacy audit: ${CONTRACT} via ${RPC}\n`);
  const [{ ids, blockHeight }, count] = await Promise.all([
    orderIdsFromStorage(),
    view<number>("receipt_count"),
  ]);
  const complete = ids.length === Number(count);
  console.log(
    `${complete ? "✓" : "✗"} ${ids.length} receipts in storage at block ${blockHeight}; receipt_count() says ${count}`,
  );

  const plain = plainHashes();
  const receipts: Receipt[] = [];
  for (const id of ids) {
    const r = await view<Receipt | null>("get_receipt", { order_id: id });
    if (r) receipts.push(r);
  }
  const flagged = receipts
    .map((r) => ({ orderId: String(r.orderId), issues: problems(r, plain) }))
    .filter((x) => x.issues.length > 0);
  const families = new Set(receipts.map((r) => r.familyId)).size;
  const simulated = receipts.filter((r) =>
    /^(?:drill|demo)-pay:|Smoke/.test(String(r.paymentTxHash)),
  ).length;

  const checks: [string, boolean][] = [
    [
      "Every receipt read: storage keys = receipt_count() = receipts returned",
      complete && receipts.length === ids.length,
    ],
    [
      "Only the 10 expected fields, no free-text field",
      receipts.every((r) => Object.keys(r).sort().join() === FIELDS.join()),
    ],
    [
      "No Nigerian phone number in any field",
      !flagged.some((f) => f.issues.some((i) => i.includes("phone"))),
    ],
    [
      "No meter or smartcard number (10+ digits) outside the order ID's timestamp",
      !flagged.some((f) => f.issues.some((i) => i.includes("10+ digits"))),
    ],
    [
      "No email address, no spaces (so no names)",
      !flagged.some((f) => f.issues.some((i) => /email|space/.test(i))),
    ],
    [
      "The customer reference is a 64-char hash, not the plain SHA-256 of the sandbox numbers these bills were bought for",
      !flagged.some((f) => f.issues.some((i) => i.includes("customerRefHash"))),
    ],
    [
      "Every other field matches its fixed format (IDs, category, status, amounts, references)",
      flagged.length === 0,
    ],
  ];
  for (const [what, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${what}`);
  for (const f of flagged) console.log(`  ✗ ${f.orderId}: ${f.issues.join("; ")}`);
  const pass = checks.every(([, ok]) => ok);
  console.log(
    `\n${pass ? "PASS" : "FAIL"}: ${receipts.length} receipts from ${families} families, ${flagged.length} with personal data or an unexpected field`,
  );

  const md = [
    "# Receipts privacy audit",
    "",
    `Run on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC with \`pnpm audit:receipts\`, against [\`${CONTRACT}\`](https://${CONTRACT.endsWith(".testnet") ? "testnet." : ""}nearblocks.io/address/${CONTRACT}) at block ${blockHeight}, through public RPC (${RPC}). No keys, no backend.`,
    "",
    `**${pass ? "PASS" : "FAIL"}: ${receipts.length} receipts from ${families} families, ${flagged.length} with personal data or an unexpected field.**`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...checks.map(([what, ok]) => `| ${what} | ${ok ? "✓" : "✗"} |`),
    "",
    "How it reads every receipt: the order IDs come from the contract's own storage (the keys of its receipts map, via `view_state`), their number must equal `receipt_count()`, and each receipt is read back through `get_receipt()`. A receipt the audit can't see would make the first check fail.",
    "",
    `What the receipts are: VTpass sandbox purchases from the biller drill and the demo, so the bills were real sandbox purchases. The payment into settlement is simulated in this build: ${simulated} of ${receipts.length} payment references are drill or demo labels, not NEAR transactions.`,
    "",
    "The contract enforces the same formats when a receipt is written (`contracts/receipts/src/lib.rs`); this audit checks the result from outside, the way anyone can.",
    "",
  ].join("\n");
  const dir = resolve(ROOT, "evidence");
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, "receipts-privacy-audit.md");
  await writeFile(file, md);
  console.log(`Report: ${file}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`audit stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
