import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalItem, TeamCard } from "./Dashboard.js";
import { Onboarding } from "./Onboarding.js";
import type { AppConfig, ApprovalCard, Team } from "./types.js";

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
      onJoined={() => {}}
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

describe("a family of relatives", () => {
  const ada = { id: "a", name: "Ada Okafor", isOwner: true, you: true };
  const bola = { id: "b", name: "Bola Adeyemi", isOwner: false, you: false };
  const chidi = { id: "c", name: "Chidi Eze", isOwner: false, you: false };
  const team = (over: Partial<Team>): Team => ({
    members: [ada],
    required: 1,
    isOwner: true,
    maxMembers: 5,
    ...over,
  });
  const render = (t: Team) =>
    renderToStaticMarkup(<TeamCard familyId="fam_x" team={t} onChange={() => {}} />);

  it("offers to join a family, beside creating one", () => {
    const html = renderToStaticMarkup(
      <Onboarding
        config={config}
        account={{ id: "a", name: "Bola", familyIds: [] }}
        onCreated={() => {}}
        onJoined={() => {}}
      />,
    );
    expect(html).toContain("A relative invited me: join their family");
  });

  it("a lone sender can invite, but has no signature setting yet", () => {
    const html = render(team({}));
    expect(html).toContain("Add a relative");
    expect(html).not.toContain('aria-label="Signatures needed"');
  });

  it("with relatives, the creator picks how many must sign, up to the number there are", () => {
    const html = render(team({ members: [ada, bola, chidi], required: 2 }));
    expect(html).toContain('aria-label="Signatures needed"');
    expect(html).toContain("1 (any one relative)");
    expect(html).toContain("3 relatives");
    expect(html).not.toContain("4 relatives");
    expect(html).toContain("waits for 2 relatives");
    expect(html).toContain("Bola Adeyemi");
  });

  it("a relative who didn't set up the family can't hand out codes", () => {
    const html = render(team({ members: [ada, { ...bola, you: true }], isOwner: false }));
    expect(html).not.toContain("Add a relative");
  });

  const card: ApprovalCard = {
    orderId: "o1",
    what: "Ikeja Electric prepaid electricity",
    who: "1111…1111",
    customerName: "MAMA NGOZI",
    amountNgn: "₦25,000",
    amountUsd: "$18.85",
    reasons: ["It's above ₦5,000."],
    requestedAt: "2026-11-12T10:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    needed: 2,
    signedBy: ["Ada"],
    youSigned: false,
  };

  it("shows how many relatives have signed a payment, and who", () => {
    const html = renderToStaticMarkup(<ApprovalItem card={card} onChange={() => {}} />);
    expect(html).toContain("1 of 2 relatives have signed: Ada");
    expect(html).toContain("Approve");
  });

  it("after you sign, you can't approve again, but you can still decline", () => {
    const html = renderToStaticMarkup(
      <ApprovalItem card={{ ...card, youSigned: true }} onChange={() => {}} />,
    );
    expect(html).toContain("You approved. Waiting for another relative.");
    expect(html).not.toContain(">Approve<");
    expect(html).toContain("Decline");
  });

  it("a single-signature family shows no progress line", () => {
    const html = renderToStaticMarkup(
      <ApprovalItem card={{ ...card, needed: 1, signedBy: [] }} onChange={() => {}} />,
    );
    expect(html).not.toContain("relatives have signed");
  });
});
