// What the bot's /api returns. Amounts arrive formatted ("₦25,000", "$18.85");
// the server owns the rounding.

export interface Account {
  id: string;
  name: string;
  familyIds: string[];
}

export interface PresetInfo {
  name: string;
  label: string;
  about: string;
}

export interface AppConfig {
  network: "testnet" | "mainnet";
  contractId: string | null;
  rpcUrl: string | null;
  presets: PresetInfo[];
  topUp: { enabled: boolean; why: string };
}

export interface Invite {
  familyId: string;
  expiresAt: string;
  telegram: string | null;
  whatsapp: string | null;
  feed: string | null;
  judge: string | null;
}

export interface CategoryRuleView {
  category: "electricity" | "airtime" | "data" | "tv";
  enabled: boolean;
  capNaira: number | null;
  spentNaira: number;
}

export interface Overview {
  senderName: string;
  frozen: boolean;
  rulesVersion: number;
  approvalAboveNaira: number | null;
  categories: CategoryRuleView[];
  budget: { monthlyUsd: string; spentUsd: string; leftUsd: string; perPaymentMaxUsd: string };
  recipientPhone: string;
  saved: { category: string; label: string; ref: string }[];
  rateNgnPerUsd: string | null;
}

export interface ApprovalCard {
  orderId: string;
  what: string;
  who: string;
  customerName: string;
  amountNgn: string;
  amountUsd: string;
  reasons: string[];
  requestedAt: string;
  expiresAt: string;
}

export interface OrderRow {
  id: string;
  category: string;
  label: string;
  who: string;
  amountNgn: string;
  amountUsd: string;
  status: string;
  note: string | null;
  createdAt: string;
  receiptTxHash: string | null;
}

export interface FamilyState {
  overview: Overview;
  approvals: ApprovalCard[];
  orders: OrderRow[];
}
