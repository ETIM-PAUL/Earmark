import { formatNaira, type NgnKobo } from "@earmark/shared";
import type { VtpassResponse } from "./client.js";

/**
 * Float guard: the VTpass wallet is prepaid by us in naira. When a bill would
 * take it below the floor, new orders stop and the lead is alerted, so we
 * never take a family's money for a bill we can't buy.
 *
 * Fails closed: if the balance can't be read, no new orders.
 */

export type FloatCheck =
  | { ok: true; balanceKobo: NgnKobo }
  | {
      ok: false;
      reason: "below_floor" | "unreadable";
      balanceKobo: NgnKobo | null;
      /** Safe to show the recipient. */
      recipient: string;
    };

export interface FloatGuardOptions {
  balance: () => Promise<VtpassResponse>;
  floorKobo: NgnKobo;
  /** Reuse a balance reading this long. Default 30 s. */
  cacheMs?: number;
  /** Tells the lead. Called once when the float goes low, again only after it recovers. */
  alert?: (msg: string) => void;
  now?: () => Date;
}

const PAUSED = "Bill payments are paused for a short while. Please try again later.";

/**
 * VTpass answers `/balance` with `{ code: 1, contents: { balance: "1996088.70" } }`,
 * in naira, as a string (a number is accepted too).
 */
export function balanceKoboOf(res: VtpassResponse): NgnKobo | null {
  const raw = (res.contents as { balance?: unknown } | undefined)?.balance;
  if ((res.code as unknown) !== 1) return null;
  const balance =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(balance)) return null;
  return Math.max(0, Math.round(balance * 100));
}

export class FloatGuard {
  private reading: { kobo: NgnKobo; at: number } | null = null;
  private alerted = false;
  private readonly now: () => Date;
  private readonly alert: (msg: string) => void;

  constructor(private readonly opts: FloatGuardOptions) {
    this.now = opts.now ?? (() => new Date());
    this.alert = opts.alert ?? ((m) => console.error(`ALERT ${m}`));
  }

  /** Can we take an order for this amount? */
  async check(amountNgnKobo: NgnKobo): Promise<FloatCheck> {
    const balanceKobo = await this.balanceKobo();
    if (balanceKobo === null) {
      this.raise("VTpass balance unreadable; new orders stopped");
      return { ok: false, reason: "unreadable", balanceKobo, recipient: PAUSED };
    }
    if (balanceKobo - amountNgnKobo < this.opts.floorKobo) {
      this.raise(
        `VTpass float ${formatNaira(balanceKobo)} is at or near the ${formatNaira(this.opts.floorKobo)} floor; new orders stopped. Top up the VTpass wallet.`,
      );
      return { ok: false, reason: "below_floor", balanceKobo, recipient: PAUSED };
    }
    if (balanceKobo - this.opts.floorKobo >= this.opts.floorKobo) this.alerted = false;
    return { ok: true, balanceKobo };
  }

  /** Count a purchase against the cached reading until the next refresh. */
  spent(amountNgnKobo: NgnKobo): void {
    if (this.reading) this.reading.kobo = Math.max(0, this.reading.kobo - amountNgnKobo);
  }

  private async balanceKobo(): Promise<NgnKobo | null> {
    const t = this.now().getTime();
    if (this.reading && t - this.reading.at < (this.opts.cacheMs ?? 30_000)) {
      return this.reading.kobo;
    }
    let kobo: NgnKobo | null = null;
    try {
      kobo = balanceKoboOf(await this.opts.balance());
    } catch {
      kobo = null;
    }
    this.reading = kobo === null ? null : { kobo, at: t };
    return kobo;
  }

  private raise(msg: string): void {
    if (this.alerted) return;
    this.alerted = true;
    this.alert(msg);
  }
}
