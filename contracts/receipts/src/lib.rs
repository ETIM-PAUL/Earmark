//! Earmark receipts contract. Owner: Contracts.
//!
//! One receipt per order, written once when the order ends: `fulfilled`
//! (the bill was paid) or `refunded` (the money went back to the family).
//! Only the service account writes; anyone reads. Every write emits a
//! NEP-297 event so the public receipts page can stream new receipts.
//!
//! No personal data: names, phone and meter numbers never reach this
//! contract. Every string field is checked against a strict format, so
//! free text can't slip on-chain by accident. The `Receipt` JSON matches
//! `Receipt` in packages/shared/src/receipt.ts key for key.

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

/// The most receipts one `receipts_for_family` call returns.
pub const MAX_PAGE: u32 = 50;

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

/// NEP-297 events, logged as `EVENT_JSON:{"standard":"earmark_receipts",...}`.
#[near(event_json(standard = "earmark_receipts"))]
pub enum Event {
    #[event_version("1.0.0")]
    ReceiptRecorded(Receipt),
    #[event_version("1.0.0")]
    ServiceChanged { old_service: AccountId, new_service: AccountId },
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Receipts,
    FamilyIndex,
    Family { family_id: String },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// May change the service account, e.g. if its key leaks. Writes nothing else.
    owner: AccountId,
    /// The only account allowed to write receipts.
    service: AccountId,
    receipts: LookupMap<String, Receipt>,
    /// Order IDs per family, oldest first.
    by_family: LookupMap<String, Vector<String>>,
    count: u64,
}

