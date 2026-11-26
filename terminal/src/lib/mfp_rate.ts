// MyFundedPerps counts REST GETs per API key (their notice of 2026-11-25:
// 60 a minute on a live key, 30 on a sandbox key; writes are not counted).
// This module is the app's own count of what it sent, per key, and what it
// does about it. PURE and import-free: node --test loads it from source.
//
// - Every GET that goes out is noted (noteGet) against a BUCKET: a short
//   hash of the key. The key itself is never kept here.
// - A 429 puts the bucket on HOLD until the venue's Retry-After has passed
//   (noteLimited). A hold stops every read that is not on the trade path.
// - Reads come in three classes:
//     "background"  the timer's polls, history, the ledger's lookups. Sent
//                   only under the soft cap and outside a hold.
//     "settle"      a read of the book (positions + working orders) while
//                   a write is unsettled: the re-read right after it, and
//                   the timer's book reads until it settles. Sent under a
//                   higher cap (it is what confirms the write, and the
//                   lookups and the account must not crowd it out of a
//                   tight minute) and outside a hold.
//     trade path    the reads a write itself needs (the pre-trade re-read
//                   of a position, the price, the order lookup). Never asked
//                   here: they are always sent, even inside a hold, because
//                   an exit must always be attempted. They are still counted.
//                   A 429 on one does not push a running hold out.
//   The caps leave the trade path room under the venue's limit.
// - The window is a rolling 60 s. The venue does not say whether its own is
//   fixed or rolling; a rolling count is the stricter reading.
//
// Also here: the last X-RateLimit-Warning the venue sent (during its grace
// period an over-limit GET succeeds and carries that header) and the last
// hold, for the status bar. Neither holds a key.

export type RateEnv = "live" | "sandbox";
export type RateClass = "background" | "settle";

export const RATE_WINDOW_MS = 60_000;
// The venue's limits, GETs a minute per key.
export const RATE_LIMIT: Readonly<Record<RateEnv, number>> = Object.freeze({ live: 60, sandbox: 30 });
// What each class may fill the window to. The rest is the trade path's.
export const RATE_CAP: Readonly<Record<RateClass, Readonly<Record<RateEnv, number>>>> = Object.freeze({
  background: Object.freeze({ live: 40, sandbox: 20 }),
  settle: Object.freeze({ live: 54, sandbox: 26 }),
});
// A 429 with no usable Retry-After: the venue documents 60 s.
export const DEFAULT_HOLD_MS = 60_000;
const MIN_HOLD_MS = 1_000;
const MAX_HOLD_MS = 5 * 60_000;
// How long a warning stays on the status bar.
export const WARNING_SHOWN_MS = 5 * 60_000;

type Bucket = { sent: number[]; hold: number };
const buckets = new Map<string, Bucket>();

// A short, non-secret name for a key: 14 hex characters of a 53-bit hash.
// It cannot be turned back into the key and is only ever compared.
export function rateBucket(key: string): string {
  let a = 0xdeadbeef ^ key.length, b = 0x41c6ce57 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & b) + (a >>> 0);
  return n.toString(16).padStart(14, "0");
}

function bucketOf(name: string): Bucket {
  let b = buckets.get(name);
  if (!b) { b = { sent: [], hold: 0 }; buckets.set(name, b); }
  return b;
}

// Drop what has left the window. A clock that stepped BACKWARDS must not
// leave the count or a hold stuck in the future (that would starve every
// background read until the old time came round again): a GET stamped after
// `now` is dropped, and a hold is never longer than MAX_HOLD_MS from now.
function prune(b: Bucket, now: number): void {
  const from = now - RATE_WINDOW_MS;
  let drop = 0;
  while (drop < b.sent.length && b.sent[drop] <= from) drop++;
  if (drop) b.sent.splice(0, drop);
  while (b.sent.length && b.sent[b.sent.length - 1] > now) b.sent.pop();
  if (b.hold - now > MAX_HOLD_MS) b.hold = now + MAX_HOLD_MS;
}

// One GET is about to go out on this key.
export function noteGet(bucket: string, now: number): void {
  const b = bucketOf(bucket);
  prune(b, now);
  b.sent.push(now);
}

// GETs sent on this key in the last 60 s.
export function used(bucket: string, now: number): number {
  const b = bucketOf(bucket);
  prune(b, now);
  return b.sent.length;
}

// When this key's hold ends (epoch ms); 0 = no hold was ever set. With
// `now`, a hold left in the far future by a clock change is cut back first.
export function holdUntil(bucket: string, now?: number): number {
  const b = bucketOf(bucket);
  if (now !== undefined) prune(b, now);
  return b.hold;
}

