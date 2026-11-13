import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  familyPolicy,
  findUsdc,
  loadDevOwner,
  runOwnerIntent,
  type TokenEntry,
  waitForPolicyApplied,
} from "@earmark/agent-api";
import { agentApiEnv, devOwnerEnv, nearEnv, readEnv } from "@earmark/config";
import type { HardLimits } from "@earmark/shared";
import {
  createAgentApi,
  createGrantCredential,
  createIdempotencyKey,
} from "@near-intents-agent-api/sdk";
import { JsonRpcProvider } from "near-api-js";

// One real agent account for recording the demo video: one or two real
// bill payments, not a live link judges repeatedly poke at.
//
//   pnpm setup:agent-production                    read-only preflight
//   SETUP_ALLOW_WRITES=true pnpm setup:agent-production
//
// Creates the account, issues a bot grant, and prints a 1Click deposit
// address to fund. Resumable: state lives in .earmark/ (gitignored; it
// holds the grant token). A finished step is never re-run.

const ROOT = resolve(import.meta.dirname, "../../..");
const STATE_FILE = resolve(ROOT, ".earmark/agent-production.json");

// USDC atomic units (6 decimals). Sized for one or two real takes of the
// ~₦5,000 ≈ $3.77 demo bill, not a live link left open through judging.
const HARD: Omit<HardLimits, "settlementAccountId"> = {
  monthlyBudgetUsd: "10.00",
  perTransactionMaxUsdcAtomic: "5000000", // $5.00
};

try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  // fall back to the process environment
}

interface State {
  agentId?: string;
  grantToken?: string;
  usdcAssetId?: string;
  createIdempotencyKey?: string;
  grantIdempotencyKey?: string;
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

async function saveState(state: State) {
  await mkdir(resolve(ROOT, ".earmark"), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  await chmod(STATE_FILE, 0o600);
}

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function main() {
  const api = createAgentApi({
    apiKey: readEnv(agentApiEnv).NEAR_INTENTS_AGENT_API_KEY,
    baseUrl: readEnv(agentApiEnv).NEAR_INTENTS_AGENT_API_URL,
  });
  const near = readEnv(nearEnv);
  const dev = readEnv(devOwnerEnv);
  const owner = loadDevOwner(
    dev.DEV_OWNER_ACCOUNT_ID,
    dev.DEV_OWNER_PRIVATE_KEY,
    near.NEAR_RPC_URL,
  );
  const settlement = near.SETTLEMENT_ACCOUNT_ID;
  const depositChain = process.env.SETUP_DEPOSIT_CHAIN || "near";

  const [me, network, tokens] = await Promise.all([
    api.whoami(),
    api.getNetwork(),
    api.getTokens(),
  ]);
  const tokenList = (
    Array.isArray(tokens) ? tokens : (tokens as { data: TokenEntry[] }).data
  ) as TokenEntry[];
  const usdc = findUsdc(tokenList, "near");
  const depositAsset = findUsdc(tokenList, depositChain);
  log(`API key ok (tenant ${me.tenant_id}); ${network.network} ${network.status.overall}`);

  const rpc = new JsonRpcProvider({ url: near.NEAR_RPC_URL });
  await rpc.viewAccessKey({
    accountId: owner.owner.account_id,
    publicKey: owner.owner.public_key,
    finalityQuery: { finality: "final" },
  });
  await rpc.viewAccount({ accountId: settlement, blockQuery: { finality: "final" } });
  log(`dev owner ${owner.owner.account_id} and settlement ${settlement} both exist on chain`);

  const hard: HardLimits = { ...HARD, settlementAccountId: settlement };
  log(
    `policy for the real demo agent: USDC transfers to ${settlement} only, ` +
      `$${(Number(hard.perTransactionMaxUsdcAtomic) / 1e6).toFixed(2)} per payment, ` +
      `$${hard.monthlyBudgetUsd}/month`,
  );

  const state = await loadState();
  state.usdcAssetId = usdc;

  if (process.env.SETUP_ALLOW_WRITES !== "true") {
    log("preflight passed. Set SETUP_ALLOW_WRITES=true to create the account for real.");
    await saveState(state);
    return;
  }

  if (!state.agentId) {
    state.createIdempotencyKey ??= createIdempotencyKey();
    await saveState(state);
    const status = await runOwnerIntent(
      api,
      {
        type: "agent_create",
        name: "Earmark demo",
        external_user_id: "earmark-demo",
        owner: owner.owner,
        policy: familyPolicy(hard, usdc),
      },
      owner.sign,
      { idempotencyKey: state.createIdempotencyKey },
    );
    if (status.status !== "SUCCESS" || !status.agent_id) {
      throw new Error(`create ended ${status.status} ${status.failure_code ?? ""}`);
    }
    state.agentId = status.agent_id;
    await saveState(state);
    await waitForPolicyApplied(api, status.agent_id);
    log(`✓ agent ${state.agentId} created and policy applied`);
  } else {
    log(`✓ agent ${state.agentId} (created earlier)`);
  }

  if (!state.grantToken) {
    const credential = createGrantCredential();
    state.grantToken = credential.token;
    await saveState(state);
    state.grantIdempotencyKey ??= createIdempotencyKey();
    await saveState(state);
    const status = await runOwnerIntent(
      api,
      {
        type: "grant_issue",
        agent_id: state.agentId,
        label: "earmark-demo-bot",
        credential: credential.commitment,
        // Long enough to cover the whole judging window, per HACKATHON.md.
        expires_at: new Date(Date.now() + 21 * 86_400_000).toISOString(),
      },
      owner.sign,
      { idempotencyKey: state.grantIdempotencyKey },
    );
    if (status.status !== "SUCCESS") throw new Error(`grant ended ${status.status}`);
    log("✓ grant issued, valid 21 days");
  } else {
    log("✓ grant issued (earlier)");
  }

  const dep = await api.deposit(
    state.agentId,
    { origin_asset: depositAsset, ...(depositAsset === usdc ? {} : { destination_asset: usdc }) },
    { idempotencyKey: createIdempotencyKey() },
  );
  const d = dep.details as {
    deposit_address?: string;
    memo?: string | null;
    min_amount?: string;
    expires_at?: string;
  };
  log(`send USDC on ${depositChain} to: ${d.deposit_address}`);
  if (d.memo) log(`memo: ${d.memo}`);
  log(`minimum ${d.min_amount ?? "?"}, open until ${d.expires_at}`);
  log("Fund this once with enough for a take or two of the demo bill (e.g. $8-10 covers it).");
  log("Then set AGENT_API_REAL_PAYMENTS=true in .env and restart the bot.");
}

main().catch((e) => {
  console.error(`setup stopped: ${String(e)}`);
  process.exitCode = 1;
});
