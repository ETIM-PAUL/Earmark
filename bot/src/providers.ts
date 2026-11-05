import type { Category } from "@earmark/shared";

/**
 * Words people use for billers, mapped to VTpass serviceIDs in code. The
 * model only passes along what the person said ("ikedc", "9mobile"); this
 * file decides which biller that is, and nothing outside the list can be
 * reached.
 */

const DISCOS: [string, string[]][] = [
  ["ikeja-electric", ["ikeja", "ikedc", "ie"]],
  ["eko-electric", ["eko", "ekedc", "ekedp"]],
  ["abuja-electric", ["abuja", "aedc"]],
  ["kano-electric", ["kano", "kedco"]],
  ["portharcourt-electric", ["port harcourt", "portharcourt", "phed", "ph"]],
  ["jos-electric", ["jos", "jed", "jedc"]],
  ["kaduna-electric", ["kaduna", "kaedco"]],
  ["enugu-electric", ["enugu", "eedc"]],
  ["ibadan-electric", ["ibadan", "ibedc"]],
  ["benin-electric", ["benin", "bedc"]],
  ["aba-electric", ["aba", "apl"]],
  ["yola-electric", ["yola", "yedc"]],
];

const NETWORKS: [string, string[]][] = [
  ["mtn", ["mtn"]],
  ["airtel", ["airtel"]],
  ["glo", ["glo", "globacom"]],
  ["etisalat", ["9mobile", "etisalat", "9 mobile", "nine mobile"]],
];

const TV: [string, string[]][] = [
  ["dstv", ["dstv", "ds tv"]],
  ["gotv", ["gotv", "go tv"]],
  ["startimes", ["startimes", "star times", "startime"]],
  ["showmax", ["showmax"]],
];

export const LABELS: Record<string, string> = {
  "ikeja-electric": "Ikeja Electric",
  "eko-electric": "Eko Electric",
  "abuja-electric": "Abuja Electric",
  "kano-electric": "Kano Electric",
  "portharcourt-electric": "Port Harcourt Electric",
  "jos-electric": "Jos Electric",
  "kaduna-electric": "Kaduna Electric",
  "enugu-electric": "Enugu Electric",
  "ibadan-electric": "Ibadan Electric",
  "benin-electric": "Benin Electric",
  "aba-electric": "Aba Power",
  "yola-electric": "Yola Electric",
  mtn: "MTN",
  airtel: "Airtel",
  glo: "Glo",
  etisalat: "9mobile",
  "mtn-data": "MTN data",
  "airtel-data": "Airtel data",
  "glo-data": "Glo data",
  "etisalat-data": "9mobile data",
  dstv: "DStv",
  gotv: "GOtv",
  startimes: "StarTimes",
  showmax: "Showmax",
};

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function match(table: [string, string[]][], said: string): string | null {
  const s = clean(said);
  if (!s) return null;
  const words = ` ${s} `;
  for (const [id, aliases] of table) {
    if (aliases.some((a) => words.includes(` ${a} `)) || s === id) return id;
  }
  // "ikeja electric", "eko disco": the first word is enough.
  for (const [id, aliases] of table) {
    if (aliases.some((a) => a.length > 2 && s.startsWith(a))) return id;
  }
  return null;
}

/** The VTpass serviceID for what the person called the biller, or null. */
export function resolveBiller(category: Category, said: string | null): string | null {
  if (!said) return null;
  switch (category) {
    case "electricity":
      return match(DISCOS, said);
    case "airtime":
      return match(NETWORKS, said);
    case "data": {
      const n = match(NETWORKS, said.replace(/-?data/i, ""));
      return n ? `${n}-data` : null;
    }
    case "tv":
      return match(TV, said);
  }
}

/**
 * Network by number prefix. Ported numbers break this, so it is only a
 * guess: the summary names the network and the person confirms it.
 */
const PREFIXES: Record<string, string[]> = {
  mtn: [
    "0803",
    "0806",
    "0703",
    "0706",
    "0704",
    "0813",
    "0816",
    "0810",
    "0814",
    "0903",
    "0906",
    "0913",
    "0916",
    "07025",
    "07026",
  ],
  airtel: ["0802", "0808", "0708", "0812", "0701", "0902", "0901", "0904", "0907", "0912", "0911"],
  glo: ["0805", "0807", "0705", "0815", "0811", "0905", "0915"],
  etisalat: ["0809", "0818", "0817", "0909", "0908"],
};

export function networkFromPhone(phone: string): string | null {
  // Longest prefix first, so 07025 beats 0702.
  let best: [string, number] | null = null;
  for (const [net, list] of Object.entries(PREFIXES)) {
    for (const p of list) {
      if (phone.startsWith(p) && (!best || p.length > best[1])) best = [net, p.length];
    }
  }
  // The VTpass sandbox test number.
  if (!best && phone === "08011111111") return "mtn";
  return best?.[0] ?? null;
}

/** Local 0XXXXXXXXXX form, or null if it isn't a Nigerian mobile number. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("234")) d = `0${d.slice(3)}`;
  if (d.length === 10 && /^[789]/.test(d)) d = `0${d}`;
  return /^0[789][01]\d{8}$/.test(d) ? d : null;
}

/** Meter numbers are 11 to 13 digits; smartcards 10 or 11. */
export function normalizeAccount(category: "electricity" | "tv", raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  if (category === "electricity") return /^\d{11,13}$/.test(d) ? d : null;
  return /^\d{10,11}$/.test(d) ? d : null;
}

/** "0801 *** 1111": enough to recognise, not enough to copy. */
export function maskRef(ref: string): string {
  return ref.length <= 6 ? ref : `${ref.slice(0, 4)}…${ref.slice(-4)}`;
}
