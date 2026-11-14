//! Earmark family vault (testnet). Owner: Contracts.
//!
//! Holds each family's test USDC and pays the settlement account for one
//! bill at a time, only inside the sender's hard limits:
//!
//! - the account isn't frozen,
//! - the meter, phone or decoder is on the sender's list (as the same
//!   salted hash the receipts carry, so no number is ever on-chain),
//! - the payment is within the per-payment cap and this month's budget,
//! - the order hasn't been paid before, and the family has the money.
//!
//! Two roles. The `agent` (the assistant's payment path) may only call
//! `pay`; on testnet it holds a function-call key limited to that method.
//! The `admin` registers families and sets their limits on the sender's
//! behalf, after the sender's passkey-signed change in the app. Category
//! rules and approvals stay in the app: a sender's signed approval can
//! override those, but nothing overrides these limits.

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_PAID: Gas = Gas::from_tgas(10);
/// Lagos is UTC+1 all year; months follow Lagos time, like the app.
const LAGOS_OFFSET_MS: u64 = 3_600_000;

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Electricity,
    Airtime,
    Data,
    Tv,
}

/// The sender's hard limits, in test-USDC atomic units (6 decimals).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub frozen: bool,
    pub per_payment_max: U128,
    pub monthly_budget: U128,
}

#[near(serializers = [borsh])]
pub struct Family {
    balance: u128,
    limits: Limits,
    /// YYYYMM in Lagos time, and what was paid in it.
    month: u32,
    spent: u128,
}

#[near(serializers = [json])]
pub struct FamilyView {
    pub balance: U128,
    pub limits: Limits,
    pub month: u32,
    pub spent_this_month: U128,
}

#[near(serializers = [json])]
pub struct Config {
    pub admin: AccountId,
    pub agent: AccountId,
    pub token: AccountId,
    pub settlement: AccountId,
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Families,
    Refs,
    Paid,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    admin: AccountId,
    agent: AccountId,
    token: AccountId,
    settlement: AccountId,
    families: LookupMap<String, Family>,
    /// "fam_…:<customer ref hash>" for every number a family may pay for.
    refs: LookupSet<String>,
    /// Order IDs already paid (or being paid).
    paid: LookupSet<String>,
}

