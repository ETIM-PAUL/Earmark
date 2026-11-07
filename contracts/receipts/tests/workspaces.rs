//! Every state change, against the real wasm on a local NEAR sandbox.
//!
//! One sandbox and one deploy per test file run: starting neard is the slow
//! part, so the cases share a contract and use distinct order IDs.

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const FAMILY: &str = "fam_abcdefgh12345678";

fn receipt(order_id: &str, status: &str) -> Value {
    let refund = (status == "refunded").then_some("Fq9vR2mWcLt7aHsE4uYb");
    json!({
        "orderId": order_id,
        "familyId": FAMILY,
        "category": "electricity",
        "amountNgnKobo": 1_000_000,
        "amountUsdcAtomic": "6201550",
        "customerRefHash": "a".repeat(64),
        "status": status,
        "paymentTxHash": "8Tq3xKfbbJ9n2ZkqvUeA",
        "refundTxHash": refund,
    })
}

struct Env {
    worker: Worker<Sandbox>,
    contract: Contract,
    owner: Account,
    service: Account,
    stranger: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    // RECEIPTS_WASM points at a prebuilt wasm (CI builds it once with cargo near);
    // otherwise build it here, the same way.
    let wasm = match std::env::var("RECEIPTS_WASM") {
        Ok(path) => std::fs::read(path)?,
        Err(_) => near_workspaces::compile_project("./").await?,
    };
    let contract = worker.dev_deploy(&wasm).await?;
    let owner = worker.dev_create_account().await?;
    let service = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;
    contract
        .call("new")
        .args_json(json!({ "owner": owner.id(), "service": service.id() }))
        .transact()
        .await?
        .into_result()?;
    Ok(Env { worker, contract, owner, service, stranger })
}

async fn record(env: &Env, who: &Account, receipt: Value) -> anyhow::Result<Result<Value, String>> {
    let out = who
        .call(env.contract.id(), "record_receipt")
        .args_json(json!({ "receipt": receipt }))
        .transact()
        .await?;
    Ok(match out.into_result() {
        Ok(ok) => Ok(ok.json()?),
        Err(e) => Err(format!("{e:?}")),
    })
}

async fn view(env: &Env, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(env.contract.view(method).args_json(args).await?.json()?)
}

#[tokio::test]
async fn receipts_end_to_end() -> anyhow::Result<()> {
    let env = setup().await?;

    // Fulfilled: the service writes, the block time is stamped, an event is logged.
    let out = env
        .service
        .call(env.contract.id(), "record_receipt")
        .args_json(json!({ "receipt": receipt("202611041000fulfilled001", "fulfilled") }))
        .transact()
        .await?
        .into_result()?;
    let logs = out.logs();
    assert_eq!(logs.len(), 1, "{logs:?}");
    let event: Value = serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap())?;
    assert_eq!(event["standard"], "earmark_receipts");
    assert_eq!(event["event"], "receipt_recorded");
    assert_eq!(event["data"]["orderId"], "202611041000fulfilled001");
    let stored: Value = out.json()?;
    assert!(stored["recordedAtMs"].as_u64().unwrap() > 0);

    // Refunded: both references required and kept.
    let r = record(&env, &env.service, receipt("202611041001refunded0002", "refunded"))
        .await?
        .map_err(anyhow::Error::msg)?;
    assert_eq!(r["status"], "refunded");
    assert_eq!(r["refundTxHash"], "Fq9vR2mWcLt7aHsE4uYb");

    // Anyone reads, including an account that has never touched the contract.
    let got = view(&env, "get_receipt", json!({ "order_id": "202611041000fulfilled001" })).await?;
    assert_eq!(got["amountUsdcAtomic"], "6201550");
    assert_eq!(
        view(&env, "get_receipt", json!({ "order_id": "202611049999nothere00000" })).await?,
        Value::Null
    );
    let page = view(&env, "receipts_for_family", json!({ "family_id": FAMILY })).await?;
    assert_eq!(page.as_array().unwrap().len(), 2);
    assert_eq!(view(&env, "receipt_count", json!({})).await?, 2);

    // No overwrites, not even to turn a fulfilled receipt into a refund.
    let err = record(&env, &env.service, receipt("202611041000fulfilled001", "refunded")).await?;
    let e = err.unwrap_err();
    assert!(e.contains("receipt already recorded"), "{e}");

    // Strangers and the owner cannot write.
    for who in [&env.stranger, &env.owner] {
        let err = record(&env, who, receipt("202611041002stranger0003", "fulfilled")).await?;
        assert!(err.unwrap_err().contains("only the service may write receipts"));
    }

    // Free text can't reach the chain.
    let mut pii = receipt("202611041003piicheck0004", "fulfilled");
    pii["paymentTxHash"] = json!("Mama Ngozi 0803 123 4567");
    let err = record(&env, &env.service, pii).await?;
    assert!(err.unwrap_err().contains("invalid transaction reference"));

    // Rotating needs 1 yoctoNEAR, so a function-call key can't do it.
    let new_service = env.worker.dev_create_account().await?;
    let out = env
        .owner
        .call(env.contract.id(), "set_service")
        .args_json(json!({ "service": new_service.id() }))
        .transact()
        .await?;
    assert!(format!("{:?}", out.into_result()).contains("exactly 1 yoctoNEAR"));

    // The owner rotates the service; the old one loses write access.
    let out = env
        .owner
        .call(env.contract.id(), "set_service")
        .args_json(json!({ "service": new_service.id() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert!(out.logs()[0].contains("service_changed"));
    let err = record(&env, &env.service, receipt("202611041004oldservice05", "fulfilled")).await?;
    assert!(err.unwrap_err().contains("only the service may write receipts"));
    record(&env, &new_service, receipt("202611041004newservice05", "fulfilled"))
        .await?
        .map_err(anyhow::Error::msg)?;

    // A stranger can't rotate it.
    let out = env
        .stranger
        .call(env.contract.id(), "set_service")
        .args_json(json!({ "service": env.stranger.id() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(format!("{:?}", out.into_result()).contains("only the owner may change service"));

    // Storage: one receipt must cost well under 0.01 NEAR of contract balance.
    let before = env.contract.view_account().await?;
    record(&env, &new_service, receipt("202611041005storage00006", "fulfilled"))
        .await?
        .map_err(anyhow::Error::msg)?;
    let after = env.contract.view_account().await?;
    let bytes = after.storage_usage - before.storage_usage;
    let cost = NearToken::from_yoctonear(u128::from(bytes) * 10u128.pow(19));
    assert!(cost < NearToken::from_millinear(10), "one receipt costs {cost} ({bytes} bytes)");
    println!("one receipt: {bytes} bytes, {cost} of storage");

    Ok(())
}
