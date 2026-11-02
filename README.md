# Earmark

Send money home with rules. Someone abroad funds a family account from any chain and signs spending rules once. The recipient then asks an AI assistant, in English or Pidgin, to pay bills inside those rules: prepaid electricity, airtime, data and TV.

> Status: in active development for the NEAR hackathon (tracks `realworld` and `agents`). This README grows into the full judge guide as the build lands.

## Repository layout

| Path                 | What it is                                                                  |
| -------------------- | --------------------------------------------------------------------------- |
| `packages/config`    | Validated environment config per provider; errors never echo secret values  |
| `packages/shared`    | Order, rule and receipt objects every part of the system agrees on          |
| `contracts/receipts` | NEAR contract holding on-chain receipts, with no personal data              |
| `services/orders`    | Order service: rule checks, the order lifecycle, refunds and reconciliation |
| `services/billers`   | Biller service: VTpass purchases, naira quotes and the float guard          |
| `bot`                | Telegram and WhatsApp assistant on NEAR AI Cloud                            |
| `apps/sender-web`    | Sender web app: rules, top-ups, receipts feed and approvals                 |
| `scripts`            | Operational scripts, including the account and key smoke check              |

## Build and test

Requirements: Node 22+, pnpm 12, and Rust stable with the `wasm32-unknown-unknown` target.

```sh
pnpm install
pnpm build   # TypeScript packages, the web app and the contract wasm
pnpm test    # vitest and cargo tests
pnpm lint
```

Copy `.env.example` to `.env` for local configuration. Keys are never committed.

Check that every account and key works (read-only; moves no money):

```sh
pnpm check:accounts
```

## Privacy

Names, phone numbers and meter numbers never go on-chain. Each receipt carries an HMAC-SHA256 of the customer reference, keyed by a per-family secret that stays in our database.

## Baseline

No code from before the hackathon. Open-source libraries in use: zod, React, Vite, near-sdk-rs, vitest and Biome.
