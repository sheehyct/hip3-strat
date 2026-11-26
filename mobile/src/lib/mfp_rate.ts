// MyFundedPerps per-key GET budget (MFP developer notice 2026-11-25: a
// default per-API-key limit on GET requests - 60 a minute on a live key, 30
// on a sandbox key; writes are not counted). Pure and import-free: node --test
// loads it straight from source.
//
// Two rules live here:
// - BACKGROUND reads (the Portfolio poll, a stream-triggered re-read, the
//   history sync) stay under a soft cap well below the venue's limit, and
//   stop entirely while the venue has told this key to wait (Retry-After).
// - CRITICAL reads (the re-reads, gates and order lookups of a close or a
//   reverse, and a key check in Settings) are always sent: an exit is always
//   attempted. They are counted, so the background reads make room for them.
//
// A key is never kept here: callers pass a bucket id, a short non-secret
// hash of the key (mfpBucket).

export type MfpRateEnv = "live" | "sandbox";

const WINDOW_MS = 60_000;
// The venue's limits are 60 / 30. The window type (fixed or sliding) is not
// documented, and a fixed window can see two bursts back to back, so the
// background share is kept at two thirds of the limit.
const SOFT_CAP: Record<MfpRateEnv, number> = { live: 40, sandbox: 20 };
const VENUE_LIMIT: Record<MfpRateEnv, number> = { live: 60, sandbox: 30 };
const HOLD_MIN_MS = 1_000;
const HOLD_MAX_MS = 300_000;
const HOLD_DEFAULT_MS = 60_000;   // the venue's documented Retry-After

type Bucket = { sent: number[]; holdUntil: number };

const buckets = new Map<string, Bucket>();

function bucketFor(id: string): Bucket {
  let b = buckets.get(id);
  if (!b) { b = { sent: [], holdUntil: 0 }; buckets.set(id, b); }
  return b;
}

// A clock that steps backwards must not leave "future" GETs in the window or
// a hold that outlives its maximum: both would refuse background reads until
// the clock caught up.
function prune(b: Bucket, now: number): void {
  const from = now - WINDOW_MS;
  while (b.sent.length && b.sent[0] <= from) b.sent.shift();
  while (b.sent.length && b.sent[b.sent.length - 1] > now) b.sent.pop();
  if (b.holdUntil - now > HOLD_MAX_MS) b.holdUntil = now + HOLD_MAX_MS;
}

// A short non-secret id for a key (djb2 over its characters). Two keys can
// collide; the only cost would be a shared, more careful budget.
export function mfpBucket(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return "k" + (h >>> 0).toString(36);
}

export const mfpSoftCap = (env: MfpRateEnv): number => SOFT_CAP[env];
export const mfpVenueLimit = (env: MfpRateEnv): number => VENUE_LIMIT[env];

// One GET was sent on this key.
export function noteMfpGet(id: string, now: number): void {
  const b = bucketFor(id);
  prune(b, now);
  b.sent.push(now);
}

// GETs sent on this key in the last minute.
export function mfpGetsUsed(id: string, now: number): number {
  const b = bucketFor(id);
  prune(b, now);
  return b.sent.length;
}

// The Retry-After header as milliseconds: whole seconds, clamped; the
// documented 60 s when missing or unreadable.
export function parseRetryAfterMs(header: string | null | undefined): number {
  if (typeof header !== "string" || !/^\s*\d+\s*$/.test(header)) return HOLD_DEFAULT_MS;
  return Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, Number(header.trim()) * 1000));
}

// The venue answered 429 on a GET for this key: no background read until
// the wait is over. A later, shorter answer never shortens a hold.
export function noteMfpLimited(id: string, retryAfterMs: number, now: number): void {
  const b = bucketFor(id);
  const ms = Number.isFinite(retryAfterMs) ? Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, retryAfterMs)) : HOLD_DEFAULT_MS;
  b.holdUntil = Math.max(b.holdUntil, now + ms);
}

// Milliseconds left on this key's hold (0 = none).
export function mfpHoldMs(id: string, now: number): number {
  const b = bucketFor(id);
  prune(b, now);
  return Math.max(0, b.holdUntil - now);
}

// Is there room on this key, under the VENUE's limit, for `cost` more GETs
// right now? For a sequence that must not be cut off half way (a reverse:
// running out between its legs ends the account flat). False while the
// venue's hold runs.
export function mfpRoomFor(id: string, env: MfpRateEnv, now: number, cost: number): boolean {
  const b = bucketFor(id);
  prune(b, now);
  return b.holdUntil <= now && b.sent.length + Math.max(0, Math.floor(cost)) <= VENUE_LIMIT[env];
}

// How long until `cost` more background GETs fit on this key: 0 = they fit
// now. Counts the hold first, then the soft cap.
export function mfpBackgroundWaitMs(id: string, env: MfpRateEnv, now: number, cost: number): number {
  const b = bucketFor(id);
  prune(b, now);
  const hold = Math.max(0, b.holdUntil - now);
  const cap = SOFT_CAP[env];
  const need = Math.max(1, Math.floor(cost));
  // A cycle larger than the whole cap can never fit; it is let through when
  // the window is empty rather than starved for ever.
  const over = need >= cap ? b.sent.length : b.sent.length + need - cap;
  if (over <= 0) return hold;
  const frees = b.sent[Math.min(over, b.sent.length) - 1] + WINDOW_MS - now;
  return Math.max(hold, frees, 0);
}

export const mfpBackgroundAllowed = (id: string, env: MfpRateEnv, now: number, cost: number): boolean =>
  mfpBackgroundWaitMs(id, env, now, cost) === 0;

// ---- the grace-period warning ---------------------------------------------
// Until enforcement the venue answers an over-limit GET normally and adds an
// X-RateLimit-Warning header. The last one seen is kept (time and text, no
// key) so the Portfolio can say the key is polling above the coming limit.

export type MfpRateWarning = { at: number; env: MfpRateEnv; text: string };

let lastWarning: MfpRateWarning | null = null;
const listeners = new Set<() => void>();

export function noteMfpRateWarning(env: MfpRateEnv, text: string, now: number): void {
  lastWarning = { at: now, env, text: text.slice(0, 200) };
  for (const l of [...listeners]) l();
}

export const mfpRateWarning = (): MfpRateWarning | null => lastWarning;

export function subscribeMfpRate(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// The wait between order lookups: quick at first (a market order normally
// fills in one or two), then slower, so a lookup that runs to its deadline
// stays near 20 GETs a minute instead of 85.
const LOOKUP_STEPS_MS = [700, 1000, 1500, 2000, 3000];
export const mfpLookupDelayMs = (attempt: number): number =>
  LOOKUP_STEPS_MS[Math.min(Math.max(0, Math.floor(attempt)), LOOKUP_STEPS_MS.length - 1)];

// An order lookup the venue rate-limited: sit out the wait it named, then
// look ONCE more. `until` is the lookup's deadline and `hardStop` the latest
// it may ever run to. null = there is no time left for a lookup after the
// wait, so stop now rather than sleep and leave without asking.
export function mfpLookupHoldPlan(
  now: number, heldMs: number, until: number, hardStop: number,
): { waitMs: number; until: number } | null {
  const wait = Number.isFinite(heldMs) ? Math.max(HOLD_MIN_MS, heldMs) : HOLD_DEFAULT_MS;
  if (now + wait + 500 >= hardStop) return null;
  return { waitMs: wait, until: Math.min(hardStop, Math.max(until, now + wait + 2_000)) };
}

// Tests only.
export function resetMfpRate(): void {
  buckets.clear();
  lastWarning = null;
}
