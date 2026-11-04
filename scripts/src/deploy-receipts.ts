import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { lagosTimestamp, type ReceiptInput } from "@earmark/shared";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";

// Deploy the receipts contract to NEAR testnet and write one smoke receipt.
//
//   cargo near build non-reproducible-wasm --manifest-path contracts/receipts/Cargo.toml
//   pnpm deploy:receipts:testnet
//
// First run creates two free faucet accounts (contract, service) and keeps
// their keys in .earmark/receipts-testnet.json (gitignored, 0600). Later
// runs redeploy the same contract. Mainnet is a separate, deliberate step.

const ROOT = resolve(import.meta.dirname, "../..");
const STATE_DIR = resolve(ROOT, ".earmark");
const STATE_FILE = resolve(STATE_DIR, "receipts-testnet.json");
const WASM = resolve(ROOT, "contracts/target/near/earmark_receipts/earmark_receipts.wasm");
const RPC = "https://rpc.testnet.fastnear.com";
const FAUCET = "https://helper.nearprotocol.com/account";
const PAGE = "http://localhost:5173/receipt.html";

interface KeyedAccount {
  accountId: string;
  privateKey: KeyPairString;
}
interface State {
  contract: KeyedAccount;
  service: KeyedAccount;
}

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const provider = new JsonRpcProvider({ url: RPC });

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
  log(`created ${accountId} from the testnet faucet`);
  return { accountId, privateKey: keyPair.toString() as KeyPairString };
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch {
    const state = {
      contract: await createFaucetAccount("earmark-receipts"),
      service: await createFaucetAccount("earmark-service"),
    };
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    await chmod(STATE_FILE, 0o600);
    // The faucet's account creation needs a block or two to be visible.
    await new Promise((r) => setTimeout(r, 3_000));
    return state;
  }
}

async function main() {
  let wasm: Buffer;
  try {
    wasm = await readFile(WASM);
  } catch {
    throw new Error(
      `no wasm at ${WASM}. Build it first: cargo near build non-reproducible-wasm --manifest-path contracts/receipts/Cargo.toml`,
    );
  }
  log(
    `wasm ${(wasm.length / 1024).toFixed(0)} KiB, sha256 ${createHash("sha256").update(wasm).digest("hex").slice(0, 16)}…`,
  );

  const state = await loadState();
  const contract = new Account(state.contract.accountId, provider, state.contract.privateKey);
  const service = new Account(state.service.accountId, provider, state.service.privateKey);

  await contract.deployContract(new Uint8Array(wasm));
  log(`deployed to ${contract.accountId}`);

  let initialized = true;
  try {
    await provider.callFunction({ contractId: contract.accountId, method: "service", args: {} });
  } catch {
    initialized = false;
  }
  if (!initialized) {
    // On testnet the contract account is its own owner.
    await contract.callFunction({
      contractId: contract.accountId,
      methodName: "new",
      args: { owner: contract.accountId, service: service.accountId },
    });
    log(`initialized: owner ${contract.accountId}, service ${service.accountId}`);
  }

  // Smoke receipt: an order dated now, a hash of a fixed label (no real customer).
  const orderId = `${lagosTimestamp()}smoke${randomBytes(4).toString("hex").slice(0, 7)}`;
  const receipt: ReceiptInput = {
    orderId,
    familyId: "fam_testnetsmoke0001",
    category: "electricity",
    amountNgnKobo: 100_000,
    amountUsdcAtomic: "620155",
    customerRefHash: createHash("sha256").update("earmark-testnet-smoke").digest("hex"),
    status: "fulfilled",
    paymentTxHash: "testnetSmokePayment01",
    refundTxHash: null,
  };
  const out = await service.callFunctionRaw({
    contractId: contract.accountId,
    methodName: "record_receipt",
    args: { receipt },
  });
  log(`recorded ${orderId} in tx ${out.transaction.hash}`);

  const stored = await provider.callFunction({
    contractId: contract.accountId,
    method: "get_receipt",
    args: { order_id: orderId },
  });
  if (!stored) throw new Error("receipt not readable after recording");
  log(`read back: ${JSON.stringify(stored)}`);
  log(`explorer: https://testnet.nearblocks.io/txns/${out.transaction.hash}`);
  log(`page:     ${PAGE}?network=testnet&contract=${contract.accountId}&order=${orderId}`);
}

main().catch((e) => {
  console.error(`deploy stopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
