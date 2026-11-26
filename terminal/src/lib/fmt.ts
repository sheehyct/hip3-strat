// Number and time formatting for the screens. Times display in
// America/New_York.
import { decimalsFor } from "./candles";

const ET = "America/New_York";
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = JSON.stringify(opts);
  let f = fmtCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: ET }); fmtCache.set(k, f); }
  return f;
}

export function fmtTimeET(ms: number): string {
  return dtf({ hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}
export function fmtDateTimeET(ms: number): string {
  return dtf({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

export function fmtPx(p: number | null | undefined, d?: number): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "-";
  const dec = d ?? decimalsFor(Math.abs(p));
  return p.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function fmtUsd(x: number | null | undefined, signed = false): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  const a = Math.abs(x);
  const body = a >= 1000 ? a.toLocaleString("en-US", { maximumFractionDigits: 0 }) : a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = x < 0 ? "-" : signed && x > 0 ? "+" : "";
  return sign + "$" + body;
}

export function fmtPct(x: number | null | undefined, signed = true, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  return (x > 0 && signed ? "+" : "") + x.toFixed(digits) + "%";
}

export function fmtSize(x: number | null | undefined, szDecimals: number | null = null): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  if (szDecimals !== null) return x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: szDecimals });
  return x.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

// Compact: 1.2k, 3.4M
export function fmtCompact(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "-";
  const a = Math.abs(x);
  const s = a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? (a / 1e3).toFixed(1) + "k" : a.toFixed(0);
  return (x < 0 ? "-" : "") + s;
}

export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return "now";
  if (ms < 60000) return Math.floor(ms / 1000) + "s";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m";
  return Math.floor(ms / 3600000) + "h";
}
