import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Finding, forbiddenPath, PATTERNS, parseEnv, scan, secretValues } from "./secrets.js";

// pnpm audit:secrets — Phase 16. Looks for secrets in every file git would
// commit (tracked, plus untracked files that aren't ignored) and in the
// whole git history. Hunts for:
//   - the actual values of secret variables in .env, and the private keys
//     in .earmark/*.json, when those files exist (local runs);
//   - the shapes of keys and tokens (always, so CI checks too).
// Prints file, line and variable or pattern name. Never prints a value.
// Exits 1 on any finding.

const ROOT = resolve(import.meta.dirname, "../..");
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout;
};

// Values to hunt for. .env.* backups count too.
const values = new Map<string, string>();
for (const f of readdirSync(ROOT).filter((f) => /^\.env(\..*)?$/.test(f) && f !== ".env.example")) {
  for (const [v, k] of secretValues(parseEnv(readFileSync(join(ROOT, f), "utf8")))) {
    values.set(v, k);
  }
}
try {
  for (const f of readdirSync(join(ROOT, ".earmark")).filter((f) => f.endsWith(".json"))) {
    const text = readFileSync(join(ROOT, ".earmark", f), "utf8");
    for (const m of text.matchAll(
      /"(?:privateKey|private_key|secretKey|secret_key)"\s*:\s*"([^"]{12,})"/g,
    )) {
      if (m[1]) values.set(m[1], `.earmark/${f} key`);
    }
  }
} catch {
  // no local key state
}

const findings: Finding[] = [];

// 1. Files git would commit.
const files = [
  ...git("ls-files", "-z").split("\0"),
  ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
].filter(Boolean);
for (const file of files) {
  const why = forbiddenPath(file);
  if (why) findings.push({ file, line: 0, what: why });
  let text: string;
  try {
    const buf = readFileSync(join(ROOT, file));
    if (buf.includes(0)) continue; // binary
    text = buf.toString("utf8");
  } catch {
    continue; // deleted in the working tree
  }
  findings.push(...scan(file, text, values));
}

// 2. Every commit, for the .env values: a secret removed later is still leaked.
let historyHits = 0;
if (values.size > 0) {
  const dir = mkdtempSync(join(tmpdir(), "earmark-audit-"));
  const list = join(dir, "values");
  try {
    writeFileSync(list, [...values.keys()].join("\n"), { mode: 0o600 });
    const revs = git("rev-list", "--all").split("\n").filter(Boolean);
    for (let i = 0; i < revs.length; i += 200) {
      const out = git("grep", "-F", "-l", "-f", list, ...revs.slice(i, i + 200));
      for (const hit of out.split("\n").filter(Boolean)) {
        historyHits += 1;
        // "<rev>:<path>": name the commit and file, not the value.
        const [rev = "", ...path] = hit.split(":");
        findings.push({
          file: `${rev.slice(0, 8)}:${path.join(":")}`,
          line: 0,
          what: "a .env value in history",
        });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. The ignore rules still cover what they must.
for (const p of [".env", ".env.backup", ".earmark/receipts-testnet.json", "x.pem"]) {
  if (spawnSync("git", ["check-ignore", "-q", p], { cwd: ROOT }).status !== 0) {
    findings.push({ file: ".gitignore", line: 0, what: `does not ignore ${p}` });
  }
}

const unique = [...new Map(findings.map((f) => [`${f.file}:${f.line}:${f.what}`, f])).values()];
for (const f of unique) console.log(`✗ ${f.file}${f.line ? `:${f.line}` : ""}  ${f.what}`);
console.log(
  `\nScanned ${files.length} files and ${values.size > 0 ? "the full git history" : "no history (no .env here)"} for ${values.size} secret values and ${PATTERNS.length} key shapes: ${unique.length} finding${unique.length === 1 ? "" : "s"}${historyHits ? `, ${historyHits} in history` : ""}.`,
);
process.exitCode = unique.length > 0 ? 1 : 0;