fn is_family_id(s: &str) -> bool {
    s.len() == 20
        && s.starts_with("fam_")
        && s.bytes().skip(4).all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn is_order_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 24
        && b[..12].iter().all(u8::is_ascii_digit)
        && b[12..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// YYYYMM for a Unix time in ms, in Lagos time (days-to-civil, Howard Hinnant).
pub fn lagos_month(ms: u64) -> u32 {
    let days = ((ms + LAGOS_OFFSET_MS) / 86_400_000) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y * 100 + m) as u32
}

fn refuse(code: &str, why: &str) -> ! {
    env::panic_str(&format!("{code}: {why}"))
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "earmark-vault",
            "version": "1.0.0",
            "event": event,
            "data": [data],
        })
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        admin: AccountId,
        agent: AccountId,
        token: AccountId,
        settlement: AccountId,
    ) -> Self {
        Self {
            admin,
            agent,
            token,
            settlement,
            families: LookupMap::new(StorageKey::Families),
            refs: LookupSet::new(StorageKey::Refs),
            paid: LookupSet::new(StorageKey::Paid),
        }
    }

    fn only_admin(&self) {
        if env::predecessor_account_id() != self.admin {
            refuse("ERR_NOT_ADMIN", "only the admin can change families");
        }
    }

    fn family_mut(&mut self, family_id: &str) -> &mut Family {
        match self.families.get_mut(family_id) {
            Some(f) => f,
            None => refuse("ERR_NO_FAMILY", "no such family"),
        }
    }

    // ── Admin: families and their limits, on the sender's behalf ────────

    pub fn register_family(&mut self, family_id: String, limits: Limits) {
        self.only_admin();
        require!(is_family_id(&family_id), "family_id must be fam_ + 16 lowercase alphanumerics");
        require!(!self.families.contains_key(&family_id), "family already registered");
        self.families.insert(family_id.clone(), Family { balance: 0, limits, month: 0, spent: 0 });
        emit("family_registered", near_sdk::serde_json::json!({ "family_id": family_id }));
    }

    pub fn set_limits(&mut self, family_id: String, limits: Limits) {
        self.only_admin();
        self.family_mut(&family_id).limits = limits.clone();
        emit(
            "limits_set",
            near_sdk::serde_json::json!({ "family_id": family_id, "limits": limits }),
        );
    }

    pub fn set_frozen(&mut self, family_id: String, frozen: bool) {
        self.only_admin();
        self.family_mut(&family_id).limits.frozen = frozen;
        emit(
            "frozen_set",
            near_sdk::serde_json::json!({ "family_id": family_id, "frozen": frozen }),
        );
    }

    /// Add numbers the family may pay for, as salted customer-ref hashes.
    pub fn allow(&mut self, family_id: String, hashes: Vec<String>) {
        self.only_admin();
        require!(self.families.contains_key(&family_id), "no such family");
        for h in hashes {
            require!(is_hash(&h), "each hash must be 64 lowercase hex chars");
            self.refs.insert(format!("{family_id}:{h}"));
        }
    }

    pub fn disallow(&mut self, family_id: String, hashes: Vec<String>) {
        self.only_admin();
        for h in hashes {
            self.refs.remove(&format!("{family_id}:{h}"));
        }
    }

    pub fn set_agent(&mut self, agent: AccountId) {
        self.only_admin();
        self.agent = agent;
    }

    // ── Deposits: test USDC sent with ft_transfer_call, msg = family ID ──

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "only the vault's token");
        let Some(f) = self.families.get_mut(&msg) else {
            // Unknown family: send it all back.
            return PromiseOrValue::Value(amount);
        };
        f.balance += amount.0;
        emit(
            "deposit",
            near_sdk::serde_json::json!({ "family_id": msg, "from": sender_id, "amount": amount }),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ── The agent: one bill, inside the limits, or nothing ───────────────

    pub fn pay(
        &mut self,
        family_id: String,
        order_id: String,
        category: Category,
        amount: U128,
        customer_ref_hash: String,
    ) -> Promise {
        if env::predecessor_account_id() != self.agent {
            refuse("ERR_NOT_AGENT", "only the agent can pay");
        }
        require!(
            is_order_id(&order_id),
            "order_id must be YYYYMMDDHHmm + 12 lowercase alphanumerics"
        );
        require!(amount.0 > 0, "amount must be positive");
        if self.paid.contains(&order_id) {
            refuse("ERR_ALREADY_PAID", "this order was already paid");
        }
        if !self.refs.contains(&format!("{family_id}:{customer_ref_hash}")) {
            refuse("ERR_NOT_ON_LIST", "that number isn't on the sender's list");
        }
        let month = lagos_month(env::block_timestamp_ms());
        let f = self.family_mut(&family_id);
        if f.limits.frozen {
            refuse("ERR_FROZEN", "the account is frozen by the sender");
        }
        if amount.0 > f.limits.per_payment_max.0 {
            refuse("ERR_OVER_PER_PAYMENT", "more than the sender's per-payment cap");
        }
        if f.month != month {
            f.month = month;
            f.spent = 0;
        }
        if f.spent + amount.0 > f.limits.monthly_budget.0 {
            refuse("ERR_OVER_MONTHLY", "past the sender's monthly budget");
        }
        if f.balance < amount.0 {
            refuse("ERR_BALANCE", "not enough money in the family account");
        }
        f.balance -= amount.0;
        f.spent += amount.0;
        self.paid.insert(order_id.clone());
        emit(
            "payment",
            near_sdk::serde_json::json!({
                "family_id": family_id,
                "order_id": order_id,
                "category": category,
                "amount": amount,
                "to": self.settlement,
            }),
        );
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(self.settlement.clone(), amount, Some(format!("earmark {order_id}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAID)
                    .on_paid(family_id, order_id, amount, month),
            )
    }

    /// The transfer failed: the money and the month's budget go back, and
    /// the order can be paid again.
    #[private]
    pub fn on_paid(
        &mut self,
        family_id: String,
        order_id: String,
        amount: U128,
        month: u32,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        if let Some(f) = self.families.get_mut(&family_id) {
            f.balance += amount.0;
            if f.month == month {
                f.spent = f.spent.saturating_sub(amount.0);
            }
        }
        self.paid.remove(&order_id);
        emit(
            "payment_reverted",
            near_sdk::serde_json::json!({ "family_id": family_id, "order_id": order_id }),
        );
        false
    }

    // ── Views ─────────────────────────────────────────────────────────────

    pub fn family(&self, family_id: String) -> Option<FamilyView> {
        self.families.get(&family_id).map(|f| {
            let current = lagos_month(env::block_timestamp_ms());
            FamilyView {
                balance: U128(f.balance),
                limits: f.limits.clone(),
                month: current,
                spent_this_month: U128(if f.month == current { f.spent } else { 0 }),
            }
        })
    }

    pub fn is_allowed(&self, family_id: String, customer_ref_hash: String) -> bool {
        self.refs.contains(&format!("{family_id}:{customer_ref_hash}"))
    }

    pub fn is_paid(&self, order_id: String) -> bool {
        self.paid.contains(&order_id)
    }

    pub fn config(&self) -> Config {
        Config {
            admin: self.admin.clone(),
            agent: self.agent.clone(),
            token: self.token.clone(),
            settlement: self.settlement.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const FAM: &str = "fam_abcdefgh12345678";
    const ORDER: &str = "202611141200abcdefghijkl";

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn hash(c: char) -> String {
        c.to_string().repeat(64)
    }
    fn as_(who: &str) {
        // 2026-11-14 12:00 UTC
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct("vault.test"))
            .predecessor_account_id(acct(who))
            .block_timestamp(1_794_657_600_000_000_000)
            .build());
    }
    fn limits() -> Limits {
        Limits { frozen: false, per_payment_max: U128(5_000_000), monthly_budget: U128(8_000_000) }
    }
    /// A family with $10 and one allowed meter.
    fn vault() -> Contract {
        as_("admin.test");
        let mut c = Contract::new(
            acct("admin.test"),
            acct("agent.test"),
            acct("usdc.test"),
            acct("settle.test"),
        );
        c.register_family(FAM.into(), limits());
        c.allow(FAM.into(), vec![hash('a')]);
        as_("usdc.test");
        let _ = c.ft_on_transfer(acct("ada.test"), U128(10_000_000), FAM.into());
        c
    }
    fn pay(c: &mut Contract, order: &str, amount: u128, h: char) {
        as_("agent.test");
        let _ = c.pay(FAM.into(), order.into(), Category::Electricity, U128(amount), hash(h));
    }
    fn view(c: &Contract) -> FamilyView {
        c.family(FAM.into()).unwrap()
    }

    #[test]
    fn months_follow_lagos_time() {
        assert_eq!(lagos_month(1_794_657_600_000), 202611);
        // 2026-11-30 23:30 UTC is already December in Lagos.
        assert_eq!(lagos_month(1_796_081_400_000), 202612);
        assert_eq!(lagos_month(0), 197001);
    }

    #[test]
    fn deposits_credit_the_family_and_unknown_families_are_refunded() {
        let mut c = vault();
        assert_eq!(view(&c).balance, U128(10_000_000));
        as_("usdc.test");
        match c.ft_on_transfer(acct("ada.test"), U128(7), "fam_nobodynobody0000".into()) {
            PromiseOrValue::Value(v) => assert_eq!(v, U128(7)),
            PromiseOrValue::Promise(_) => panic!("expected a value"),
        }
    }

    #[test]
    #[should_panic(expected = "only the vault's token")]
    fn deposits_only_from_the_token() {
        let mut c = vault();
        as_("fake-usdc.test");
        let _ = c.ft_on_transfer(acct("ada.test"), U128(1), FAM.into());
    }

    #[test]
    fn the_agent_pays_inside_the_limits() {
        let mut c = vault();
        pay(&mut c, ORDER, 3_770_000, 'a');
        let v = view(&c);
        assert_eq!(v.balance, U128(6_230_000));
        assert_eq!(v.spent_this_month, U128(3_770_000));
        assert!(c.is_paid(ORDER.into()));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_AGENT")]
    fn nobody_else_can_pay() {
        let mut c = vault();
        as_("admin.test");
        let _ = c.pay(FAM.into(), ORDER.into(), Category::Electricity, U128(1), hash('a'));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ADMIN")]
    fn the_agent_cannot_change_limits() {
        let mut c = vault();
        as_("agent.test");
        c.set_limits(FAM.into(), Limits { per_payment_max: U128(u128::MAX), ..limits() });
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ADMIN")]
    fn the_agent_cannot_add_numbers() {
        let mut c = vault();
        as_("agent.test");
        c.allow(FAM.into(), vec![hash('b')]);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ON_LIST")]
    fn a_number_not_on_the_list_is_refused() {
        let mut c = vault();
        pay(&mut c, ORDER, 1_000_000, 'b');
    }

    #[test]
    #[should_panic(expected = "ERR_FROZEN")]
    fn a_frozen_family_is_refused() {
        let mut c = vault();
        as_("admin.test");
        c.set_frozen(FAM.into(), true);
        pay(&mut c, ORDER, 1_000_000, 'a');
    }

    #[test]
    #[should_panic(expected = "ERR_OVER_PER_PAYMENT")]
    fn over_the_per_payment_cap_is_refused() {
        let mut c = vault();
        pay(&mut c, ORDER, 5_000_001, 'a');
    }

    #[test]
    #[should_panic(expected = "ERR_OVER_MONTHLY")]
    fn splitting_cannot_pass_the_monthly_budget() {
        let mut c = vault();
        pay(&mut c, "202611141200aaaaaaaaaaaa", 4_000_000, 'a');
        pay(&mut c, "202611141201bbbbbbbbbbbb", 4_000_000, 'a');
        pay(&mut c, "202611141202cccccccccccc", 1, 'a');
    }

    #[test]
    #[should_panic(expected = "ERR_ALREADY_PAID")]
    fn an_order_is_paid_once() {
        let mut c = vault();
        pay(&mut c, ORDER, 1_000_000, 'a');
        pay(&mut c, ORDER, 1_000_000, 'a');
    }

    #[test]
    #[should_panic(expected = "ERR_BALANCE")]
    fn no_more_than_the_family_holds() {
        let mut c = vault();
        as_("admin.test");
        c.set_limits(
            FAM.into(),
            Limits {
                per_payment_max: U128(50_000_000),
                monthly_budget: U128(50_000_000),
                ..limits()
            },
        );
        pay(&mut c, ORDER, 10_000_001, 'a');
    }

    #[test]
    fn a_failed_transfer_puts_the_money_and_budget_back() {
        let mut c = vault();
        pay(&mut c, ORDER, 3_000_000, 'a');
        as_("vault.test");
        assert!(!c.on_paid(
            FAM.into(),
            ORDER.into(),
            U128(3_000_000),
            202611,
            Err(PromiseError::Failed)
        ));
        let v = view(&c);
        assert_eq!(v.balance, U128(10_000_000));
        assert_eq!(v.spent_this_month, U128(0));
        assert!(!c.is_paid(ORDER.into()));
    }

    #[test]
    fn removing_a_number_stops_payments_to_it() {
        let mut c = vault();
        as_("admin.test");
        c.disallow(FAM.into(), vec![hash('a')]);
        assert!(!c.is_allowed(FAM.into(), hash('a')));
    }
}
