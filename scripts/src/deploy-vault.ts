import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NearVault, VaultRefusal } from "@earmark/billers";
import { lagosTimestamp } from "@earmark/shared";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";

// Deploy the family vault and its test USDC to NEAR testnet, give the agent
// a key that can only call vault.pay, and run one payment and one refusal.
//
//   pnpm build:contracts && pnpm deploy:vault:testnet
//
// Accounts come from the testnet faucet; their keys stay in
// .earmark/vault-testnet.json (gitignored, 0600). Later runs reuse them.
// Testnet only: the token is a faucet token worth nothing.

const ROOT = resolve(import.meta.dirname, "../..");
const STATE_DIR = resolve(ROOT, ".earmark");
const STATE_FILE = resolve(STATE_DIR, "vault-testnet.json");
const WASM = (name: string) => resolve(ROOT, `contracts/target/near/${name}/${name}.wasm`);
const RPC = "https://rpc.testnet.fastnear.com";
const FAUCET = "https://helper.nearprotocol.com/account";
/** Test USDC the admin keeps to fund demo families: 1,000,000 test dollars. */
const POOL = "1000000000000";

interface KeyedAccount {
  accountId: string;
  privateKey: KeyPairString;
}
interface State {
  token: KeyedAccount;
  vault: KeyedAccount;
  admin: KeyedAccount;
  agent: KeyedAccount;
  settlement: KeyedAccount;
  /** The function-call key the bot holds: vault.pay and nothing else. */
  agentPayKey?: KeyPairString;
}

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const provider = new JsonRpcProvider({ url: RPC });
const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

async function createFaucetAccount(prefix: string): Promise<KeyedAccount> {
  const accountId = `${prefix}-${randomBytes(4).toString("hex")}.testnet`;
  const keyPair = KeyPair.fromRandom("ed25519");
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      newAccountId: accountId,
      newAccountPublicKey: keyPair.getPublicKey().toString(),
    }),
  });
  if (!res.ok)
    throw new Error(`faucet refused ${accountId}: HTTP ${res.status} ${await res.text()}`);
  log(`created ${accountId}`);
  return { accountId, privateKey: keyPair.toString() as KeyPairString };
}

async function save(state: State) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  await chmod(STATE_FILE, 0o600);
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch {
    const state: State = {
      token: await createFaucetAccount("earmark-tusdc"),
      vault: await createFaucetAccount("earmark-vault"),
      admin: await createFaucetAccount("earmark-vault-admin"),
      agent: await createFaucetAccount("earmark-agent"),
      settlement: await createFaucetAccount("earmark-settle"),
    };
    await save(state);
    // The faucet's accounts need a block or two to be visible.
    await new Promise((r) => setTimeout(r, 3_000));
    return state;
  }
}

