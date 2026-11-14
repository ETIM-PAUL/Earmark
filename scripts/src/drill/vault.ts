import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NearVault, VaultRefusal } from "@earmark/billers";
import { ATTACKS, type DemoWiring, fooledModel, runAttack, VaultSync } from "@earmark/bot";
import { lagosTimestamp } from "@earmark/shared";
import type { KeyPairString } from "near-api-js";

// The vault drill, on NEAR testnet: a new family set up through the real
// bot code (registered, funded and its numbers allowed on the vault), one
// ordinary bill paid by the vault in test USDC, then what a compromised
// payment path could try with the agent's key. The vault must refuse each
// one on chain. Bills are simulated VTpass; nothing real is bought.
//
//   pnpm deploy:vault:testnet   (once)
//   pnpm build:ts && pnpm drill:vault
//
// Writes evidence/vault-drill.md, with a NearBlocks link for every step.

const ROOT = resolve(import.meta.dirname, "../../..");
const RPC = "https://rpc.testnet.fastnear.com";
const tx = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;

interface State {
  token: { accountId: string };
  vault: { accountId: string };
  admin: { accountId: string; privateKey: KeyPairString };
  agent: { accountId: string };
  agentPayKey: KeyPairString;
  settlement: { accountId: string };
}

async function main() {
  const state = JSON.parse(
    await readFile(resolve(ROOT, ".earmark/vault-testnet.json"), "utf8").catch(() => {
      throw new Error("no .earmark/vault-testnet.json: run pnpm deploy:vault:testnet first");
    }),
  ) as State;
  const vault = new NearVault({
    rpcUrl: RPC,
    vaultId: state.vault.accountId,
    tokenId: state.token.accountId,
    agent: { accountId: state.agent.accountId, privateKey: state.agentPayKey },
    admin: state.admin,
  });
  const sync = new VaultSync(vault, (m) => console.error(m));
  let demo: DemoWiring | null = null;

  console.log(`Vault drill on ${state.vault.accountId} (NEAR testnet)\n`);
  const control = ATTACKS.find((a) => a.id === "control");
  if (!control) throw new Error("control attack missing");
  const o = await runAttack(control, fooledModel(control), {
    payer: sync.payer(),
    onDemo: (d) => {
      demo = d;
      sync.attach(d);
    },
  });
  const order = o.orders[0];
  if (!order?.paymentTxHash || o.bills !== 1) {
    throw new Error(`the ordinary bill wasn't paid by the vault: ${o.replies.join(" | ")}`);
  }
  const familyId = order.familyId;
  const rows: { step: string; result: string; link: string; ok: boolean }[] = [];
  rows.push({
    step: `The relative asks for ₦5,000 of light and says YES (family ${familyId}, set up on the vault by the bot)`,
    result: `Paid by the vault: ${Number(order.quote?.amountUsdcAtomic) / 1e6} test USDC to settlement, then the bill was bought`,
    link: tx(order.paymentTxHash),
    ok: true,
  });
  console.log(`✓ bill paid by the vault: ${tx(order.paymentTxHash)}`);

  // A compromised payment path, holding the agent's pay-only key.
  const fresh = () => `${lagosTimestamp()}${randomBytes(6).toString("hex")}`;
  const attempts: [string, () => Promise<unknown>, string][] = [
    [
      "Pay the same order again",
      () =>
        vault.pay({
          familyId,
          orderId: order.id,
          category: order.category,
          amountUsdcAtomic: order.quote?.amountUsdcAtomic ?? "1",
          customerRefHash: order.customerRefHash,
        }),
      "ERR_ALREADY_PAID",
    ],
    [
      "Pay a meter the sender never added",
      () =>
        vault.pay({
          familyId,
          orderId: fresh(),
          category: "electricity",
          amountUsdcAtomic: "1000000",
          customerRefHash: "0".repeat(64),
        }),
      "ERR_NOT_ON_LIST",
    ],
    [
      "Pay $60 at once (the sender's cap is $50)",
      () =>
        vault.pay({
          familyId,
          orderId: fresh(),
          category: "electricity",
          amountUsdcAtomic: "60000000",
          customerRefHash: order.customerRefHash,
        }),
      "ERR_OVER_PER_PAYMENT",
    ],
    [
      "Pay after the sender froze the account in the app",
      async () => {
        await (demo as DemoWiring | null)?.sender.setFrozen(familyId, true);
        return vault.pay({
          familyId,
          orderId: fresh(),
          category: "electricity",
          amountUsdcAtomic: "1000000",
          customerRefHash: order.customerRefHash,
        });
      },
      "ERR_FROZEN",
    ],
  ];
  for (const [step, run, want] of attempts) {
    try {
      const out = (await run()) as { txHash: string };
      rows.push({
        step,
        result: "PAID: the vault did not refuse",
        link: tx(out.txHash),
        ok: false,
      });
      console.log(`✗ ${step}: paid`);
    } catch (e) {
      if (!(e instanceof VaultRefusal)) throw e;
      const ok = e.code === want;
      rows.push({
        step,
        result: `Refused on chain: ${e.code} (${e.detail}). Nothing moved`,
        link: tx(e.txHash),
        ok,
      });
      console.log(`${ok ? "✓" : "✗"} ${step}: ${e.code} ${tx(e.txHash)}`);
    }
  }

  const f = await vault.family(familyId);
  const pass = rows.every((r) => r.ok);
  const md = [
    "# Vault drill: NEAR testnet",
    "",
    `Run on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC with \`pnpm drill:vault\`, against the vault [\`${state.vault.accountId}\`](https://testnet.nearblocks.io/address/${state.vault.accountId}) and its test USDC [\`${state.token.accountId}\`](https://testnet.nearblocks.io/address/${state.token.accountId}). Testnet only; the token is a faucet token worth nothing.`,
    "",
    "The family was created by the bot, which registered it on the vault with the sender's hard limits, allowed its numbers (as salted hashes) and funded it with 100 test USDC. The bill itself is a simulated VTpass purchase. The four attempts after it use the agent's real key, which can only call `pay`: what a compromised payment path could do.",
    "",
    `**${pass ? "PASS" : "FAIL"}: the ordinary bill was paid by the vault, and ${rows.filter((r, i) => i > 0 && r.ok).length} of ${rows.length - 1} attempts were refused on chain.**`,
    "",
    "| Step | Result | Transaction |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.step} | ${r.ok ? "✓" : "✗"} ${r.result} | [NearBlocks](${r.link}) |`),
    "",
    `After the drill the family holds ${Number(f?.balance) / 1e6} test USDC, has spent ${Number(f?.spent_this_month) / 1e6} this month, and is ${f?.limits.frozen ? "frozen" : "not frozen"}.`,
    "",
  ].join("\n");
  await mkdir(resolve(ROOT, "evidence"), { recursive: true });
  await writeFile(resolve(ROOT, "evidence/vault-drill.md"), md);
  console.log(`\n${pass ? "PASS" : "FAIL"}. Report: evidence/vault-drill.md`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`drill stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
