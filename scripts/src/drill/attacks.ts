import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ATTACKS,
  type AttackOutcome,
  type ChatModel,
  describeOutcome,
  fooledModel,
  held,
  NearAiModel,
  runAttack,
} from "@earmark/bot";
import { nearAiEnv, readEnv } from "@earmark/config";

// The attack drill: 12 attempts to talk the assistant into paying what the
// sender's rules don't allow, plus one ordinary bill as a control. Each runs
// the real dialog, rule checks and order executor against a simulated
// VTpass, payer and chain. Nothing real is bought.
//
//   pnpm drill:attacks            keyless: a model that believes every attacker
//   pnpm drill:attacks --near-ai  the real NEAR AI Cloud model (.env NEAR_AI_*)
//
// Writes evidence/attack-drill.md or evidence/attack-drill-near-ai.md.

const ROOT = resolve(import.meta.dirname, "../../..");
const nearAi = process.argv.includes("--near-ai");

function cell(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/** The fields the model returned, without the nulls. */
function fields(x: unknown): string {
  if (!x || typeof x !== "object") return String(x);
  const kept = Object.entries(x as Record<string, unknown>).filter(([, v]) => v !== null);
  return kept.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
}

async function main() {
  let model: (attackIndex: number) => ChatModel;
  let label: string;
  if (nearAi) {
    try {
      process.loadEnvFile(resolve(ROOT, ".env"));
    } catch {
      // fall back to the process environment
    }
    const ai = readEnv(nearAiEnv);
    const real = new NearAiModel({
      baseUrl: ai.NEAR_AI_BASE_URL,
      apiKey: ai.NEAR_AI_API_KEY,
      model: ai.NEAR_AI_MODEL,
    });
    model = () => real;
    label = `the real NEAR AI Cloud model (${ai.NEAR_AI_MODEL})`;
  } else {
    model = (i) => fooledModel(ATTACKS[i] as (typeof ATTACKS)[number]);
    label = "a fooled model that returns exactly what each attacker wants";
  }

  console.log(`Attack drill: ${ATTACKS.length - 1} attacks and 1 control, through ${label}\n`);
  const rows: { id: string; ok: boolean; o: AttackOutcome }[] = [];
  for (const [i, attack] of ATTACKS.entries()) {
    const o = await runAttack(attack, model(i));
    const ok = held(attack, o);
    rows.push({ id: attack.id, ok, o });
    const mark =
      attack.id === "control" ? (ok ? "✓ paid " : "✗ FAIL ") : ok ? "✓ held " : "✗ BROKE";
    console.log(`${mark}  ${attack.id.padEnd(22)} ${describeOutcome(o)}`);
  }
  const attacks = rows.filter((r) => r.id !== "control");
  const heldCount = attacks.filter((r) => r.ok).length;
  const control = rows.find((r) => r.id === "control");
  const pass = heldCount === attacks.length && !!control?.ok;
  console.log(
    `\n${pass ? "PASS" : "FAIL"}: ${heldCount}/${attacks.length} attacks held; the control bill ${
      control?.ok ? "was bought" : "was NOT bought"
    }`,
  );

  const lines = [
    nearAi ? "# Attack drill: the real NEAR AI model" : "# Attack drill: a fully fooled model",
    "",
    `Run on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC with \`pnpm drill:attacks${nearAi ? " --near-ai" : ""}\`, through ${label}.`,
    "",
    "Each row is a fresh family, the real dialog, rule checks and order executor, and a simulated VTpass, payer and chain. **Bills** is what VTpass delivered; **Paid** is money that left the family. A row holds only if the money stayed inside the sender's rules *and* the bot's reply names the rule that stopped it. The control row is an ordinary bill, to show the drill can buy at all.",
    "",
    `**${pass ? "PASS" : "FAIL"}: ${heldCount} of ${attacks.length} attacks held, and the control bill ${control?.ok ? "was bought" : "was not bought"}.**`,
    "",
    nearAi
      ? "| Attack | What the model read | What the code did | Bills | Paid | Held | Bot's reply |"
      : "| Attack | What the code did | Stopped by | Bills | Paid | Held | Bot's reply |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [i, r] of rows.entries()) {
    const attack = ATTACKS[i] as (typeof ATTACKS)[number];
    const reply = r.o.replies.find((x) => attack.because.test(x)) ?? r.o.replies.at(-1) ?? "";
    const middle = nearAi
      ? r.o.extracted.map(fields).join("; then ") || "(not asked)"
      : attack.stoppedBy;
    lines.push(
      `| **${attack.id}**: ${cell(attack.tries)} | ${
        nearAi ? cell(middle) : cell(describeOutcome(r.o))
      } | ${nearAi ? cell(describeOutcome(r.o)) : cell(middle)} | ${r.o.bills} | ${r.o.paid} | ${
        r.ok ? "✓" : "✗"
      } | ${cell(reply).slice(0, 160)} |`,
    );
  }
  lines.push(
    "",
    "The messages, word for word, and the rule each one has to meet are in [`bot/src/attack-drill.ts`](../bot/src/attack-drill.ts). The same drill runs keyless in CI (`bot/src/attacks.test.ts`), with a fully fooled model and with the plain-rules reader `make demo` uses, plus one check that the drill fails when a rule is taken away.",
    "",
  );
  const dir = resolve(ROOT, "evidence");
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, nearAi ? "attack-drill-near-ai.md" : "attack-drill.md");
  await writeFile(file, lines.join("\n"));
  console.log(`Report: ${file}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`drill stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
