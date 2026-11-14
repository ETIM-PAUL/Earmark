# Vault drill: NEAR testnet

Run on 2026-11-14 16:04 UTC with `pnpm drill:vault`, against the vault [`earmark-vault-3d4c5341.testnet`](https://testnet.nearblocks.io/address/earmark-vault-3d4c5341.testnet) and its test USDC [`earmark-tusdc-b8f4bf88.testnet`](https://testnet.nearblocks.io/address/earmark-tusdc-b8f4bf88.testnet). Testnet only; the token is a faucet token worth nothing.

The family was created by the bot, which registered it on the vault with the sender's hard limits, allowed its numbers (as salted hashes) and funded it with 100 test USDC. The bill itself is a simulated VTpass purchase. The four attempts after it use the agent's real key, which can only call `pay`: what a compromised payment path could do.

**PASS: the ordinary bill was paid by the vault, and 4 of 4 attempts were refused on chain.**

| Step | Result | Transaction |
| --- | --- | --- |
| The relative asks for ₦5,000 of light and says YES (family fam_3waambgqcequ4tfj, set up on the vault by the bot) | ✓ Paid by the vault: 3.77128 test USDC to settlement, then the bill was bought | [NearBlocks](https://testnet.nearblocks.io/txns/9m6DjvBTWExi6UtZTjcDkCkYBqWpwhCGXN9h2nn9rUDN) |
| Pay the same order again | ✓ Refused on chain: ERR_ALREADY_PAID (this order was already paid). Nothing moved | [NearBlocks](https://testnet.nearblocks.io/txns/2mUKGLA3UbAF4k8X7KSf6McmV1rz1tauP7VmrncPS6mk) |
| Pay a meter the sender never added | ✓ Refused on chain: ERR_NOT_ON_LIST (that number isn't on the sender's list). Nothing moved | [NearBlocks](https://testnet.nearblocks.io/txns/55zgqDNTerRQw5gaPciDy1iMrJ347HgCfZCNkWbVFmPB) |
| Pay $60 at once (the sender's cap is $50) | ✓ Refused on chain: ERR_OVER_PER_PAYMENT (more than the sender's per-payment cap). Nothing moved | [NearBlocks](https://testnet.nearblocks.io/txns/2YWsnf7ZXDskvKBKLqVLvaiR2fz7gMSe4sCjPWo9vWgQ) |
| Pay after the sender froze the account in the app | ✓ Refused on chain: ERR_FROZEN (the account is frozen by the sender). Nothing moved | [NearBlocks](https://testnet.nearblocks.io/txns/13uJKr8uphwL3ixbX5upH8GHfQEwgjMGQvgbWA1TJuHq) |

After the drill the family holds 96.22872 test USDC, has spent 3.77128 this month, and is frozen.
