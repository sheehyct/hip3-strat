// Number formatting. fmtPx is the dashboard's own, vendored; the rest mirror
// dashboard call sites that live outside the DISPLAY-CORE block.

// Vendored, not re-implemented: the hand-written copy that used to sit here was
// missing the >= 10000 branch, so BTC and XYZ100 carried one more decimal on the
// phone than on the dashboard (divergence matrix (e)6).
export { fmtPx } from "./display_core";

export function fmtUsd(x: number | null | undefined): string {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  return x.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

export function fmtVol(x: number): string {
  if (!isFinite(x)) return "-";
  if (x >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
  if (x >= 1e6) return "$" + (x / 1e6).toFixed(1) + "M";
  if (x >= 1e3) return "$" + (x / 1e3).toFixed(0) + "K";
  return "$" + x.toFixed(0);
}

// Signed percent for momentum, per-TF change and premium. The dashboard signs
// these with `> 0`, so a flat reading renders "0.00%" with no plus - matched
// deliberately at :1429 (momentum column), :1666 (detail tape), :1671 (premium).
export function fmtPct(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  return (x > 0 ? "+" : "") + x.toFixed(digits) + "%";
}

// 24h change ONLY. The dashboard signs this one with `>= 0` (:1550 Simple view,
// :1909 grid), so a flat coin reads "+0.00%" there and used to read "0.00%"
// here (divergence matrix (e)7) - while both surfaces already coloured 0 as
// bullish green, so mobile's own text and colour disagreed with each other.
// Separate from fmtPct on purpose: signing momentum this way would ADD a
// divergence rather than remove one.
export function fmtChg24(x: number | null | undefined): string {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  return (x >= 0 ? "+" : "") + x.toFixed(2) + "%";
}

export function fmtSigned(x: number | null | undefined): string {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  return (x > 0 ? "+" : "") + String(x);
}
