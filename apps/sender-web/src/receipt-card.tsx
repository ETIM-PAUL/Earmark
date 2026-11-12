import { formatNaira, formatUsdc, type Receipt } from "@earmark/shared";
import { EXPLORER, LOCAL_RPC, type Network, type TxCheck } from "./receipts.js";

// One public receipt. It shows only what the contract holds: no names, no
// phone or meter numbers, no electricity token. The customer reference
// hash isn't shown either: it is for matching, not for reading.

const CATEGORY: Record<Receipt["category"], { label: string; icon: string }> = {
  electricity: { label: "Electricity", icon: "💡" },
  airtime: { label: "Airtime", icon: "📱" },
  data: { label: "Data", icon: "📶" },
  tv: { label: "TV", icon: "📺" },
};

export const lagosTime = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export const S = {
  card: {
    border: "1px solid #e4e4e7",
    borderRadius: 12,
    padding: 16,
    background: "#fff",
  },
  muted: { color: "#71717a", fontSize: 13 },
  ok: { color: "#15803d" },
  warn: { color: "#b45309" },
} as const;

export function ReceiptCard({
  r,
  network,
  txHash,
  check,
  compact,
}: {
  r: Receipt;
  network: Network;
  txHash?: string | null | undefined;
  check?: TxCheck | "checking" | null | undefined;
  compact?: boolean;
}) {
  const c = CATEGORY[r.category];
  const paid = r.status === "fulfilled";
  return (
    <article style={S.card} data-order={r.orderId}>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}
      >
        <strong style={{ fontSize: compact ? 16 : 20 }}>
          <span aria-hidden="true">{c.icon}</span> {c.label}
        </strong>
        <span style={paid ? S.ok : S.warn}>{paid ? "Paid" : "Refunded"}</span>
      </div>
      <div style={{ fontSize: compact ? 22 : 32, fontWeight: 700, margin: "8px 0 0" }}>
        {formatNaira(r.amountNgnKobo)}
      </div>
      <div style={S.muted}>
        {formatUsdc(r.amountUsdcAtomic)} USDC · {lagosTime(r.recordedAtMs)} Lagos time
      </div>
      {!paid && (
        <p style={{ ...S.muted, margin: "8px 0 0" }}>
          The bill wasn't paid, so the money went back to the family account.
        </p>
      )}
      <div style={{ ...S.muted, marginTop: 8, overflowWrap: "anywhere" }}>
        Order {r.orderId}
        {txHash && (
          <>
            {" · "}
            {LOCAL_RPC ? (
              "local demo transaction"
            ) : (
              <a href={`${EXPLORER[network]}/txns/${txHash}`}>on-chain transaction</a>
            )}
            {check === "checking" && " · checking…"}
            {check && check !== "checking" && check.verified && (
              <span style={S.ok}> · ✓ verified on NEAR {network}</span>
            )}
            {check && check !== "checking" && !check.verified && (
              <span style={S.warn}> · not verified: {check.why}</span>
            )}
          </>
        )}
      </div>
    </article>
  );
}
