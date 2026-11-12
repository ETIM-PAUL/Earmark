import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Onboarding } from "./Onboarding.js";
import type { AppConfig } from "./types.js";

const config: AppConfig = {
  network: "testnet",
  contractId: "earmark-receipts.local",
  rpcUrl: null,
  presets: [
    { name: "open", label: "Open", about: "Everything on." },
    { name: "essentials", label: "Essentials", about: "Light, airtime and data." },
  ],
  topUp: { enabled: false, why: "Needs the mainnet accounts." },
};

describe("family setup", () => {
  const html = renderToStaticMarkup(
    <Onboarding
      config={config}
      account={{ id: "acct_1", name: "Ada", familyIds: [] }}
      onCreated={() => {}}
    />,
  );

  it("asks for the recipient's number, with a label a screen reader can use", () => {
    expect(html).toContain("Their phone number");
    expect(html).toContain('inputMode="tel"');
    expect(html).toContain("required");
  });

  it("offers every preset from the server, with the first sensible one chosen", () => {
    expect(html).toContain("Open");
    expect(html).toContain("Essentials");
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios.filter((r) => r.includes("checked"))).toEqual([
      expect.stringContaining('value="essentials"'),
    ]);
    expect(html).toContain('role="radiogroup"');
  });

  it("explains the demo numbers and doesn't ask for a password", () => {
    expect(html).toContain("1111111111111");
    expect(html.toLowerCase()).not.toContain("password");
  });
});
