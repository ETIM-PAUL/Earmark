import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  describeRefusal,
  familyPolicy,
  findUsdc,
  loadDevOwner,
  runOwnerIntent,
  settleApproved,
  type TokenEntry,
  waitForPolicyApplied,
  waitForStatus,
  waitUntil,
} from "@earmark/agent-api";
import { agentApiEnv, devOwnerEnv, nearEnv, readEnv } from "@earmark/config";
import { type HardLimits, newFamilyId, newOrderId } from "@earmark/shared";
import {
  AgentApiError,
  createAgentApi,
  createGrantCredential,
  createIdempotencyKey,
  type StatusResponse,
} from "@near-intents-agent-api/sdk";
import { JsonRpcProvider } from "near-api-js";

// Phase 4 spike: one family account on the Agent API, end to end, on mainnet.
//
//   pnpm spike:agent-api                          read-only preflight
//   SPIKE_ALLOW_WRITES=true pnpm spike:agent-api  run it (about $1 moves to settlement)
//
// Steps: create the account under a signed policy → issue a bot grant →
// fund it through a 1Click deposit address → allowed payment (and an
// idempotent replay) → refused destination → refused amount → freeze,
// refused payment, unfreeze → budget exhaustion → owner approval, approve
// and reject.
//
// Resumable: state lives in .earmark/ (gitignored; it holds the grant token).
// A finished step is never re-run, so a crash can't pay twice.

const ROOT = resolve(import.meta.dirname, "../../..");
const STATE_DIR = resolve(ROOT, ".earmark");
const STATE_FILE = resolve(STATE_DIR, "agent-api-spike.json");
const REPORT_FILE = resolve(STATE_DIR, "agent-api-spike-report.json");

// USDC atomic units (6 decimals)
const PAY = "100000"; // $0.10
const BUDGET_PAY = "500000"; // $0.50
const OVER_CAP = "600000"; // $0.60
const NEEDED = 1_200_000n; // $1.20 must be available before paying
const HARD: Omit<HardLimits, "settlementAccountId"> = {
  monthlyBudgetUsd: "1.00",
  perTransactionMaxUsdcAtomic: "500000", // $0.50
};

try {
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  // fall back to the process environment
}

interface StepRecord {
  at: string;
  outcome: "pass" | "finding";
  note: string;
  data?: unknown;
}
interface State {
  familyId: string;
  agentId?: string;
  grantToken?: string;
  deposit?: { idempotencyKey: string; correlationId?: string; address?: string };
  keys: Record<string, string>;
  steps: Record<string, StepRecord>;
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
  } catch {
    return { familyId: newFamilyId(), keys: {}, steps: {} };
  }
}

async function saveState(state: State) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  await chmod(STATE_FILE, 0o600);
}

/** One stable idempotency key per logical request, saved before it is sent. */
async function keyFor(state: State, name: string, make = createIdempotencyKey) {
  if (!state.keys[name]) {
    state.keys[name] = make();
    await saveState(state);
  }
  return state.keys[name];
}

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const usd = (atomic: string | bigint) => `$${(Number(atomic) / 1e6).toFixed(2)}`;

