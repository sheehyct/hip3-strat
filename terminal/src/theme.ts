// Design tokens: blue-gray surfaces, a structural blue accent, Inter.
// Dark-only by design (trading surface).
//
// Color conveys information, never decoration:
//   bull  emerald = bullish / 2U        bear  crimson = bearish / 2D
//   warn  amber   = outside bar / 3     neutral gray  = inside bar / 1
//   info  blue    = informational market data (e.g. "your entry" lines)
//   accent        = STRUCTURE ONLY: selected tab, focused control, primary
//                   button. Never a market meaning - which is also why the
//                   tab bar no longer borrows bullish green.
//
// Keys are stable: every screen reads C, so changing a value here repaints
// the whole app.
//
// Contrast (WCAG, measured 2026-11-01): text 16.3, muted 6.4, faint 5.1 on
// card; faint 4.7 on raised. An earlier faint (#6f7b8d) measured
// 4.15 on card, so it was lifted to pass AA small text on every surface.
export const C = {
  bg: "#0b0e12",
  card: "#14181e",
  cardActive: "#1b2028", // pressed state; same value as raised
  raised: "#1b2028",     // sheets, popovers, a card inside a card
  border: "#282e38",
  borderStrong: "#343c48",
  input: "#343c48",
  text: "#f3f5f8",
  muted: "#929cab",
  faint: "#7f8a9b",
  accent: "#6489ff",
  accentBg: "#192744",
  accentBorder: "#536dba",
  accentText: "#b7c9ff",
  bull: "#00DC82",
  bear: "#FF3B5C",
  warn: "#FFB800",
  info: "#3B82F6",
  neutral: "#A3ACB9",
  bullBg: "rgba(0,220,130,0.12)",
  bearBg: "rgba(255,59,92,0.12)",
  warnBg: "rgba(255,184,0,0.12)",
  infoBg: "rgba(59,130,246,0.12)",
  neutralBg: "rgba(163,172,185,0.12)",
} as const;

// Inter, loaded once in src/app/_layout.tsx (useFonts). On Android a custom
// font needs ONE FILE PER WEIGHT selected by fontFamily - fontWeight does not
// pick a weight from a loaded family and can fall back to synthetic bold.
// So: spread F.medium / F.semibold / F.bold into a style INSTEAD of setting
// fontWeight. Never combine the two.
export const F = {
  regular: { fontFamily: "Inter_400Regular" },
  medium: { fontFamily: "Inter_500Medium" },
  semibold: { fontFamily: "Inter_600SemiBold" },
  bold: { fontFamily: "Inter_700Bold" },
} as const;

// Type scale. The floor is 10.5: at a large system font scale Android CUTS
// text that overflows its box, and 7-9px sizes do not survive that.
export const T = {
  micro: 10.5,   // dim sub-labels, axis-like captions
  caption: 11.5, // secondary values
  body: 13,
  bodyL: 14,
  title: 15,     // card symbol
  h2: 17,        // section heading
  h1: 24,        // screen title
  hero: 32,      // account equity
} as const;

// Spacing and shape (the gutter is 16 for a phone-width column).
export const S = {
  gutter: 16,
  cardPad: 14,
  gap: 8,
  radius: 13,
  radiusMd: 9,
  radiusSm: 7,
  hit: 44, // minimum touch target
} as const;

// Bar-type -> accent mapping.
export function barColor(t: string | null): { fg: string; bg: string } {
  if (t === "2U") return { fg: C.bull, bg: C.bullBg };
  if (t === "2D") return { fg: C.bear, bg: C.bearBg };
  if (t === "3") return { fg: C.warn, bg: C.warnBg };
  if (t === "1") return { fg: C.neutral, bg: C.neutralBg };
  return { fg: C.faint, bg: "transparent" };
}
