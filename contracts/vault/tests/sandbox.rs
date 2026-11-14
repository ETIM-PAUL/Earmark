//! The vault and the test token as real wasm on a local NEAR sandbox: real
//! ft_transfer calls, the refusals, a transfer that fails and is put back,
//! and an agent whose only key can call `pay` and nothing else.

use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const FAM: &str = "fam_abcdefgh12345678";

fn hash(c: char) -> String {
    c.to_string().repeat(64)
}

struct Env {
    worker: Worker<Sandbox>,
    usdc: Contract,
    vault: Contract,
    admin: Account,
    agent: Account,
    settlement: Account,
}

async fn wasm(path: &str, var: &str) -> anyhow::Result<Vec<u8>> {
    Ok(match std::env::var(var) {
        Ok(p) => std::fs::read(p)?,
        Err(_) => near_workspaces::compile_project(path).await?,
    })
}

async fn deploy_vault(
    worker: &Worker<Sandbox>,
    code: &[u8],
    admin: &Account,
    agent: &Account,
    usdc: &Contract,
    settlement: &str,
) -> anyhow::Result<Contract> {
    let vault = worker.dev_deploy(code).await?;
    vault
        .call("new")
        .args_json(json!({
            "admin": admin.id(), "agent": agent.id(), "token": usdc.id(), "settlement": settlement,
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(vault)
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let usdc = worker.dev_deploy(&wasm("../test-usdc", "TEST_USDC_WASM").await?).await?;
    usdc.call("new").transact().await?.into_result()?;
    let admin = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let settlement = worker.dev_create_account().await?;
    let ada = worker.dev_create_account().await?;
    let code = wasm("./", "VAULT_WASM").await?;
    let vault =
        deploy_vault(&worker, &code, &admin, &agent, &usdc, settlement.id().as_str()).await?;

    for (who, amount) in [(vault.id(), "0"), (settlement.id(), "0"), (ada.id(), "100000000")] {
        usdc.call("mint")
            .args_json(json!({ "account_id": who, "amount": amount }))
            .transact()
            .await?
            .into_result()?;
    }
    admin
        .call(vault.id(), "register_family")
        .args_json(json!({ "family_id": FAM, "limits": {
            "frozen": false, "per_payment_max": "5000000", "monthly_budget": "8000000",
        }}))
        .transact()
        .await?
        .into_result()?;
    admin
        .call(vault.id(), "allow")
        .args_json(json!({ "family_id": FAM, "hashes": [hash('a')] }))
        .transact()
        .await?
        .into_result()?;
    ada.call(usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": vault.id(), "amount": "10000000", "msg": FAM }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(Env { worker, usdc, vault, admin, agent, settlement })
}

async fn pay(
    env: &Env,
    who: &Account,
    order: &str,
    amount: &str,
    h: char,
) -> anyhow::Result<Result<(), String>> {
    let out = who
        .call(env.vault.id(), "pay")
        .args_json(json!({
            "family_id": FAM, "order_id": order, "category": "electricity",
            "amount": amount, "customer_ref_hash": hash(h),
        }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    Ok(if out.is_success() { Ok(()) } else { Err(format!("{:?}", out.failures())) })
}

async fn balance(env: &Env, of: &str) -> anyhow::Result<String> {
    let v: Value =
        env.usdc.view("ft_balance_of").args_json(json!({ "account_id": of })).await?.json()?;
    Ok(v.as_str().unwrap_or_default().to_string())
}

async fn family(env: &Env) -> anyhow::Result<Value> {
    Ok(env.vault.view("family").args_json(json!({ "family_id": FAM })).await?.json()?)
}

#[tokio::test]
async fn the_vault_pays_only_inside_the_limits() -> anyhow::Result<()> {
    let env = setup().await?;
    let settle = env.settlement.id().to_string();
    assert_eq!(family(&env).await?["balance"], "10000000");

    // A bill inside every limit: real test USDC reaches settlement.
    pay(&env, &env.agent, "202611141200aaaaaaaaaaaa", "3770000", 'a').await?.unwrap();
    assert_eq!(balance(&env, &settle).await?, "3770000");
    assert_eq!(family(&env).await?["balance"], "6230000");

    // Each refusal moves nothing.
    let cases = [
        ("202611141201bbbbbbbbbbbb", "5000001", 'a', "ERR_OVER_PER_PAYMENT"),
        ("202611141202cccccccccccc", "1000000", 'b', "ERR_NOT_ON_LIST"),
        ("202611141200aaaaaaaaaaaa", "1000000", 'a', "ERR_ALREADY_PAID"),
    ];
    for (order, amount, h, code) in cases {
        let err = pay(&env, &env.agent, order, amount, h).await?.unwrap_err();
        assert!(err.contains(code), "{code}: {err}");
    }
    let err = pay(&env, &env.admin, "202611141203dddddddddddd", "1000000", 'a').await?.unwrap_err();
    assert!(err.contains("ERR_NOT_AGENT"), "{err}");

    // Splitting: $3.77 + $4.00 fits the $8 month, the next cent doesn't.
    pay(&env, &env.agent, "202611141204eeeeeeeeeeee", "4000000", 'a').await?.unwrap();
    let err = pay(&env, &env.agent, "202611141205ffffffffffff", "240000", 'a').await?.unwrap_err();
    assert!(err.contains("ERR_OVER_MONTHLY"), "{err}");
    assert_eq!(balance(&env, &settle).await?, "7770000");

    // The agent can't loosen anything; the admin can freeze.
    let out = env
        .agent
        .call(env.vault.id(), "set_limits")
        .args_json(json!({ "family_id": FAM, "limits": {
            "frozen": false, "per_payment_max": "999000000", "monthly_budget": "999000000",
        }}))
        .transact()
        .await?;
    assert!(format!("{:?}", out.failures()).contains("ERR_NOT_ADMIN"));
    env.admin
        .call(env.vault.id(), "set_frozen")
        .args_json(json!({ "family_id": FAM, "frozen": true }))
        .transact()
        .await?
        .into_result()?;
    let err = pay(&env, &env.agent, "202611141206gggggggggggg", "100000", 'a').await?.unwrap_err();
    assert!(err.contains("ERR_FROZEN"), "{err}");
    assert_eq!(balance(&env, &settle).await?, "7770000");
    Ok(())
}

#[tokio::test]
async fn a_failed_transfer_is_put_back() -> anyhow::Result<()> {
    let env = setup().await?;
    // A vault whose settlement account was never registered with the token:
    // ft_transfer fails, and the vault must restore the money and the order.
    let code = wasm("./", "VAULT_WASM").await?;
    let nowhere = env.worker.dev_create_account().await?;
    let vault =
        deploy_vault(&env.worker, &code, &env.admin, &env.agent, &env.usdc, nowhere.id().as_str())
            .await?;
    env.usdc
        .call("mint")
        .args_json(json!({ "account_id": vault.id(), "amount": "0" }))
        .transact()
        .await?
        .into_result()?;
    env.admin
        .call(vault.id(), "register_family")
        .args_json(json!({ "family_id": FAM, "limits": {
            "frozen": false, "per_payment_max": "5000000", "monthly_budget": "8000000",
        }}))
        .transact()
        .await?
        .into_result()?;
    env.admin
        .call(vault.id(), "allow")
        .args_json(json!({ "family_id": FAM, "hashes": [hash('a')] }))
        .transact()
        .await?
        .into_result()?;
    let ada = env.worker.dev_create_account().await?;
    env.usdc
        .call("mint")
        .args_json(json!({ "account_id": ada.id(), "amount": "2000000" }))
        .transact()
        .await?
        .into_result()?;
    ada.call(env.usdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": vault.id(), "amount": "2000000", "msg": FAM }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;

    let out = env
        .agent
        .call(vault.id(), "pay")
        .args_json(json!({
            "family_id": FAM, "order_id": "202611141210hhhhhhhhhhhh", "category": "airtime",
            "amount": "1000000", "customer_ref_hash": hash('a'),
        }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    let returned: Value = out.json().unwrap_or(Value::Null);
    assert_eq!(returned, Value::Bool(false), "on_paid should report the revert");
    let f: Value = vault.view("family").args_json(json!({ "family_id": FAM })).await?.json()?;
    assert_eq!(f["balance"], "2000000");
    assert_eq!(f["spent_this_month"], "0");
    let paid: bool = vault
        .view("is_paid")
        .args_json(json!({ "order_id": "202611141210hhhhhhhhhhhh" }))
        .await?
        .json()?;
    assert!(!paid);
    Ok(())
}

#[tokio::test]
async fn the_agent_key_can_only_call_pay() -> anyhow::Result<()> {
    let env = setup().await?;
    // The bot holds only this key: a function-call key for vault.pay.
    let sk = SecretKey::from_random(KeyType::ED25519);
    env.agent
        .batch(env.agent.id())
        .add_key(sk.public_key(), AccessKey::function_call_access(env.vault.id(), &["pay"], None))
        .transact()
        .await?
        .into_result()?;
    let bot = Account::from_secret_key(env.agent.id().clone(), sk, &env.worker);

    pay(&env, &bot, "202611141220iiiiiiiiiiii", "1000000", 'a').await?.unwrap();

    // The same key can't call anything else on the vault, or any other contract.
    let other = bot
        .call(env.vault.id(), "set_frozen")
        .args_json(json!({ "family_id": FAM, "frozen": false }))
        .transact()
        .await;
    assert!(other.is_err() || !other.unwrap().is_success());
    let token = bot
        .call(env.usdc.id(), "mint")
        .args_json(json!({ "account_id": env.agent.id(), "amount": "1" }))
        .transact()
        .await;
    assert!(token.is_err() || !token.unwrap().is_success());
    Ok(())
}
