// Pattern-family grouping over STRAT-CORE signal names - the dashboard's
// patFamily, copied VERBATIM from the dashboard source (its pattern filter
// dimension). This is UI grouping over the canonical taxonomy served by the
// worker, NOT detection, and it deliberately lives outside the vendored
// DISPLAY-CORE block: sigChips carries only the mechanics (the allow
// predicate) while which patterns a user trades is UI state. Do not
// re-derive the mapping - copy it from the dashboard.

export const PATTERN_FAMILIES = [
  { id: "22", label: "2-2" },
  { id: "212", label: "2-1-2" },
  { id: "312", label: "3-1-2" },
  { id: "32", label: "3-2" },
  { id: "322", label: "3-2-2" },
  { id: "122", label: "1-2-2" },
  { id: "13", label: "1-3" },
  { id: "pmg", label: "PMG" },
] as const;

export type PatternFamilyId = (typeof PATTERN_FAMILIES)[number]["id"];

export const PATTERN_FAMILY_IDS: readonly string[] = PATTERN_FAMILIES.map((f) => f.id);

// Verbatim port of the dashboard's patFamily (hip3_strat_screener.html).
export function patFamily(name: string): string {
  if (name === "PMG") return "pmg";
  if (name === "1-3") return "13";
  if (name === "1-2-2") return "122";
  // X-1-2 group: the prefix decides. 3-1-2 keeps its own family (color-routed
  // rev/cont); 2U/2D prefixes are the 2-1-2 class. 1-1-2 / ?-1-2 are
  // info-kind structures that never render as chips; family is harmless.
  if (name.indexOf("-1-2") > 0) return name.charAt(0) === "3" ? "312" : "212";
  if (name === "3-2U" || name === "3-2D") return "32";
  if (name === "2D-2U" || name === "2U-2D") return "22";
  if (name === "3-2D-2U" || name === "3-2U-2D") return "322";
  return "other";
}

// The one place the allowlist's "empty = every pattern" rule lives (the
// dashboard guards every consumer with `f.pats.length &&` - centralizing it
// here keeps mobile's three call sites from restating it).
export function famAllowed(allowed: readonly string[], name: string): boolean {
  return allowed.length === 0 || allowed.indexOf(patFamily(name)) >= 0;
}
