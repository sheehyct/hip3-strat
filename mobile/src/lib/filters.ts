// Composable screener filters - the dashboard's Tier 1 filter model
// (hip3_strat_screener.html: defaultFilters, sanitizeFilters, applyPreset,
// parseVolAmount, volPasses, sigStage, sigDimsActive, matchedItems' item test,
// the row filter chain in its render, syncChipBadges' count) re-expressed
// natively, one function per dashboard function. Design decision: the
// per-timeframe scan view is retired and the Command list takes the
// dashboard's collapsible Filters / Patterns panels instead.
//
// PURE and IMPORT-FREE on purpose, like trades.ts: `node --test test/` loads
// this file straight from source through Node's type stripping, so it must
// stay erasable-syntax only and must not import react-native, expo, storage
// or extensionless modules. Callers pass in the facts that need the vendored
// predicates (sigInForce, magProgress, patFamily) - see focus.ts matchedItems.
//
// Display aggregation only: every input is a served field or the vendored
// DISPLAY-CORE math. Nothing here classifies a bar or detects a pattern.

export type UniKey = "xyz" | "perps";

// The dashboard's STAGE_IDS, in its button order. Every stage is derived ONLY
// from the canonical predicates (see sigStage), never new per-signal state.
export const STAGES = [
  { id: "setup", label: "Setup" },
  { id: "live", label: "Live" },
  { id: "recrossed", label: "Recrossed" },
  { id: "target", label: "Target" },
  { id: "inval", label: "Inval" },
  { id: "cont", label: "Cont" },
] as const;
export type StageId = (typeof STAGES)[number]["id"];
const STAGE_IDS: readonly string[] = STAGES.map((s) => s.id);

// SIGTF_LABELS: a signal's TF is matched by its LABEL, as FocusItem.tf
// carries it (TF_ORDER labels in api.ts).
export const SIGTF_LABELS = ["15m", "30m", "1H", "4H", "D", "W", "M"] as const;

// 24h volume bound: PER UNIVERSE, because one floor that
// clears crypto noise would empty the equity board. n null = off; the
// operator is remembered even while off. Listed in the dashboard's select
// order reversed, so the default (>=) leads.
export const VOL_OPS = [
  { id: "ge", label: ">=" },
  { id: "gt", label: ">" },
  { id: "le", label: "<=" },
  { id: "lt", label: "<" },
] as const;
export type VolOp = (typeof VOL_OPS)[number]["id"];
const VOL_OP_IDS: readonly string[] = VOL_OPS.map((o) => o.id);
export type VolDim = { op: VolOp; n: number | null };

export type Filters = {
  favs: boolean;
  inside: boolean;
  movers: boolean;
  ftfc: "up" | "down" | null;
  dir: "up" | "down" | null;
  stages: StageId[];
  tfs: string[];
  pats: string[];
  levMin: number | null;
  pxMax: number | null;
  vol: Record<UniKey, VolDim>;
};

const UNI_KEYS: UniKey[] = ["xyz", "perps"];

export function defaultFilters(): Filters {
  return {
    favs: false, inside: false, movers: false, ftfc: null, dir: null,
    stages: [], tfs: [], pats: [], levMin: null, pxMax: null,
    vol: { xyz: { op: "ge", n: null }, perps: { op: "ge", n: null } },
  };
}

// Whitelist-validated load: junk in storage degrades per field to the
// default - never a throw, never a half-shaped object. Sets are whitelisted
// AND deduplicated (a duplicated value once made a
// tap appear to do nothing). The pattern ids are passed in so this module
// stays import-free (patterns.ts owns PATTERN_FAMILY_IDS).
export function sanitizeFilters(raw: unknown, patIds: readonly string[]): Filters {
  const d = defaultFilters();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  d.favs = o.favs === true;
  d.inside = o.inside === true;
  d.movers = o.movers === true;
  if (o.ftfc === "up" || o.ftfc === "down") d.ftfc = o.ftfc;
  if (o.dir === "up" || o.dir === "down") d.dir = o.dir;
  const setOf = (arr: unknown, allowed: readonly string[]): string[] =>
    Array.isArray(arr)
      ? arr.filter((v, i) => typeof v === "string" && allowed.indexOf(v) >= 0 && arr.indexOf(v) === i)
      : [];
  d.stages = setOf(o.stages, STAGE_IDS) as StageId[];
  d.tfs = setOf(o.tfs, SIGTF_LABELS);
  d.pats = setOf(o.pats, patIds);
  if (typeof o.levMin === "number" && Number.isFinite(o.levMin) && o.levMin > 0) d.levMin = o.levMin;
  if (typeof o.pxMax === "number" && Number.isFinite(o.pxMax) && o.pxMax > 0) d.pxMax = o.pxMax;
  // Zero is a legal volume bound: "> 0" is how you hide coins with no trades.
  if (o.vol && typeof o.vol === "object") {
    const v = o.vol as Record<string, unknown>;
    for (const u of UNI_KEYS) {
      const s = v[u] as Record<string, unknown> | undefined;
      if (!s || typeof s !== "object") continue;
      if (typeof s.op === "string" && VOL_OP_IDS.indexOf(s.op) >= 0) d.vol[u].op = s.op as VolOp;
      if (typeof s.n === "number" && Number.isFinite(s.n) && s.n >= 0) d.vol[u].n = s.n;
    }
  }
  return d;
}

