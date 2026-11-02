//! Earmark receipts contract skeleton. Owner: Contracts.
//!
//! Phase 1 fixes the `Receipt` shape every pod agreed on. Its JSON matches
//! `Receipt` in packages/shared/src/receipt.ts key for key. Phase 7 adds
//! orders, refunds, NEP-297 events and workspace tests.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Electricity,
    Airtime,
    Data,
    Tv,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiptStatus {
    Fulfilled,
    Refunded,
}

/// What the service submits. Names, phone and meter numbers never appear
/// here: only the salted `customer_ref_hash`.
#[near(serializers = [json, borsh])]
#[serde(rename_all = "camelCase")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptInput {
    pub order_id: String,
    pub family_id: String,
    pub category: Category,
    pub amount_ngn_kobo: u64,
    pub amount_usdc_atomic: U128,
    pub customer_ref_hash: String,
    pub status: ReceiptStatus,
    pub payment_tx_hash: Option<String>,
    pub refund_tx_hash: Option<String>,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "camelCase")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub order_id: String,
    pub family_id: String,
    pub category: Category,
    pub amount_ngn_kobo: u64,
    pub amount_usdc_atomic: U128,
    pub customer_ref_hash: String,
    pub status: ReceiptStatus,
    pub payment_tx_hash: Option<String>,
    pub refund_tx_hash: Option<String>,
    pub recorded_at_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// The only account allowed to write receipts.
    service: AccountId,
    receipts: LookupMap<String, Receipt>,
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

#[near]
impl Contract {
    #[init]
    pub fn new(service: AccountId) -> Self {
        Self { service, receipts: LookupMap::new(b"r") }
    }

    /// Service only. One receipt per order ID; it cannot be overwritten.
    pub fn record_receipt(&mut self, receipt: ReceiptInput) -> Receipt {
        require!(
            env::predecessor_account_id() == self.service,
            "only the service may write receipts"
        );
        require!(is_order_id(&receipt.order_id), "invalid order id");
        require!(is_hash(&receipt.customer_ref_hash), "customer_ref_hash must be 64 hex chars");
        require!(!self.receipts.contains_key(&receipt.order_id), "receipt already recorded");

        let stored = Receipt {
            order_id: receipt.order_id,
            family_id: receipt.family_id,
            category: receipt.category,
            amount_ngn_kobo: receipt.amount_ngn_kobo,
            amount_usdc_atomic: receipt.amount_usdc_atomic,
            customer_ref_hash: receipt.customer_ref_hash,
            status: receipt.status,
            payment_tx_hash: receipt.payment_tx_hash,
            refund_tx_hash: receipt.refund_tx_hash,
            recorded_at_ms: env::block_timestamp_ms(),
        };
        self.receipts.insert(stored.order_id.clone(), stored.clone());
        stored
    }

    pub fn get_receipt(&self, order_id: String) -> Option<Receipt> {
        self.receipts.get(&order_id).cloned()
    }

    pub fn service(&self) -> AccountId {
        self.service.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn input() -> ReceiptInput {
        ReceiptInput {
            order_id: "202611031000abcdef123456".into(),
            family_id: "fam_abcdefgh12345678".into(),
            category: Category::Electricity,
            amount_ngn_kobo: 1_000_000,
            amount_usdc_atomic: U128(6_201_550),
            customer_ref_hash: "a".repeat(64),
            status: ReceiptStatus::Fulfilled,
            payment_tx_hash: Some("8Tq3".into()),
            refund_tx_hash: None,
        }
    }

    fn as_caller(caller: AccountId) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(caller).build());
    }

    #[test]
    fn service_records_and_anyone_reads() {
        as_caller(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.record_receipt(input());
        as_caller(accounts(1));
        let r = c.get_receipt("202611031000abcdef123456".into()).unwrap();
        assert_eq!(r.amount_ngn_kobo, 1_000_000);
        assert_eq!(r.status, ReceiptStatus::Fulfilled);
    }

    #[test]
    fn json_matches_the_shared_typescript_receipt() {
        as_caller(accounts(0));
        let mut c = Contract::new(accounts(0));
        let r = c.record_receipt(input());
        let json = near_sdk::serde_json::to_value(&r).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "amountNgnKobo",
                "amountUsdcAtomic",
                "category",
                "customerRefHash",
                "familyId",
                "orderId",
                "paymentTxHash",
                "recordedAtMs",
                "refundTxHash",
                "status",
            ]
        );
        assert_eq!(json["amountUsdcAtomic"], "6201550");
        assert_eq!(json["category"], "electricity");
    }

    #[test]
    #[should_panic(expected = "only the service may write receipts")]
    fn others_cannot_write() {
        as_caller(accounts(0));
        let mut c = Contract::new(accounts(0));
        as_caller(accounts(1));
        c.record_receipt(input());
    }

    #[test]
    #[should_panic(expected = "receipt already recorded")]
    fn no_overwrites() {
        as_caller(accounts(0));
        let mut c = Contract::new(accounts(0));
        c.record_receipt(input());
        c.record_receipt(input());
    }
}