fn is_order_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 24
        && b[..12].iter().all(u8::is_ascii_digit)
        && b[12..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn is_family_id(s: &str) -> bool {
    s.len() == 20
        && s.starts_with("fam_")
        && s.bytes().skip(4).all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A transaction hash or provider reference: base58, hex or an ID like
/// `corr_01J…`. No spaces or `@`, so it can't carry a name or a phone.
fn is_tx_ref(s: &str) -> bool {
    (8..=128).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':' | b'.'))
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, service: AccountId) -> Self {
        Self {
            owner,
            service,
            receipts: LookupMap::new(StorageKey::Receipts),
            by_family: LookupMap::new(StorageKey::FamilyIndex),
            count: 0,
        }
    }

    /// Service only. One receipt per order ID; it cannot be overwritten.
    ///
    /// `fulfilled` needs the payment reference and no refund reference.
    /// `refunded` needs both: we only refund money we were paid.
    pub fn record_receipt(&mut self, receipt: ReceiptInput) -> Receipt {
        require!(
            env::predecessor_account_id() == self.service,
            "only the service may write receipts"
        );
        require!(is_order_id(&receipt.order_id), "invalid order id");
        require!(is_family_id(&receipt.family_id), "invalid family id");
        require!(is_hash(&receipt.customer_ref_hash), "customer_ref_hash must be 64 hex chars");
        require!(receipt.amount_ngn_kobo > 0, "amount_ngn_kobo must be positive");
        require!(receipt.amount_usdc_atomic.0 > 0, "amount_usdc_atomic must be positive");
        for r in [&receipt.payment_tx_hash, &receipt.refund_tx_hash].into_iter().flatten() {
            require!(is_tx_ref(r), "invalid transaction reference");
        }
        require!(receipt.payment_tx_hash.is_some(), "payment_tx_hash is required");
        match receipt.status {
            ReceiptStatus::Fulfilled => {
                require!(receipt.refund_tx_hash.is_none(), "a fulfilled receipt has no refund")
            }
            ReceiptStatus::Refunded => {
                require!(
                    receipt.refund_tx_hash.is_some(),
                    "a refunded receipt needs refund_tx_hash"
                )
            }
        }
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
        let family = stored.family_id.clone();
        self.by_family
            .entry(family.clone())
            .or_insert_with(|| Vector::new(StorageKey::Family { family_id: family }))
            .push(stored.order_id.clone());
        self.count += 1;

        Event::ReceiptRecorded(stored.clone()).emit();
        stored
    }

    /// Owner only. Moves write access to a new service account.
    ///
    /// Needs exactly 1 yoctoNEAR attached, which only a full-access key can
    /// sign: a leaked function-call key on the owner account can't take
    /// over the receipts.
    #[payable]
    pub fn set_service(&mut self, service: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner may change service");
        assert_one_yocto();
        let old_service = std::mem::replace(&mut self.service, service.clone());
        Event::ServiceChanged { old_service, new_service: service }.emit();
    }

    pub fn get_receipt(&self, order_id: String) -> Option<Receipt> {
        self.receipts.get(&order_id).cloned()
    }

    /// A family's receipts, oldest first. At most `MAX_PAGE` per call.
    pub fn receipts_for_family(
        &self,
        family_id: String,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<Receipt> {
        let Some(ids) = self.by_family.get(&family_id) else { return vec![] };
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE);
        (from..ids.len().min(from.saturating_add(limit)))
            .filter_map(|i| ids.get(i))
            .filter_map(|id| self.receipts.get(id).cloned())
            .collect()
    }

    pub fn family_receipt_count(&self, family_id: String) -> u32 {
        self.by_family.get(&family_id).map_or(0, |ids| ids.len())
    }

    pub fn receipt_count(&self) -> u64 {
        self.count
    }

    pub fn service(&self) -> AccountId {
        self.service.clone()
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;
    use near_sdk::NearToken;

    const ORDER: &str = "202611031000abcdef123456";
    const FAMILY: &str = "fam_abcdefgh12345678";

    fn input() -> ReceiptInput {
        ReceiptInput {
            order_id: ORDER.into(),
            family_id: FAMILY.into(),
            category: Category::Electricity,
            amount_ngn_kobo: 1_000_000,
            amount_usdc_atomic: U128(6_201_550),
            customer_ref_hash: "a".repeat(64),
            status: ReceiptStatus::Fulfilled,
            payment_tx_hash: Some("8Tq3xKfbbJ9n2ZkqvUeA".into()),
            refund_tx_hash: None,
        }
    }

    fn refunded(order_id: &str) -> ReceiptInput {
        ReceiptInput {
            order_id: order_id.into(),
            status: ReceiptStatus::Refunded,
            refund_tx_hash: Some("Fq9vR2mWcLt7aHsE4uYb".into()),
            ..input()
        }
    }

    fn as_caller(caller: AccountId) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(caller).build());
    }

    /// accounts(0) owns the contract, accounts(1) is the service.
    fn contract() -> Contract {
        as_caller(accounts(0));
        let c = Contract::new(accounts(0), accounts(1));
        as_caller(accounts(1));
        c
    }

    #[test]
    fn service_records_and_anyone_reads() {
        let mut c = contract();
        c.record_receipt(input());
        as_caller(accounts(2));
        let r = c.get_receipt(ORDER.into()).unwrap();
        assert_eq!(r.amount_ngn_kobo, 1_000_000);
        assert_eq!(r.status, ReceiptStatus::Fulfilled);
        assert_eq!(c.receipt_count(), 1);
    }

    #[test]
    fn json_matches_the_shared_typescript_receipt() {
        let mut c = contract();
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
    fn emits_a_nep297_event_with_the_receipt() {
        let mut c = contract();
        c.record_receipt(input());
        let logs = get_logs();
        assert_eq!(logs.len(), 1);
        let body = logs[0].strip_prefix("EVENT_JSON:").expect("NEP-297 prefix");
        let ev: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(body).unwrap();
        assert_eq!(ev["standard"], "earmark_receipts");
        assert_eq!(ev["version"], "1.0.0");
        assert_eq!(ev["event"], "receipt_recorded");
        assert_eq!(ev["data"]["orderId"], ORDER);
        assert_eq!(ev["data"]["status"], "fulfilled");
    }

    #[test]
    fn records_refunds_with_both_references() {
        let mut c = contract();
        let r = c.record_receipt(refunded("202611031000refund000001"));
        assert_eq!(r.status, ReceiptStatus::Refunded);
        assert!(r.refund_tx_hash.is_some());
    }

    #[test]
    fn indexes_receipts_by_family_oldest_first() {
        let mut c = contract();
        c.record_receipt(input());
        c.record_receipt(refunded("202611031001second000002"));
        c.record_receipt(ReceiptInput {
            order_id: "202611031002other0000003".into(),
            family_id: "fam_zzzzzzzzzzzzzzzz".into(),
            ..input()
        });
        assert_eq!(c.family_receipt_count(FAMILY.into()), 2);
        let page = c.receipts_for_family(FAMILY.into(), None, None);
        let ids: Vec<_> = page.iter().map(|r| r.order_id.as_str()).collect();
        assert_eq!(ids, [ORDER, "202611031001second000002"]);
        assert_eq!(c.receipts_for_family(FAMILY.into(), Some(1), Some(5)).len(), 1);
        assert_eq!(c.receipts_for_family(FAMILY.into(), Some(9), None).len(), 0);
        assert!(c.receipts_for_family("fam_nobodynobodynobo".into(), None, None).is_empty());
        assert_eq!(c.receipt_count(), 3);
    }

    #[test]
    #[should_panic(expected = "only the service may write receipts")]
    fn others_cannot_write() {
        let mut c = contract();
        as_caller(accounts(2));
        c.record_receipt(input());
    }

    #[test]
    #[should_panic(expected = "only the service may write receipts")]
    fn the_owner_cannot_write_either() {
        let mut c = contract();
        as_caller(accounts(0));
        c.record_receipt(input());
    }

    #[test]
    #[should_panic(expected = "receipt already recorded")]
    fn no_overwrites() {
        let mut c = contract();
        c.record_receipt(input());
        c.record_receipt(refunded(ORDER));
    }

    fn rejects(change: impl FnOnce(&mut ReceiptInput), msg: &str) {
        let mut c = contract();
        let mut r = input();
        change(&mut r);
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.record_receipt(r)))
            .expect_err("should have been rejected");
        let text = err
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(text.contains(msg), "expected {msg:?}, got {text:?}");
    }

    #[test]
    fn rejects_malformed_or_inconsistent_receipts() {
        rejects(|r| r.order_id = "2026-11-03-abc".into(), "invalid order id");
        rejects(|r| r.family_id = "Mama Ngozi".into(), "invalid family id");
        rejects(|r| r.customer_ref_hash = "08031234567".into(), "customer_ref_hash");
        rejects(|r| r.amount_ngn_kobo = 0, "amount_ngn_kobo must be positive");
        rejects(|r| r.amount_usdc_atomic = U128(0), "amount_usdc_atomic must be positive");
        rejects(|r| r.payment_tx_hash = None, "payment_tx_hash is required");
        rejects(
            |r| r.payment_tx_hash = Some("call me 0803 123 4567".into()),
            "invalid transaction",
        );
        rejects(|r| r.refund_tx_hash = Some("Fq9vR2mWcLt7aHsE4uYb".into()), "has no refund");
        rejects(|r| r.status = ReceiptStatus::Refunded, "needs refund_tx_hash");
    }

    #[test]
    fn the_owner_rotates_the_service() {
        let mut c = contract();
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(accounts(0))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build());
        c.set_service(accounts(3));
        assert_eq!(c.service(), accounts(3));
        let ev = get_logs().pop().unwrap();
        assert!(ev.contains("\"event\":\"service_changed\""), "{ev}");
        as_caller(accounts(3));
        c.record_receipt(input());
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn rotating_the_service_needs_a_full_access_key() {
        let mut c = contract();
        as_caller(accounts(0));
        c.set_service(accounts(3));
    }

    #[test]
    #[should_panic(expected = "only the owner may change service")]
    fn the_service_cannot_rotate_itself() {
        let mut c = contract();
        c.set_service(accounts(2));
    }
}