// Presets are ACTIONS that configure the dimensions, not extra state. "all"
// clears everything; "actionable" = signals actually in force NOW - stage
// "live" excludes recrossed, target-passed, invalidated and continuations by
// construction.
export function applyPreset(p: "all" | "actionable"): Filters {
  const f = defaultFilters();
  if (p === "actionable") f.stages = ["live"];
  return f;
}

// Amount entry: plain digits ("5000000") or a k/m/b suffix ("500k", "1m").
// Anything else - "$", commas, junk - is null, and the caller treats that as
// "no bound" (flagged on the input) rather than guessing what was meant.
export function parseVolAmount(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/.exec(String(s).trim().toLowerCase());
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1);
  return Number.isFinite(n) ? n : null;
}

export function volPasses(op: VolOp, v: number, n: number): boolean {
  return op === "lt" ? v < n : op === "le" ? v <= n : op === "gt" ? v > n : v >= n;
}

// The Lev / Px inputs: a positive finite number, else off.
export function parsePositive(s: string): number | null {
  const v = parseFloat(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// The signal dimensions - the ones that thread through the matched-signal
// Focus. Any of them active also drops coins with no matching signal (the
// dashboard's rule).
export function sigDimsActive(f: Filters): boolean {
  return !!(f.dir || f.stages.length || f.tfs.length || f.pats.length);
}

// sigStage: lifecycle stage of a Focus item from the canonical predicates
// only. `inForce` and `mag` are consulted for a "live"-status item alone, so
// callers may pass placeholders for the others. "target" and "recrossed" are
// instantaneous and can revert within the bar, by design.
export function sigStage(status: string, inForce: boolean, mag: number | null): StageId {
  if (status === "inval") return "inval";
  if (status === "setup") return "setup";
  if (status === "cont") return "cont";
  if (!inForce) return "recrossed";
  return mag !== null && mag >= 100 ? "target" : "live";
}

// The item half of matchedItems: does one Focus item pass every active signal
// dimension? `family` is patFamily(sig.name), `stage` is sigStage's answer.
export type ItemFacts = { tf: string; dir: string; family: string; stage: StageId };
export function itemMatches(f: Filters, it: ItemFacts): boolean {
  if (f.dir && it.dir !== f.dir) return false;
  if (f.tfs.length && f.tfs.indexOf(it.tf) < 0) return false;
  if (f.pats.length && f.pats.indexOf(it.family) < 0) return false;
  if (f.stages.length && f.stages.indexOf(it.stage) < 0) return false;
  return true;
}

// The coin-level dimensions of the dashboard's row chain, in its order.
// `px` is the dashboard's row price (mid, else mark, else 0); `vol` is the
// served rolling 24h notional. Unknown leverage and unknown volume NEVER
// match a bound - an honest absence must not pass a screen on fabricated
// evidence. Category and search stay with the caller, as they do on the
// dashboard (they are not filter-state dimensions).
export type RowFacts = {
  fav: boolean;
  inside: boolean;
  ftfc: string | null;
  maxLeverage: number | null | undefined;
  px: number;
  vol: number;
  rvol: number | null;
  r5: number | null;
  r15: number | null;
};
export function rowPasses(f: Filters, uni: UniKey, r: RowFacts): boolean {
  if (f.favs && !r.fav) return false;
  if (f.inside && !r.inside) return false;
  if (f.ftfc && r.ftfc !== f.ftfc) return false;
  if (f.levMin !== null && !(typeof r.maxLeverage === "number" && r.maxLeverage >= f.levMin)) return false;
  if (f.pxMax !== null && !(r.px > 0 && r.px <= f.pxMax)) return false;
  const vd = f.vol[uni];
  if (vd && vd.n !== null && !(Number.isFinite(r.vol) && volPasses(vd.op, r.vol, vd.n))) return false;
  if (f.movers && !(
    (r.rvol !== null && r.rvol >= 2) ||
    (r.r5 !== null && Math.abs(r.r5) >= 0.4) ||
    (r.r15 !== null && Math.abs(r.r15) >= 0.8)
  )) return false;
  return true;
}

// syncChipBadges: the Filters count spans every dimension its panel holds,
// category included; a volume bound counts only for the universe on screen.
// Patterns carries its own count (f.pats.length).
export function filterCount(f: Filters, uni: UniKey, categoryActive: boolean): number {
  return (f.favs ? 1 : 0) + (f.inside ? 1 : 0) + (f.movers ? 1 : 0) + (f.ftfc ? 1 : 0) +
    (f.dir ? 1 : 0) + f.stages.length + f.tfs.length +
    (f.levMin !== null ? 1 : 0) + (f.pxMax !== null ? 1 : 0) +
    (f.vol[uni] && f.vol[uni].n !== null ? 1 : 0) + (categoryActive ? 1 : 0);
}

// toggleInList, returning a new array (React state is never mutated).
export function toggleIn<T>(list: readonly T[], v: T): T[] {
  return list.indexOf(v) >= 0 ? list.filter((x) => x !== v) : [...list, v];
}

// Compact amount: 5000000 -> "5m". Display only - see volText.
export function fmtAmount(n: number): string {
  const unit = n >= 1e9 ? [1e9, "b"] : n >= 1e6 ? [1e6, "m"] : n >= 1e3 ? [1e3, "k"] : [1, ""];
  const v = n / (unit[0] as number);
  return (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)) + unit[1];
}

// A volume bound as text: the compact form only when it parses back to the
// SAME number, else the plain digits (the dashboard shows String(n)). A
// rounded "12.35k" for 12345 would change the bound the moment it is edited.
export function volText(n: number): string {
  const t = fmtAmount(n);
  return parseVolAmount(t) === n ? t : String(n);
}