// The venue answered 429 to a GET on this key. retryAfterMs: its
// Retry-After (null = none readable). A hold is never shortened.
//
// extend = false: the 429 answered a TRADE-PATH read. Those are sent even
// inside a hold (an exit is always attempted), so a 429 on one is expected
// there and says nothing new: it does not push the hold out. Otherwise each
// attempt to close during a hold would keep the display's reads away for
// another Retry-After. When NO hold is running it sets one like any 429.
export function noteLimited(bucket: string, retryAfterMs: number | null, now: number, scope: string | null = null, limit: string | null = null, extend = true): void {
  const b = bucketOf(bucket);
  prune(b, now);
  const ms = retryAfterMs !== null && Number.isFinite(retryAfterMs) ? Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, retryAfterMs)) : DEFAULT_HOLD_MS;
  if (extend || b.hold <= now) b.hold = Math.max(b.hold, now + ms);
  const n = limit !== null ? Number(limit) : NaN;
  setNotice({ ...notice, heldUntil: b.hold, scope: clean(scope, 24), limit: Number.isFinite(n) && n > 0 ? n : null });
}

// How long a read of `cost` GETs in this class must wait before it may be
// sent (0 = send it now). Never asked for the trade path.
export function rateWaitMs(bucket: string, env: RateEnv, now: number, cost: number, cls: RateClass = "background"): number {
  return waitUnder(bucketOf(bucket), RATE_CAP[cls][env], now, cost);
}

// The same question for a SEQUENCE on the trade path, asked before it
// starts, against the venue's own limit: would `cost` more GETs still fit
// in this minute, and is the key free of a hold? (0 = yes.) Trade-path
// reads are never held back one by one - an exit is always attempted - but
// a sequence that must not stop half way (a reverse: closed, not yet
// reopened) is refused up front when the venue would cut it short.
export function tradeWaitMs(bucket: string, env: RateEnv, now: number, cost: number): number {
  return waitUnder(bucketOf(bucket), RATE_LIMIT[env], now, cost);
}

function waitUnder(b: Bucket, cap: number, now: number, cost: number): number {
  prune(b, now);
  if (b.hold > now) return b.hold - now;
  const over = b.sent.length + Math.max(1, cost) - cap;
  if (over <= 0) return 0;
  // The `over`-th oldest GET has to leave the window first. A cost larger
  // than the cap itself can never fit: wait a whole window.
  if (over > b.sent.length) return RATE_WINDOW_MS;
  return Math.max(1, b.sent[over - 1] + RATE_WINDOW_MS - now);
}

export function backgroundAllowed(bucket: string, env: RateEnv, now: number, cost: number): boolean {
  return rateWaitMs(bucket, env, now, cost, "background") === 0;
}

// Retry-After: whole seconds (what the venue documents) or an HTTP date.
// null = absent or unreadable.
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^\d{1,6}$/.test(v)) return Number(v) * 1000;
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) return null;
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

// ---- what the status bar shows ---------------------------------------------

export type RateNotice = {
  warningAt: number;          // when the venue last sent X-RateLimit-Warning (0 = never)
  warningText: string;        // what it said (cleaned, capped)
  heldUntil: number;          // the latest hold on any key (0 = never)
  scope: string | null;       // X-RateLimit-Scope of the last 429
  limit: number | null;       // X-RateLimit-Limit of the last 429
};

let notice: RateNotice = { warningAt: 0, warningText: "", heldUntil: 0, scope: null, limit: null };
const listeners = new Set<() => void>();

function setNotice(next: RateNotice): void {
  notice = next;
  for (const l of [...listeners]) l();
}

// Header text is the venue's free-form string: printable ASCII only, capped,
// and anything shaped like a key is cut out before it is kept or shown.
function clean(text: string | null | undefined, max: number): string | null {
  if (typeof text !== "string") return null;
  const t = text.replace(/fp_(live|test)_[A-Za-z0-9_-]+/g, "[key]").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t === "" ? null : t;
}

export function noteWarning(text: string | null | undefined, now: number): void {
  const t = clean(text, 160);
  if (t === null) return;
  setNotice({ ...notice, warningAt: now, warningText: t });
}

export function subscribeRate(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export const rateNotice = (): RateNotice => notice;

// The line for the status bar, or null when there is nothing to say.
export function rateLine(n: RateNotice, now: number): string | null {
  if (n.heldUntil > now && n.heldUntil - now <= MAX_HOLD_MS) return "rate limited, next read in " + Math.max(1, Math.ceil((n.heldUntil - now) / 1000)) + " s";
  if (n.warningAt > 0 && now - n.warningAt < WARNING_SHOWN_MS) return "rate warning";
  return null;
}

// Tests only: forget every count, hold and notice.
export function resetRate(): void {
  buckets.clear();
  setNotice({ warningAt: 0, warningText: "", heldUntil: 0, scope: null, limit: null });
}
