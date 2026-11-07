import { formatNaira, type Order, type OrderStatus } from "@earmark/shared";

/**
 * What the lead watches: the VTpass float, orders stuck in a money-holding
 * step, failed orders and bot errors. Problems go out as alerts (console,
 * plus a Telegram chat when ALERTS_TELEGRAM_CHAT_ID is set), each repeated
 * at most once per `repeatMs`. GET /status shows the same numbers.
 *
 * Deposit delays join this in Phase 8, when deposits exist.
 */

/** How long an order may sit in a step before someone should look. */
export const STUCK_AFTER_MS: Partial<Record<OrderStatus, number>> = {
  paying: 5 * 60_000,
  paid: 5 * 60_000,
  purchasing: 15 * 60_000,
  failed: 5 * 60_000,
  refunding: 10 * 60_000,
};

/** A finished bill whose receipt isn't on-chain yet, e.g. the contract ran out of storage balance. */
export const RECEIPT_OWED_AFTER_MS = 10 * 60_000;

export type Counter = "messages" | "botErrors" | "modelBusy" | "rateLimited" | "duplicates";

export interface MonitorOptions {
  /** Where alerts go. Default console.error. */
  send?: (msg: string) => void;
  repeatMs?: number;
  now?: () => number;
}

export interface Snapshot {
  orders: Order[];
  floatKobo: number | null;
  floorKobo: number;
}

export class Monitor {
  readonly counters: Record<Counter, number> = {
    messages: 0,
    botErrors: 0,
    modelBusy: 0,
    rateLimited: 0,
    duplicates: 0,
  };
  private readonly lastSent = new Map<string, number>();
  private readonly recent: { at: string; msg: string }[] = [];
  private last: ReturnType<Monitor["summarize"]> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: MonitorOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  count(c: Counter): void {
    this.counters[c] += 1;
  }

  /** Raise an alert. The same key alerts again only after repeatMs. */
  alert(msg: string, key = msg): void {
    const t = this.now();
    const prev = this.lastSent.get(key);
    if (prev !== undefined && t - prev < (this.opts.repeatMs ?? 10 * 60_000)) return;
    this.lastSent.set(key, t);
    this.recent.push({ at: new Date(t).toISOString(), msg });
    if (this.recent.length > 50) this.recent.shift();
    (this.opts.send ?? ((m: string) => console.error(`ALERT ${m}`)))(msg);
  }

  /** Look at the orders and the float; alert on anything stuck or low. */
  check(s: Snapshot): ReturnType<Monitor["summarize"]> {
    const sum = this.summarize(s);
    for (const o of sum.stuck) {
      this.alert(
        o.step === "receipt owed"
          ? `order ${o.id} finished ${o.minutes} min ago but has no receipt on-chain`
          : `order ${o.id} has been ${o.step} for ${o.minutes} min`,
        `stuck:${o.id}:${o.step}`,
      );
    }
    if (s.floatKobo === null) this.alert("VTpass float unreadable", "float");
    else if (s.floatKobo < s.floorKobo * 2) {
      this.alert(
        `VTpass float is ${formatNaira(s.floatKobo)}, under twice the ${formatNaira(s.floorKobo)} floor. Top up soon.`,
        "float",
      );
    }
    const refunded = sum.byStatus.refunded ?? 0;
    const finished = (sum.byStatus.fulfilled ?? 0) + refunded;
    if (finished >= 5 && refunded / finished > 0.3) {
      this.alert(`${refunded} of ${finished} finished bills were refunded`, "failure-rate");
    }
    this.last = sum;
    return sum;
  }

  status() {
    return {
      counters: this.counters,
      orders: this.last,
      alerts: this.recent.slice(-20),
    };
  }

  private summarize(s: Snapshot) {
    const t = this.now();
    const byStatus: Partial<Record<OrderStatus, number>> = {};
    const stuck: { id: string; step: OrderStatus | "receipt owed"; minutes: number }[] = [];
    for (const o of s.orders) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      const age = t - Date.parse(o.updatedAt);
      const minutes = Math.floor(age / 60_000);
      const limit = STUCK_AFTER_MS[o.status];
      if (limit !== undefined && age >= limit) stuck.push({ id: o.id, step: o.status, minutes });
      const finished = o.status === "fulfilled" || o.status === "refunded";
      const onChain = o.receiptTxHash && !o.receiptTxHash.includes(":");
      if (finished && !onChain && age >= RECEIPT_OWED_AFTER_MS) {
        stuck.push({ id: o.id, step: "receipt owed", minutes });
      }
    }
    return {
      at: new Date(t).toISOString(),
      floatNgn: s.floatKobo === null ? null : formatNaira(s.floatKobo),
      byStatus,
      stuck,
    };
  }
}
