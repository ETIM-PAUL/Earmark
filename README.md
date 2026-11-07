# Earmark

Send money home with rules. Someone abroad funds a family account from any chain and signs spending rules once. The recipient then asks an AI assistant, in English or Pidgin, to pay bills inside those rules: prepaid electricity, airtime, data and TV.

> Status: in active development for the NEAR hackathon (tracks `realworld` and `agents`). This README grows into the full judge guide as the build lands.

## Repository layout

| Path                 | What it is                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `packages/config`    | Validated environment config per provider; errors never echo secret values                |
| `packages/agent-api` | NEAR Intents Agent API integration: family policy, owner signing, flows, refusal messages |
| `packages/shared`    | Order, rule and receipt objects every part of the system agrees on                        |
| `contracts/receipts` | NEAR contract holding on-chain receipts, with no personal data                            |
| `services/orders`    | Order service: rule checks, the order lifecycle, refunds and reconciliation               |
| `services/billers`   | Biller service: VTpass purchases, naira quotes and the float guard                        |
| `bot`                | Telegram and WhatsApp assistant on NEAR AI Cloud                                          |
| `apps/sender-web`    | Sender web app: rules, top-ups, receipts feed and approvals                               |
| `scripts`            | Operational scripts, including the account and key smoke check                            |

## Build and test

Requirements: Node 24+ (`nvm use`), pnpm 12, Rust stable with the `wasm32-unknown-unknown` target, and [cargo-near](https://github.com/near/cargo-near) 0.22 (`cargo install --locked cargo-near`). The contract must be built with cargo-near: a plain `cargo build` wasm deploys but cannot report its errors.

```sh
pnpm install
pnpm build   # TypeScript packages, the web app and the contract wasm (cargo near)
pnpm test    # vitest, contract unit tests and near-workspaces sandbox tests
pnpm lint
```

Copy `.env.example` to `.env` for local configuration. Keys are never committed.

Check that every account and key works (read-only; moves no money):

```sh
pnpm check:accounts
```

Agent API spike (Phase 4). Without `SPIKE_ALLOW_WRITES=true` it runs read-only preflight checks; with it, it creates a family account on mainnet and moves about $1 to the settlement account:

```sh
pnpm spike:agent-api
```

Receipts contract on NEAR testnet (free faucet accounts, keys kept in `.earmark/`). It deploys, writes one smoke receipt and prints its page link:

```sh
pnpm build:contracts
pnpm deploy:receipts:testnet
pnpm --filter @earmark/sender-web dev   # then open the printed receipt.html link
```

Biller drill (Phase 9). Runs 20 paid orders through the order executor: real VTpass sandbox purchases, live NGN/USD quotes, the float guard and on-chain receipts on the testnet contract. Two orders are forced to fail and must refund. The payment into settlement and the refund are simulated until the money flow (Phase 8) lands. Takes about 15 minutes: VTpass refuses a repeat bill for the same number within 30 seconds, so bills for the sandbox's single test phone number queue one behind another:

```sh
pnpm drill:billers   # needs pnpm deploy:receipts:testnet first; report in .earmark/
```

The assistant (Phase 10): Telegram and WhatsApp in front of a NEAR AI Cloud model. The model only reads each message into fields; the biller, the number checks, the price, the YES and every rule check are code. In demo mode each chat gets its own demo family wired to the VTpass sandbox test meter, smartcard and phone, and a YES really buys in the sandbox and writes a testnet receipt. The payment into settlement is simulated until Phase 8:

```sh
pnpm build && pnpm start:bot   # prints an invite link for a demo family, and its judge view
pnpm eval:bot                  # 15 English and Pidgin phrasings through the real model
```

Recipient flow and public receipts (Phase 13). The recipient opens the invite link (`t.me/<bot>?start=<code>`, or `start <code>` on WhatsApp) and the chat is connected to the family. Each payment gets a public page with the amount, bill type, time and on-chain transaction, and no names, phone numbers, meter numbers or tokens. The page checks the transaction against the chain itself. The judge view shows one family in three panes: the sender's app, the recipient's chat (long numbers masked) and the chain:

```sh
pnpm --filter @earmark/sender-web dev   # serves receipt.html and judge.html on :5173
pnpm drill:recipient                    # one message → sandbox purchase → receipt on the page, timed
```

Hardening and failure drills (Phase 16). The drills run the bot, the demo wiring, the order executor and the float guard end to end against a simulated VTpass, payer and chain, with no keys. Each one must end in a clear message plus a refund or a retry, never a lost payment. They run in CI on every push to `main`. The audit looks for secrets in every file git would commit and, locally, for every `.env` secret value in the whole git history; it prints names, never values:

```sh
pnpm drill:failures   # VTpass down, float empty, wrong meter, double YES, Agent API error, RPC down…
pnpm audit:secrets
curl localhost:4003/status   # orders by status, stuck orders, float and recent alerts (localhost only)
```

Set `ALERTS_TELEGRAM_CHAT_ID` to have alerts (low float, stuck orders, missing receipts, failure rate, bot errors) sent to a Telegram chat as well as the console.

For WhatsApp, run a tunnel to `BOT_PORT`, set `BOT_PUBLIC_URL` to it, and set `<BOT_PUBLIC_URL>/webhooks/whatsapp` as the Twilio sandbox's incoming-message URL.

## Privacy

Names, phone numbers and meter numbers never go on-chain. Each receipt carries an HMAC-SHA256 of the customer reference, keyed by a per-family secret that stays in our database.

## Baseline

No code from before the hackathon. Open-source libraries in use: zod, React, Vite, near-sdk-rs, vitest, Biome, `@near-intents-agent-api/sdk` and near-api-js. The Agent API flows follow the patterns documented in the NEAR-Intents-Agent-API SDK README and examples repository.
