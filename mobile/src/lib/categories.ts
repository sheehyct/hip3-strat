// Category grouping for main-dex ("perps") coins.
// The worker's /api/state serves a per-coin `cat` field (extracted from the
// dashboard's PERP_CAT map - the single source of truth), so coinCategory()
// reads it directly. The local fallback copy was removed once the worker deploy
// with `cat` went live (2026-07-09); to change categories, edit the PERP_CAT
// block in the scanner's hip3_strat_screener.html (never here). Display
// grouping only - no STRAT detection (project contract).

// Category chip row for the perps universe. `id` matches the PERP_CAT values
// (lowercase); "all" is the no-filter sentinel and "other" catches unmapped.
export const PERP_CATEGORIES = [
  { id: "all", label: "All" },
  { id: "majors", label: "Majors" },
  { id: "l1", label: "L1" },
  { id: "l2", label: "L2" },
  { id: "defi", label: "DeFi" },
  { id: "ai", label: "AI" },
  { id: "meme", label: "Meme" },
  { id: "gaming", label: "Gaming" },
  { id: "other", label: "Other" },
] as const;

export type CategoryId = (typeof PERP_CATEGORIES)[number]["id"];

// Category for a coin: the worker-served `cat` (single-source payload field
// derived from the dashboard's PERP_CAT map). Null/absent = other.
export function coinCategory(coin: { cat?: string | null }): string {
  return coin.cat ?? "other";
}
