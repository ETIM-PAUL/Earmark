# Receipts privacy audit

Run on 2026-11-14 15:17 UTC with `pnpm audit:receipts`, against [`earmark-receipts-9e9730f1.testnet`](https://testnet.nearblocks.io/address/earmark-receipts-9e9730f1.testnet) at block 277674303, through public RPC (https://rpc.testnet.fastnear.com). No keys, no backend.

**PASS: 63 receipts from 6 families, 0 with personal data or an unexpected field.**

| Check                                                                                                              | Result |
| ------------------------------------------------------------------------------------------------------------------ | ------ |
| Every receipt read: storage keys = receipt_count() = receipts returned                                             | ✓      |
| Only the 10 expected fields, no free-text field                                                                    | ✓      |
| No Nigerian phone number in any field                                                                              | ✓      |
| No meter or smartcard number (10+ digits) outside the order ID's timestamp                                         | ✓      |
| No email address, no spaces (so no names)                                                                          | ✓      |
| The customer reference is a 64-char hash, not the plain SHA-256 of the sandbox numbers these bills were bought for | ✓      |
| Every other field matches its fixed format (IDs, category, status, amounts, references)                            | ✓      |

How it reads every receipt: the order IDs come from the contract's own storage (the keys of its receipts map, via `view_state`), their number must equal `receipt_count()`, and each receipt is read back through `get_receipt()`. A receipt the audit can't see would make the first check fail.

What the receipts are: VTpass sandbox purchases from the biller drill and the demo, so the bills were real sandbox purchases. The payment into settlement is simulated in this build: 63 of 63 payment references are drill or demo labels, not NEAR transactions.

The contract enforces the same formats when a receipt is written (`contracts/receipts/src/lib.rs`); this audit checks the result from outside, the way anyone can.