async function initialized(contractId: string, view: string): Promise<boolean> {
  try {
    await provider.callFunction({ contractId, method: view, args: {} });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const tokenWasm = await readFile(WASM("earmark_test_usdc")).catch(() => null);
  const vaultWasm = await readFile(WASM("earmark_vault")).catch(() => null);
  if (!tokenWasm || !vaultWasm) throw new Error("no wasm: run pnpm build:contracts first");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);
  log(`vault wasm ${(vaultWasm.length / 1024).toFixed(0)} KiB, sha256 ${sha(vaultWasm)}…`);

  const state = await loadState();
  const acct = (k: KeyedAccount) => new Account(k.accountId, provider, k.privateKey);
  const token = acct(state.token);
  const vault = acct(state.vault);
  const admin = acct(state.admin);
  const agent = acct(state.agent);

  await token.deployContract(new Uint8Array(tokenWasm));
  if (!(await initialized(token.accountId, "ft_total_supply"))) {
    await token.callFunction({ contractId: token.accountId, methodName: "new", args: {} });
  }
  log(`test USDC at ${token.accountId}`);

  await vault.deployContract(new Uint8Array(vaultWasm));
  if (!(await initialized(vault.accountId, "config"))) {
    await vault.callFunction({
      contractId: vault.accountId,
      methodName: "new",
      args: {
        admin: state.admin.accountId,
        agent: state.agent.accountId,
        token: state.token.accountId,
        settlement: state.settlement.accountId,
      },
    });
  }
  log(
    `vault at ${vault.accountId}: admin ${state.admin.accountId}, agent ${state.agent.accountId}`,
  );

  // Register the vault and settlement with the token, and give the admin its pool.
  for (const [id, amount] of [
    [vault.accountId, "0"],
    [state.settlement.accountId, "0"],
    [admin.accountId, POOL],
  ] as const) {
    await admin.callFunction({
      contractId: token.accountId,
      methodName: "mint",
      args: { account_id: id, amount },
    });
  }
  log(`admin holds ${Number(POOL) / 1e6} test USDC to fund demo families`);

  // The bot's key: vault.pay only, with a gas allowance and no deposit.
  if (!state.agentPayKey) {
    const payKey = KeyPair.fromRandom("ed25519");
    await agent.addFunctionCallAccessKey({
      publicKey: payKey.getPublicKey(),
      contractId: vault.accountId,
      methodNames: ["pay"],
      allowance: 2_000_000_000_000_000_000_000_000n, // 2 NEAR of gas
    });
    state.agentPayKey = payKey.toString() as KeyPairString;
    await save(state);
    log("agent has a function-call key for vault.pay only");
  }

  // Smoke: a family with $10 and one number, one payment, one refusal.
  const client = new NearVault({
    rpcUrl: RPC,
    vaultId: vault.accountId,
    tokenId: token.accountId,
    admin: state.admin,
    agent: { accountId: state.agent.accountId, privateKey: state.agentPayKey },
  });
  const familyId = `fam_smoke${randomBytes(6).toString("hex").slice(0, 11)}`;
  const hash = createHash("sha256").update(`earmark-vault-smoke-${familyId}`).digest("hex");
  await client.registerFamily(familyId, {
    frozen: false,
    perPaymentMax: "5000000",
    monthlyBudget: "8000000",
  });
  await client.allow(familyId, [hash]);
  await client.fund(familyId, "10000000");
  log(`smoke family ${familyId}: $10, $5 per payment, $8 a month`);

  const paid = await client.pay({
    familyId,
    orderId: `${lagosTimestamp()}${randomBytes(6).toString("hex")}`,
    category: "electricity",
    amountUsdcAtomic: "3770000",
    customerRefHash: hash,
  });
  log(`paid $3.77 to settlement: ${explorer(paid.txHash)}`);
  try {
    await client.pay({
      familyId,
      orderId: `${lagosTimestamp()}${randomBytes(6).toString("hex")}`,
      category: "electricity",
      amountUsdcAtomic: "6000000",
      customerRefHash: hash,
    });
    throw new Error("the vault paid over the cap");
  } catch (e) {
    if (!(e instanceof VaultRefusal)) throw e;
    log(`refused $6.00 (${e.code}): ${explorer(e.txHash)}`);
  }
  const f = await client.family(familyId);
  log(`family now holds ${Number(f?.balance) / 1e6} test USDC`);
  console.log(`\nFor the bot (.env, or Render's environment):
VAULT_TESTNET_CONTRACT_ID=${vault.accountId}
VAULT_TESTNET_TOKEN_ID=${token.accountId}
VAULT_TESTNET_AGENT_ACCOUNT_ID=${state.agent.accountId}
VAULT_TESTNET_ADMIN_ACCOUNT_ID=${state.admin.accountId}
and the two keys from ${STATE_FILE}: agentPayKey (VAULT_TESTNET_AGENT_PAY_KEY) and admin.privateKey (VAULT_TESTNET_ADMIN_KEY).`);
}

main().catch((e) => {
  console.error(`deploy stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
