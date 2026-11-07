/**
 * Per-chat rate limit: a token bucket. Each message takes a token; tokens
 * come back at a steady rate. It keeps one chat from flooding the model,
 * the biller lookups and the quote sources.
 *
 * The first message over the limit gets one "slow down" reply; the rest are
 * dropped quietly until tokens come back.
 */

export interface RateLimitOptions {
  /** Messages allowed in a burst. Default 8. */
  burst?: number;
  /** One token back every this many ms. Default 5 s (12 a minute). */
  refillMs?: number;
  now?: () => number;
}

export type Admit = "ok" | "warn" | "drop";

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number; warned: boolean }>();
  private readonly burst: number;
  private readonly refillMs: number;
  private readonly now: () => number;

  constructor(opts: RateLimitOptions = {}) {
    this.burst = opts.burst ?? 8;
    this.refillMs = opts.refillMs ?? 5_000;
    this.now = opts.now ?? Date.now;
  }

  admit(chat: string): Admit {
    const t = this.now();
    const b = this.buckets.get(chat) ?? { tokens: this.burst, at: t, warned: false };
    const back = Math.floor((t - b.at) / this.refillMs);
    if (back > 0) {
      b.tokens = Math.min(this.burst, b.tokens + back);
      b.at += back * this.refillMs;
    }
    if (b.tokens >= this.burst) b.at = t;
    let verdict: Admit;
    if (b.tokens > 0) {
      b.tokens -= 1;
      b.warned = false;
      verdict = "ok";
    } else {
      verdict = b.warned ? "drop" : "warn";
      b.warned = true;
    }
    this.buckets.set(chat, b);
    if (this.buckets.size > 10_000) this.prune(t);
    return verdict;
  }

  /** Forget full buckets, so memory stays flat. */
  private prune(t: number): void {
    for (const [chat, b] of this.buckets) {
      if (b.tokens + Math.floor((t - b.at) / this.refillMs) >= this.burst)
        this.buckets.delete(chat);
    }
  }
}

/** Remembers recent message IDs, so a redelivered webhook isn't handled twice. */
export class SeenIds {
  private readonly ids = new Set<string>();

  constructor(private readonly max = 5_000) {}

  /** True the first time an ID is seen. */
  first(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }
}
