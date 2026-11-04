import type { NgnKobo, Quote } from "@earmark/shared";

/**
 * Naira quotes: what one bill costs the family in USDC.
 *
 * The market rate is the lower of our rate sources (fewer naira per dollar
 * means more USDC, so a stale or low source can only cost us, never the
 * family). Our spread comes off that rate, and the USDC amount rounds up to
 * the next atomic unit. The quote holds for 10 minutes.
 */

/** Market NGN per 1 USD (or USDC), e.g. 1346.07. */
export type RateSource = { name: string; fetch: () => Promise<number> };

export const QUOTE_VALIDITY_MS = 10 * 60 * 1000;

export class QuoteUnavailableError extends Error {
  /** Safe to show the recipient. */
  readonly recipient = "We can't price bills right now. Please try again in a few minutes.";
  constructor(message: string) {
    super(message);
    this.name = "QuoteUnavailableError";
  }
}

/**
 * Pure quote maths, in integers. `marketRate` is NGN per USD; the customer
 * rate is floored to the kobo, and USDC rounds up.
 */
export function quoteFor(
  amountNgnKobo: NgnKobo,
  marketRate: number,
  spreadBps: number,
  now: Date = new Date(),
): Quote {
  if (!Number.isSafeInteger(amountNgnKobo) || amountNgnKobo <= 0) {
    throw new Error("amount must be a positive number of kobo");
  }
  if (!Number.isFinite(marketRate) || marketRate <= 0) throw new Error("bad market rate");
  if (!Number.isInteger(spreadBps) || spreadBps < 0 || spreadBps >= 10_000) {
    throw new Error("spread must be 0–9999 basis points");
  }
  // Kobo per USD, i.e. the rate to two decimal places.
  const marketKobo = BigInt(Math.floor(marketRate * 100));
  const rateKobo = (marketKobo * BigInt(10_000 - spreadBps)) / 10_000n;
  if (rateKobo <= 0n) throw new Error("rate rounds to zero");
  // USD = kobo / rateKobo; atomic = USD × 10^6, rounded up.
  const num = BigInt(amountNgnKobo) * 1_000_000n;
  const atomic = (num + rateKobo - 1n) / rateKobo;
  return {
    rateNgnPerUsd: `${rateKobo / 100n}.${String(rateKobo % 100n).padStart(2, "0")}`,
    amountUsdcAtomic: atomic.toString(),
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + QUOTE_VALIDITY_MS).toISOString(),
  };
}

export function quoteIsFresh(quote: Quote, now: Date = new Date()): boolean {
  return now.getTime() < Date.parse(quote.expiresAt);
}

export interface QuoterOptions {
  sources: RateSource[];
  spreadBps: number;
  /** Refuse to quote when sources disagree by more than this. Default 300 (3%). */
  maxDisagreementBps?: number;
  /** Reuse a fetched rate this long. Default 60 s. */
  cacheMs?: number;
  /** Plausible NGN per USD. Anything outside is a broken feed. */
  sane?: { min: number; max: number };
  now?: () => Date;
  /** Told when a source fails or sources disagree. Default console.warn. */
  warn?: (msg: string) => void;
}

export class Quoter {
  private cached: { rate: number; at: number } | null = null;
  private readonly now: () => Date;
  private readonly warn: (msg: string) => void;

  constructor(private readonly opts: QuoterOptions) {
    if (opts.sources.length === 0) throw new Error("need at least one rate source");
    this.now = opts.now ?? (() => new Date());
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  async quote(amountNgnKobo: NgnKobo): Promise<Quote> {
    return quoteFor(amountNgnKobo, await this.marketRate(), this.opts.spreadBps, this.now());
  }

  /** The market rate before our spread. Throws QuoteUnavailableError. */
  async marketRate(): Promise<number> {
    const t = this.now().getTime();
    if (this.cached && t - this.cached.at < (this.opts.cacheMs ?? 60_000)) return this.cached.rate;

    const sane = this.opts.sane ?? { min: 500, max: 10_000 };
    const results = await Promise.allSettled(this.opts.sources.map((s) => s.fetch()));
    const rates: number[] = [];
    results.forEach((r, i) => {
      const name = this.opts.sources[i]?.name;
      if (r.status === "rejected") this.warn(`rate source ${name} failed: ${String(r.reason)}`);
      else if (!(r.value >= sane.min && r.value <= sane.max))
        this.warn(`rate source ${name} gave an implausible ${r.value}`);
      else rates.push(r.value);
    });
    if (rates.length === 0) throw new QuoteUnavailableError("no rate source answered");

    const lo = Math.min(...rates);
    const hi = Math.max(...rates);
    const maxBps = this.opts.maxDisagreementBps ?? 300;
    if (((hi - lo) / lo) * 10_000 > maxBps) {
      this.warn(`rate sources disagree: ${rates.join(" vs ")}`);
      throw new QuoteUnavailableError(`rate sources disagree by more than ${maxBps} bps`);
    }
    this.cached = { rate: lo, at: t };
    return lo;
  }
}

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

/** Live USDC→NGN from Coinbase. No key. */
export const coinbaseRate: RateSource = {
  name: "coinbase",
  fetch: async () => {
    const j = (await getJson("https://api.coinbase.com/v2/exchange-rates?currency=USDC")) as {
      data?: { rates?: { NGN?: string } };
    };
    return Number(j.data?.rates?.NGN);
  },
};

/** Daily USD→NGN reference from open.er-api.com. No key. */
export const erApiRate: RateSource = {
  name: "open.er-api",
  fetch: async () => {
    const j = (await getJson("https://open.er-api.com/v6/latest/USD")) as {
      result?: string;
      rates?: { NGN?: number };
    };
    if (j.result !== "success") throw new Error(`result ${j.result}`);
    return Number(j.rates?.NGN);
  },
};

export const DEFAULT_RATE_SOURCES = [coinbaseRate, erApiRate];