function refusalOf(e: unknown) {
  if (e instanceof AgentApiError) return { code: e.code, layer: e.layer, title: e.message };
  throw e;
}

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
  const notAllowed = near.SERVICE_ACCOUNT_ID; // exists, but is not in the policy
  const depositChain = process.env.SPIKE_DEPOSIT_CHAIN || "near";

  // ── Preflight (read-only) ────────────────────────────────────────────
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
  if (!network.supported_owner_types.includes("near")) throw new Error("NEAR owners not supported");

  const rpc = new JsonRpcProvider({ url: near.NEAR_RPC_URL });
  await rpc.viewAccessKey({
    accountId: owner.owner.account_id,
    publicKey: owner.owner.public_key,
    finalityQuery: { finality: "final" },
  });
  log(`dev owner ${owner.owner.account_id}: key is on chain`);
  for (const id of [settlement, notAllowed]) {
    await rpc.viewAccount({ accountId: id, blockQuery: { finality: "final" } });
  }
  log(`settlement ${settlement} and test destination ${notAllowed} exist`);
  const hard: HardLimits = { ...HARD, settlementAccountId: settlement };
  log(
    `policy: USDC transfers to ${settlement} only, ${usd(hard.perTransactionMaxUsdcAtomic)} per payment, $${hard.monthlyBudgetUsd}/month`,
  );
  log(
    `plan: fund ≥ ${usd(NEEDED)} from USDC on ${depositChain}; about $0.80 ends up in settlement`,
  );

  if (process.env.SPIKE_ALLOW_WRITES !== "true") {
    log("preflight passed. Set SPIKE_ALLOW_WRITES=true to run the spike on mainnet.");
    return;
  }

  const state = await loadState();
  const step = async (name: string, run: () => Promise<Omit<StepRecord, "at">>) => {
    const done = state.steps[name];
    if (done) {
      log(`✓ ${name} (done earlier): ${done.note}`);
      return;
    }
    log(`→ ${name}`);
    const rec = { at: new Date().toISOString(), ...(await run()) };
    state.steps[name] = rec;
    await saveState(state);
    log(`${rec.outcome === "pass" ? "✓" : "!"} ${name}: ${rec.note}`);
  };
  const agentId = () => {
    if (!state.agentId) throw new Error("no agent yet");
    return state.agentId;
  };
  const bot = () => {
    if (!state.grantToken) throw new Error("no grant yet");
    return api.forGrant(state.grantToken);
  };
  const pay = async (key: string, amount: string, recipient = settlement) => {
    const execution = await bot().transfer(
      agentId(),
      { asset: usdc, amount, recipient },
      { idempotencyKey: await keyFor(state, key, () => newOrderId()) },
    );
    if (execution.status === "PENDING_APPROVAL") return execution;
    return waitForStatus(api, execution.correlation_id);
  };

  await step("1 create family account", async () => {
    const status = await runOwnerIntent(
      api,
      {
        type: "agent_create",
        name: "Earmark spike family",
        external_user_id: state.familyId,
        owner: owner.owner,
        policy: familyPolicy(hard, usdc),
      },
      owner.sign,
      { idempotencyKey: await keyFor(state, "create") },
    );
    if (status.status !== "SUCCESS" || !status.agent_id) {
      throw new Error(`create ended ${status.status} ${status.failure_code ?? ""}`);
    }
    state.agentId = status.agent_id;
    await saveState(state);
    await waitForPolicyApplied(api, status.agent_id);
    return { outcome: "pass", note: `agent ${status.agent_id} (family ${state.familyId})` };
  });

  await step("2 issue bot grant", async () => {
    const credential = createGrantCredential();
    state.grantToken = credential.token;
    await saveState(state);
    const status = await runOwnerIntent(
      api,
      {
        type: "grant_issue",
        agent_id: agentId(),
        label: "earmark-spike-bot",
        credential: credential.commitment,
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
      owner.sign,
      { idempotencyKey: await keyFor(state, "grant") },
    );
    if (status.status !== "SUCCESS") throw new Error(`grant ended ${status.status}`);
    return { outcome: "pass", note: "grant issued, valid 7 days" };
  });

  await step("3 fund through a 1Click deposit address", async () => {
    state.deposit ??= { idempotencyKey: createIdempotencyKey() };
    await saveState(state);
    const dep = await api.deposit(
      agentId(),
      {
        origin_asset: depositAsset,
        ...(depositAsset === usdc ? {} : { destination_asset: usdc }),
      },
      { idempotencyKey: state.deposit.idempotencyKey },
    );
    const d = dep.details as {
      deposit_address?: string;
      memo?: string | null;
      min_amount?: string;
      expires_at?: string;
    };
    state.deposit.correlationId = dep.correlation_id;
    if (d.deposit_address) state.deposit.address = d.deposit_address;
    await saveState(state);
    log(`  send ≥ ${usd(NEEDED)} USDC on ${depositChain} to ${d.deposit_address}`);
    if (d.memo) log(`  memo: ${d.memo}`);
    log(`  minimum ${d.min_amount ? usd(d.min_amount) : "?"}, open until ${d.expires_at}`);
    log("  waiting for funds (rerun to keep waiting if this times out)…");
    const started = Date.now();
    while (Date.now() - started < 30 * 60_000) {
      const { balances } = await api.getBalances(agentId());
      const entry = balances.find((b) => b.asset_id === usdc);
      const available = BigInt(entry?.available_raw ?? "0");
      if (available >= NEEDED) {
        const took = Math.round((Date.now() - started) / 1000);
        return { outcome: "pass", note: `${usd(available)} available after ${took}s of waiting` };
      }
      await sleep(15_000);
    }
    throw new Error("funds not seen in 30 minutes; rerun to keep waiting");
  });

  await step("4 allowed payment, then an idempotent replay", async () => {
    const first = await pay("allowed", PAY);
    const replay = await pay("allowed", PAY);
    const same = first.correlation_id === replay.correlation_id;
    return {
      outcome: first.status === "SUCCESS" && same ? "pass" : "finding",
      note: `${first.status}; replay with the same order id ${same ? "returned the same operation" : "created NEW work"}`,
      data: { orderId: state.keys.allowed, first },
    };
  });

  await step("5 refused: destination outside the policy", async () => {
    try {
      const s = await pay("bad-destination", PAY, notAllowed);
      return { outcome: "finding", note: `NOT refused: ${s.status}`, data: s };
    } catch (e) {
      const r = refusalOf(e);
      return {
        outcome: r.code === "policy_destination_denied" ? "pass" : "finding",
        note: `${r.code} (${r.layer}); recipient sees: "${describeRefusal(e)?.recipient}"`,
        data: r,
      };
    }
  });

  await step("6 refused: above the per-payment maximum", async () => {
    try {
      const s = await pay("over-cap", OVER_CAP);
      return { outcome: "finding", note: `NOT refused: ${s.status}`, data: s };
    } catch (e) {
      const r = refusalOf(e);
      return { outcome: "pass", note: `${r.code} (${r.layer})`, data: r };
    }
  });

  await step("7 freeze blocks payments; unfreeze restores them", async () => {
    const frozen = await runOwnerIntent(
      api,
      { type: "agent_freeze", agent_id: agentId() },
      owner.sign,
      {
        idempotencyKey: await keyFor(state, "freeze"),
      },
    );
    let blocked: ReturnType<typeof refusalOf> | null = null;
    try {
      await pay("while-frozen", PAY);
    } catch (e) {
      blocked = refusalOf(e);
    }
    const unfrozen = await runOwnerIntent(
      api,
      { type: "agent_unfreeze", agent_id: agentId() },
      owner.sign,
      { idempotencyKey: await keyFor(state, "unfreeze") },
    );
    await waitForPolicyApplied(api, agentId());
    const after = await pay("after-unfreeze", PAY);
    const ok = frozen.status === "SUCCESS" && blocked !== null && after.status === "SUCCESS";
    return {
      outcome: ok ? "pass" : "finding",
      note: `freeze ${frozen.status}; payment while frozen: ${blocked?.code ?? "NOT refused"}; unfreeze ${unfrozen.status}; next payment ${after.status}`,
      data: { blocked },
    };
  });

  await step("8 monthly budget runs out", async () => {
    const within = await pay("budget-within", BUDGET_PAY);
    let refused: { code: string } | null = null;
    try {
      await pay("budget-over", BUDGET_PAY);
    } catch (e) {
      refused = refusalOf(e);
    }
    const { usage } = await api.getPolicy(agentId());
    const m = usage.budget.monthly;
    return {
      outcome:
        within.status === "SUCCESS" && refused?.code === "spend_budget_exceeded"
          ? "pass"
          : "finding",
      note: `${usd(BUDGET_PAY)} ${within.status}; next ${usd(BUDGET_PAY)}: ${refused?.code ?? "NOT refused"}; spent $${m.spent_usd} of $${m.limit_usd}, resets ${m.resets_at}`,
      data: { budget: m },
    };
  });

  await step("9 owner approval: approve one, reject one", async () => {
    const before = await api.getPolicy(agentId());
    await waitUntil(before.cooldowns.policy_change_available_at, (ms) =>
      log(`  policy edits are 10 minutes apart; waiting ${Math.ceil(ms / 60_000)} min…`),
    );
    const current = await api.getPolicy(agentId());
    if (!current.policy || current.revision === null) throw new Error("policy not ready");
    // Approval-gated payments are charged while they wait, so free budget for this step.
    const policy = {
      ...current.policy,
      owner_approval: true,
      budget: { ...current.policy.budget, monthly_usd: "2.00" },
    };
    const updated = await runOwnerIntent(
      api,
      { type: "policy_update", agent_id: agentId(), expected_revision: current.revision, policy },
      owner.sign,
      { idempotencyKey: await keyFor(state, "approval-on") },
    );
    if (updated.status !== "SUCCESS") throw new Error(`policy update ${updated.status}`);
    await waitForPolicyApplied(api, agentId());

    const vote = async (key: string, verdict: "approve" | "reject") => {
      const held = await pay(key, PAY);
      if (held.status !== "PENDING_APPROVAL") return { held: held.status, settled: held.status };
      const approvalId = (held.details as { approval_id?: string }).approval_id;
      if (!approvalId) throw new Error("PENDING_APPROVAL without approval_id");
      const voted = await runOwnerIntent(
        api,
        { type: "approval_vote", agent_id: agentId(), approval_id: approvalId, verdict },
        owner.sign,
        { idempotencyKey: await keyFor(state, `${key}-vote`) },
      );
      const settled: StatusResponse = await settleApproved(api, held.correlation_id);
      return {
        held: held.status,
        vote: voted.status,
        settled: settled.status,
        details: settled.details,
      };
    };
    const approved = await vote("approve-me", "approve");
    const rejected = await vote("reject-me", "reject");
    const ok =
      approved.held === "PENDING_APPROVAL" &&
      approved.settled === "SUCCESS" &&
      rejected.settled === "FAILED";
    return {
      outcome: ok ? "pass" : "finding",
      note: `approve: ${approved.held} → ${approved.settled}; reject: ${rejected.held} → ${rejected.settled}`,
      data: { approved, rejected },
    };
  });

  const [balances, policy, history] = await Promise.all([
    api.getBalances(agentId()),
    api.getPolicy(agentId()),
    api.getHistory(agentId(), { limit: 50 }),
  ]);
  const report = {
    finishedAt: new Date().toISOString(),
    agentId: state.agentId,
    familyId: state.familyId,
    steps: state.steps,
    balances: balances.balances,
    budget: policy.usage.budget,
    history: history.data.map((h) => ({ type: h.type, status: h.status, id: h.correlation_id })),
  };
  await writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
  const findings = Object.entries(state.steps).filter(([, s]) => s.outcome === "finding");
  log(`done: ${Object.keys(state.steps).length} steps, ${findings.length} findings`);
  log(`report: ${REPORT_FILE}`);
}

main().catch((e) => {
  const r = e instanceof AgentApiError ? `${e.code} (${e.layer}): ${e.message}` : String(e);
  console.error(`spike stopped: ${r}`);
  process.exitCode = 1;
});
