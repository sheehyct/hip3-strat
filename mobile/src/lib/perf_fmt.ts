// Formatting for the Performance and Trades views. Money reuses fmtUsd; the
// signed variant prints a leading "+" on gains (a trade result is a signed
// quantity, unlike an account value). Times print in America/New_York to
// match the hour/weekday buckets, through Intl with a UTC fallback.
import { fmtUsd } from "./fmt";

export function fmtUsdSigned(x: number | null | undefined): string {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  return (x > 0 ? "+" : "") + fmtUsd(x);
}

// Compact money for chart labels and small cells: "$9.6k", "-$1.2M".
export function fmtUsdShort(x: number): string {
  const a = Math.abs(x), sign = x < 0 ? "-" : "";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(1) + "k";
  return sign + "$" + a.toFixed(0);
}

// Hold time: "48m", "2h 14m", "1d 6h".
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !isFinite(ms)) return "-";
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

// Sizes are sums of decimal strings; strip float noise before printing.
export function fmtSize(x: number): string {
  if (!isFinite(x)) return "-";
  return String(parseFloat(x.toPrecision(8)));
}

const NY = "America/New_York";
function fmtWith(opts: Intl.DateTimeFormatOptions, t: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: NY, ...opts }).format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(0, 16).replace("T", " ") + "Z";
  }
}

// "Sep 1 09:41" (ET, 24 h clock).
export function fmtDateTimeET(t: number): string {
  return fmtWith({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, t).replace(",", "");
}

// "09:41".
export function fmtTimeET(t: number): string {
  return fmtWith({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, t);
}

// "Sep 1".
export function fmtDateET(t: number): string {
  return fmtWith({ month: "short", day: "numeric" }, t);
}

// "Mar 1, 2027".
export function fmtDateLongET(t: number): string {
  return fmtWith({ month: "short", day: "numeric", year: "numeric" }, t);
}
