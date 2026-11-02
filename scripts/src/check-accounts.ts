import { resolve } from "node:path";
import { runAll } from "./checks.js";

// pnpm check:accounts — Phase 2 "done when": every key and account answers.
// Reads ../.env if present. Exits 1 if any configured check fails.

try {
  process.loadEnvFile(resolve(import.meta.dirname, "../../.env"));
} catch {
  // No .env: fall back to the process environment (CI, secrets manager).
}

const icon = { ok: "✓", skipped: "–", failed: "✗" } as const;
const results = await runAll({ env: process.env, fetch });
const width = Math.max(...results.map((r) => r.name.length));

for (const r of results) console.log(`${icon[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);

const count = (s: string) => results.filter((r) => r.status === s).length;
console.log(`\n${count("ok")} ok, ${count("skipped")} not configured, ${count("failed")} failed`);
process.exitCode = count("failed") > 0 ? 1 : 0;
