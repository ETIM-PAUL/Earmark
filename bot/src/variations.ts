/**
 * Picking a data bundle or TV bouquet from what the person said ("1.5GB",
 * "compact", "the 2k one"). VTpass's variation codes don't describe the
 * product (mtn-100mb-1000 is 1.5GB), so we match on the name and price.
 *
 * Exactly one match is picked. More than one, or none, becomes a short
 * numbered list for the person to choose from: the bot never guesses.
 */

export interface Option {
  code: string;
  name: string;
  amountNgnKobo: number;
}

export type Pick =
  | { kind: "one"; option: Option }
  | { kind: "choose"; options: Option[] }
  | { kind: "none"; options: Option[] };

const MAX_OPTIONS = 6;

/** "N1000 1.5GB - 30 days" → "1.5gb 30 days" style tokens, without the price. */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/n[\d,]+(\.\d+)?/g, " ") // N1,850
    .replace(/(\d+(?:\.\d+)?)\s*(gb|mb|tb)/g, "$1$2")
    .replace(/(\d+)\s*(day|days|hrs|hr|hours|month|months|year)/g, "$1$2")
    .replace(/[^a-z0-9. ]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^(\d+)(days?|hrs?|hours)$/, "$1d").replace(/\.$/, ""))
    .filter(
      (t) => t && !["dstv", "gotv", "data", "bundle", "naira", "the", "plan", "one"].includes(t),
    );
}

export function pickVariation(
  options: Option[],
  query: string | null,
  amountNgnKobo: number | null,
): Pick {
  let pool = options;
  // Price first: "the 2k one". Within ₦1 so ₦1,999 still matches "2k".
  if (amountNgnKobo !== null) {
    const priced = pool.filter((o) => Math.abs(o.amountNgnKobo - amountNgnKobo) <= 100);
    if (priced.length > 0) pool = priced;
    else if (!query) return { kind: "none", options: nearest(options, amountNgnKobo) };
  }
  if (query) {
    const want = tokens(query);
    if (want.length > 0) {
      const scored = pool
        .map((o) => {
          const have = tokens(o.name);
          return { o, ok: want.every((w) => have.includes(w)), extra: have.length - want.length };
        })
        .filter((x) => x.ok);
      if (scored.length === 0) {
        return {
          kind: "none",
          options: amountNgnKobo ? nearest(options, amountNgnKobo) : cheapest(pool),
        };
      }
      // "compact" means Compact, not Compact Plus: fewest extra words wins, if alone.
      const best = Math.min(...scored.map((x) => x.extra));
      const top = scored.filter((x) => x.extra === best);
      if (top.length === 1 && top[0]) return { kind: "one", option: top[0].o };
      pool = scored.map((x) => x.o);
    }
  }
  if (pool.length === 1 && pool[0] && (query || amountNgnKobo !== null)) {
    return { kind: "one", option: pool[0] };
  }
  return { kind: "choose", options: cheapest(pool) };
}

function cheapest(list: Option[]): Option[] {
  return [...list].sort((a, b) => a.amountNgnKobo - b.amountNgnKobo).slice(0, MAX_OPTIONS);
}

function nearest(list: Option[], kobo: number): Option[] {
  return [...list]
    .sort((a, b) => Math.abs(a.amountNgnKobo - kobo) - Math.abs(b.amountNgnKobo - kobo))
    .slice(0, MAX_OPTIONS)
    .sort((a, b) => a.amountNgnKobo - b.amountNgnKobo);
}

/** Combo products VTpass sells under data that fail with plain requests (011). */
export function isPlainDataBundle(name: string, code: string): boolean {
  return !/xtra|talk|social|binge|router|hynetflex|broadband/i.test(`${name} ${code}`);
}
