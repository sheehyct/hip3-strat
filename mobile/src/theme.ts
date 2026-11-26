// shadcn-zinc dark tokens, matched to the HIP-3 STRAT screener dashboard.
// Dark-only by design (trading surface). Color conveys information, never
// decoration: emerald = bullish/2U, crimson = bearish/2D, amber = outside/3,
// zinc = inside/neutral, blue = informational.
export const C = {
  bg: "#09090b",
  card: "#18181b",
  cardActive: "#1f1f23",
  border: "rgba(255,255,255,0.10)",
  input: "rgba(255,255,255,0.15)",
  text: "#fafafa",
  muted: "#a1a1aa",
  faint: "#71717a",
  bull: "#00DC82",
  bear: "#FF3B5C",
  warn: "#FFB800",
  info: "#3B82F6",
  neutral: "#A1A1AA",
  bullBg: "rgba(0,220,130,0.12)",
  bearBg: "rgba(255,59,92,0.12)",
  warnBg: "rgba(255,184,0,0.12)",
  infoBg: "rgba(59,130,246,0.12)",
  neutralBg: "rgba(161,161,170,0.12)",
} as const;

// Bar-type -> accent mapping (same as the dashboard's .bt-* classes).
export function barColor(t: string | null): { fg: string; bg: string } {
  if (t === "2U") return { fg: C.bull, bg: C.bullBg };
  if (t === "2D") return { fg: C.bear, bg: C.bearBg };
  if (t === "3") return { fg: C.warn, bg: C.warnBg };
  if (t === "1") return { fg: C.neutral, bg: C.neutralBg };
  return { fg: C.faint, bg: "transparent" };
}
