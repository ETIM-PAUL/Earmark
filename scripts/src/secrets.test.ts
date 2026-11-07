import { describe, expect, it } from "vitest";
import { forbiddenPath, parseEnv, scan, secretValues } from "./secrets.js";

describe("secret scan", () => {
  const env = parseEnv(
    [
      "# comment",
      // Built, so this file doesn't trip the scan itself.
      `VTPASS_SECRET_KEY=${"SK"}_${"abcdefghijklmnopqrstuvwx"}`,
      'NEAR_AI_API_KEY="quoted-value-1234567"',
      "VTPASS_BASE_URL=https://sandbox.vtpass.com/api",
      "SHORT_TOKEN=abc",
    ].join("\n"),
  );

  it("hunts secret values by name, not URLs or short ones", () => {
    expect([...secretValues(env).values()]).toEqual(["VTPASS_SECRET_KEY", "NEAR_AI_API_KEY"]);
  });

  it("names the variable or pattern, never the value", () => {
    const text = `const k = "quoted-value-1234567";\nconst near = "ed25519:${"5".repeat(88)}";`;
    const found = scan("src/x.ts", text, secretValues(env));
    expect(found).toEqual([
      { file: "src/x.ts", line: 1, what: "value of NEAR_AI_API_KEY" },
      { file: "src/x.ts", line: 2, what: "NEAR private key" },
    ]);
    expect(JSON.stringify(found)).not.toContain("quoted-value");
  });

  it("leaves public keys and tx hashes alone", () => {
    const text = `pk ed25519:${"5".repeat(44)}\ntx 0x${"a".repeat(64)}\nhash: ${"b".repeat(64)}`;
    expect(scan("README.md", text, new Map())).toEqual([]);
    expect(scan("a.ts", `privateKey: "0x${"c".repeat(64)}"`, new Map())).toHaveLength(1);
  });

  it("flags env and key files, but not the example", () => {
    expect(forbiddenPath(".env")).toBe("env file");
    expect(forbiddenPath("bot/.env.local")).toBe("env file");
    expect(forbiddenPath(".env.example")).toBeNull();
    expect(forbiddenPath(".earmark/receipts-testnet.json")).toBe("local key state");
    expect(forbiddenPath("README.md")).toBeNull();
  });
});
