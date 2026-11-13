import { formatNaira, formatUsdc, type Receipt } from "@earmark/shared";
import { EXPLORER, LOCAL_RPC, type Network, type TxCheck } from "./receipts.js";

// One public receipt. It shows only what the contract holds: no names, no
// phone or meter numbers, no electricity token. The customer reference
// hash isn't shown either: it is for matching, not for reading.

const CATEGORY: Record<Receipt["category"], string> = {
  electricity: "Electricity",
  airtime: "Airtime",
  data: "Data",
  tv: "TV",
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

// Inline styles for the judge page's panes. They use the design tokens, so
// they follow the same palette as the stub and the app.
export const S = {
  card: {
    border: "2px solid var(--rule)",
    borderRadius: 10,
    padding: 16,
    background: "var(--surface)",
  },
  muted: { color: "var(--text-2)", fontSize: 14 },
  ok: { color: "var(--good)", fontWeight: 700 },
  warn: { color: "var(--wait-text)", fontWeight: 700 },
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
  const paid = r.status === "fulfilled";
  return (
    <div className="stub-wrap">
      <article className="stub" data-order={r.orderId}>
        <div className="stub-body">
          <span className="kind">{CATEGORY[r.category]}</span>
          <span className="amount" style={compact ? { fontSize: "1.9rem" } : undefined}>
            {formatNaira(r.amountNgnKobo)}
          </span>
          <span className="fine">
            {formatUsdc(r.amountUsdcAtomic)} USDC, {lagosTime(r.recordedAtMs)} Lagos time
          </span>
          <span className={paid ? "status-paid" : "status-refunded"}>
            {paid ? "Paid" : "Refunded"}
          </span>
          {!paid && (
            <span className="fine">
              The bill wasn't paid, so the money went back to the family account.
            </span>
          )}
          <span className="fine mono">Order {r.orderId}</span>
        </div>
        <div className="stub-foot">
          <span>
            {txHash ? (
              LOCAL_RPC ? (
                "Local demo transaction"
              ) : (
                <a href={`${EXPLORER[network]}/txns/${txHash}`}>On-chain transaction</a>
              )
            ) : (
              "Recorded on NEAR"
            )}
            {check === "checking" && ", checking…"}
            {check && check !== "checking" && check.verified && (
              <span style={{ color: "var(--green)", fontWeight: 700 }}>
                {" "}
                ✓ verified on NEAR {network}
              </span>
            )}
            {check && check !== "checking" && !check.verified && (
              <span style={{ color: "var(--red)", fontWeight: 700 }}>
                {" "}
                not verified: {check.why}
              </span>
            )}
          </span>
        </div>
      </article>
    </div>
  );
}
