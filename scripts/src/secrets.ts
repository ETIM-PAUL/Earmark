/**
 * Secret scanning for pnpm audit:secrets. Pure functions: the CLI feeds
 * them file contents and .env values. Findings name a file, a line and
 * what matched (a variable name or a pattern name), never the value.
 */

export interface Finding {
  file: string;
  line: number;
  what: string;
}

/** Shapes of secrets that should never be in a file we commit. */
export const PATTERNS: { name: string; re: RegExp }[] = [
  // A NEAR secret key is 64 bytes (~88 base58 chars); public keys are ~44.
  { name: "NEAR private key", re: /\b(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{80,}/ },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { name: "VTpass secret key", re: /\bSK_[A-Za-z0-9]{20,}/ },
  { name: "API key (sk-…)", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  {
    // A 32-byte hex string next to the word "private" or "secret": tx hashes stay quiet.
    name: "hex private key",
    re: /(?:private|secret|seed)[\w"' ]{0,30}[:=]\s*["']?(?:0x)?[0-9a-fA-F]{64}\b/i,
  },
];

/** .env variables whose values are secret. URLs, IDs and knobs are not. */
export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|AUTH|PRIVATE|SEED|MNEMONIC/i;

/** KEY=VALUE pairs from a .env file. Quotes stripped, comments skipped. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m?.[1]) continue;
    let v = (m[2] ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out.set(m[1], v);
  }
  return out;
}

/** The values worth hunting for: secret by name, and long enough to be unique. */
export function secretValues(env: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of env) if (SECRET_NAME.test(k) && v.length >= 12) out.set(v, k);
  return out;
}

export function scan(file: string, text: string, values: Map<string, string>): Finding[] {
  const found: Finding[] = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    for (const p of PATTERNS) if (p.re.test(l)) found.push({ file, line: i + 1, what: p.name });
    for (const [v, name] of values) {
      if (l.includes(v)) found.push({ file, line: i + 1, what: `value of ${name}` });
    }
  });
  return found;
}

/** Tracked files that must never be: env files and key dumps. */
export function forbiddenPath(file: string): string | null {
  const base = file.split("/").at(-1) ?? file;
  if (/^\.env(\..*)?$/.test(base) && base !== ".env.example") return "env file";
  if (/\.(pem|key)$/.test(base)) return "key file";
  if (file.startsWith(".earmark/") || file.includes("/neardev/")) return "local key state";
  return null;
}
