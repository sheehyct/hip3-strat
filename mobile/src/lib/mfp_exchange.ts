// The ONLY file that talks to the MyFundedPerps (MFP) REST API
// (scripts/check-exchange-guard.js enforces it). Scope, per SECURITY.md
// (closed-position history is read on the view key only):
// reads, a FULL market close of one position, and a REVERSE -
// that close, then (only once the close filled flat, the venue's positions
// and working orders agree and the account may open) ONE market order
// opening the opposite side for the pre-close size. Writes are built and
// checked by src/lib/mfp_orders.ts; this file only sends them.
//
// The one fetch lives in call(), and call() takes a POST only as an
// MfpWrite that it asserts itself - no raw body can reach the venue.
//
// Every write carries a fresh Idempotency-Key and client_order_id and is
// sent ONCE. A 4xx is a definitive refusal (nothing executed). A network
// error, a timeout, a 5xx or an unreadable success is AMBIGUOUS: the order
// may exist, so it is never resent - the client_order_id is looked up until
// the order shows or a deadline passes. Truth is the venue's own positions,
// re-read after every write.
//
// Keys are passed in by the caller for one read or one run and never stored
// or logged here.
//
// Rate limits (MFP notice 2026-11-25: 60 GETs a minute on a live key, 30 on
// a sandbox key; writes are not counted). Every GET is counted per key in
// src/lib/mfp_rate.ts. BACKGROUND reads (the poll, the history sync) are
// refused here, before they are sent, when they would pass the soft cap or
// while the venue has told the key to wait. The reads of a close or a
// reverse are always sent. A 429 on a GET is its own outcome: the wait the
// venue names is honoured, never spun through.
import {
  assertMfpWrite, buildMfpClose, buildMfpReverseOpen, mfpData, mfpEnvForKey, mfpOpeningBlocked, mfpOperationId,
  mfpReverseGate, mfpReversePreCheck, mfpTerminal, mfpWorkingBlocksReverse, parseMfpAccount, parseMfpAccounts,
  parseMfpClosedPage, parseMfpError, parseMfpMid, parseMfpOrder, parseMfpOrderLookup, parseMfpPolicy, parseMfpPositions,
  parseMfpWorkingOrders,
} from "./mfp_orders";
import type { MfpAccount, MfpClosed, MfpEnv, MfpError, MfpOrder, MfpPolicy, MfpPosition, MfpWrite } from "./mfp_orders";
import {
  mfpBackgroundWaitMs, mfpBucket, mfpLookupDelayMs, mfpLookupHoldPlan, mfpRoomFor, noteMfpGet, noteMfpLimited,
  noteMfpRateWarning, parseRetryAfterMs,
} from "./mfp_rate";

const HOSTS: Record<MfpEnv, string> = {
  live: "https://developers.myfundedperpetuals.com",
  sandbox: "https://sandbox.myfundedperpetuals.com",
};
const TIMEOUT_MS = 15_000;
const RESOLVE_MIN_MS = 20_000;       // the order lookup deadline: the account's max execution delay + 10 s, clamped
const RESOLVE_MAX_MS = 60_000;
const RESOLVE_HOLD_EXTRA_MS = 65_000; // a rate-limited lookup may outlive its deadline by one venue wait, no more
const COOLDOWN_CAP_MS = 5_000;       // a longer venue cooldown stops the reverse (the flatness proof would go stale)
const EXITS_SETTLE_TRIES = 6;        // leg 2 waits up to ~5 s for the venue to cancel the closed position's exits
const EXITS_SETTLE_EVERY_MS = 800;
const CLOSED_PAGE = 100;             // the API's maximum page size
const CLOSED_MAX_PAGES = 100;        // one history sync reads at most 10,000 closed positions
const CLOSED_PAGE_ROOM = 6;          // a later page waits until this many GETs fit: the poll keeps its share
const CLOSED_WAIT_MAX_MS = 70_000;   // a page waits at most one venue hold for room
// A reverse spends about 13 to 17 GETs on the trade key (38 if every fill is
// slow). It is refused up front when the key has no room for it under the
// venue's limit: running out between the legs would end the account flat.
const REVERSE_GET_ROOM = 18;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

type Req = { method: "GET"; path: string } | { method: "POST"; write: MfpWrite };

type CallOutcome =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "http"; error: MfpError }            // a definitive 4xx
  | { kind: "limited"; error: MfpError; retryAfterMs: number }  // 429 on a GET: nothing was read
  | { kind: "transport"; message: string };      // ambiguous for a write

// A read that was not made, or was refused, because of the key's GET limit.
// waitMs is how long until it is worth asking again. The text names the
// wait and promises nothing: not every caller asks again by itself (the
// Portfolio block does; the history sync waits for its next refresh).
export class MfpLimitedError extends Error {
  readonly waitMs: number;
  constructor(waitMs: number) {
    super("MFP rate limit - wait " + Math.max(1, Math.ceil(waitMs / 1000)) + " s");
    this.name = "MfpLimitedError";
    this.waitMs = waitMs;
  }
}

// By name, not instanceof: a subclass of Error does not always keep its
// prototype through the bundler.
export function mfpLimitedWaitMs(e: unknown): number | null {
  if (!(e instanceof Error) || e.name !== "MfpLimitedError") return null;
  const w = (e as { waitMs?: unknown }).waitMs;
  return typeof w === "number" && Number.isFinite(w) ? w : 0;
}

const limitNote = (e: unknown): string => {
  const w = mfpLimitedWaitMs(e);
  return w === null ? "" : " (MFP rate limit: wait " + Math.max(1, Math.ceil(w / 1000)) + " s)";
};

async function call(key: string, req: Req): Promise<CallOutcome> {
  const env = mfpEnvForKey(key);
  if (!env) return { kind: "http", error: { status: 0, code: "bad_key", message: "not an MFP key (fp_live_ / fp_test_)" } };
  const headers: Record<string, string> = { Authorization: "Bearer " + key, Accept: "application/json" };
  let path: string;
  let body: string | undefined;
  if (req.method === "POST") {
    assertMfpWrite(req.write); // the runtime lock: every POST is a permitted, builder-made write
    path = req.write.path;
    body = JSON.stringify(req.write.body);
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = req.write.idempotencyKey;
  } else {
    path = req.path;
    noteMfpGet(mfpBucket(key), Date.now()); // counted when sent, whatever the answer
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let r: Response;
    try {
      r = await fetch(HOSTS[env] + path, { method: req.method, headers, body, signal: ctl.signal });
    } catch (e) {
      return { kind: "transport", message: e instanceof Error && e.name === "AbortError" ? "timed out" : e instanceof Error ? e.message : "network error" };
    }
    let json: unknown = null;
    let readable = true;
    try { json = await r.json(); } catch { readable = false; }
    if (req.method === "GET") {
      // The grace period: an over-limit GET still answers, with this header.
      const warning = r.headers.get("x-ratelimit-warning");
      if (warning) noteMfpRateWarning(env, warning, Date.now());
      if (r.status === 429) {
        const retryAfterMs = parseRetryAfterMs(r.headers.get("retry-after"));
        noteMfpLimited(mfpBucket(key), retryAfterMs, Date.now());
        return { kind: "limited", error: parseMfpError(r.status, json), retryAfterMs };
      }
    }
    if (r.status >= 500) return { kind: "transport", message: "HTTP " + r.status };
    if (r.status >= 400) return { kind: "http", error: parseMfpError(r.status, json) };
    if (!readable) return { kind: "transport", message: "unreadable response (HTTP " + r.status + ")" };
    return { kind: "ok", status: r.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const errText = (e: MfpError) => e.code + (e.message && e.message !== e.code ? ": " + e.message : "");

// A read that throws a readable message on anything but success.
async function get(key: string, path: string): Promise<unknown> {
  const r = await call(key, { method: "GET", path });
  if (r.kind === "ok") return r.json;
  if (r.kind === "limited") throw new MfpLimitedError(r.retryAfterMs);
  throw new Error(r.kind === "http" ? errText(r.error) : r.message);
}

// A background read of `cost` GETs is refused, unsent, when it would pass
// the key's soft cap or the venue's hold is still running.
function admitBackground(key: string, env: MfpEnv, cost: number): void {
  const wait = mfpBackgroundWaitMs(mfpBucket(key), env, Date.now(), cost);
  if (wait > 0) throw new MfpLimitedError(wait);
}

const enc = encodeURIComponent;

// ---- reads -----------------------------------------------------------------

// Settings: a key is stored only when the venue answers with EXACTLY one
// account for it (the user scopes each key to one challenge account).
export async function verifyMfpKey(key: string): Promise<{ env: MfpEnv; account: MfpAccount }> {
  const env = mfpEnvForKey(key);
  if (!env) throw new Error("not an MFP API key - expected fp_live_... or fp_test_...");
  let listJson: unknown;
  try {
    listJson = await get(key, "/v1/accounts");
  } catch (e) {
    const w = mfpLimitedWaitMs(e);
    if (w === null) throw e;
    throw new Error("MFP rate limit on this key - try again in " + Math.max(1, Math.ceil(w / 1000)) + " s; not stored");
  }
  const list = parseMfpAccounts(listJson);
  if (!list) throw new Error("the venue's account list was unreadable");
  if (list.length === 0) throw new Error("this key sees no account");
  if (list.length > 1) throw new Error("this key sees " + list.length + " accounts - scope it to ONE challenge account on MFP; not stored");
  return { env, account: list[0] };
}

export type MfpView = {
  env: MfpEnv;
  account: MfpAccount;
  positions: MfpPosition[];
  policy: MfpPolicy | null;          // null = unreadable (Reverse stays hidden)
  mids: Record<string, number | null>;
  at: number;
};

async function readPositions(key: string, accountId: string): Promise<MfpPosition[]> {
  const p = parseMfpPositions(await get(key, "/v1/positions?account_id=" + enc(accountId)));
  if (!p) throw new Error("the open positions were unreadable");
  return p;
}

// The complete working set (pending + resting). Throws when unreadable - a
// gate must never mistake "could not read" for "none".
async function readWorking(key: string, accountId: string): Promise<MfpOrder[]> {
  const w = parseMfpWorkingOrders(await get(key, "/v1/orders?account_id=" + enc(accountId) + "&status=working"));
  if (!w) throw new Error("the working orders were unreadable");
  return w;
}

async function readPolicy(key: string, accountId: string): Promise<MfpPolicy | null> {
  try {
    return parseMfpPolicy(await get(key, "/v1/accounts/" + enc(accountId) + "/trading-policy"));
  } catch {
    return null;
  }
}

async function readMid(key: string, marketId: string): Promise<number | null> {
  try {
    return parseMfpMid(await get(key, "/v1/markets/" + enc(marketId) + "/quote"));
  } catch {
    return null;
  }
}

// The Portfolio poll, on the ungated view key: three GETs and one quote per
// market held. expectMarkets is the last reading's market count, so a whole
// cycle is admitted or refused at once (a cycle is never cut off before its
// quotes).
export async function fetchMfpView(viewKey: string, accountId: string, expectMarkets = 0): Promise<MfpView> {
  const env = mfpEnvForKey(viewKey);
  if (!env) throw new Error("the stored view key is not an MFP key");
  admitBackground(viewKey, env, 3 + Math.max(0, expectMarkets));
  const [accJson, positions, policy] = await Promise.all([
    get(viewKey, "/v1/accounts/" + enc(accountId)),
    readPositions(viewKey, accountId),
    readPolicy(viewKey, accountId),
  ]);
  const account = parseMfpAccount(mfpData(accJson));
  if (!account) throw new Error("the account was unreadable");
  const markets = [...new Set(positions.map((p) => p.marketId))];
  const mids: Record<string, number | null> = {};
  const got = await Promise.all(markets.map((m) => readMid(viewKey, m)));
  markets.forEach((m, i) => { mids[m] = got[i]; });
  return { env, account, positions, policy, mids, at: Date.now() };
}

export type MfpClosedSync = { account: MfpAccount; fresh: MfpClosed[]; complete: boolean };

// The Performance view's history (SECURITY.md: the VIEW
// key only). Closed positions arrive newest close first and never change, so
// paging stops at the first one the cache already holds, at the last page,
// or at the page cap (complete = false: older closes were not read).
// A later page waits for room under the soft cap (a first sync of a long
// history paces itself instead of bursting), and a later page the venue
// refuses with a 429 is asked ONCE more after the wait it named. The first
// page never waits: a refusal there throws at once, so the Performance view
// shows its cache instead of sitting on "loading" for a minute.
export async function fetchMfpClosedSince(viewKey: string, accountId: string, known: Set<string>): Promise<MfpClosedSync> {
  const env = mfpEnvForKey(viewKey);
  if (!env) throw new Error("the stored view key is not an MFP key");
  admitBackground(viewKey, env, 2);
  const pagedGet = async (path: string, first: boolean): Promise<unknown> => {
    for (let tries = 0; ; tries++) {
      if (!first || tries > 0) {
        const wait = mfpBackgroundWaitMs(mfpBucket(viewKey), env, Date.now(), CLOSED_PAGE_ROOM);
        if (wait > CLOSED_WAIT_MAX_MS) throw new MfpLimitedError(wait);
        if (wait > 0) await sleep(wait + 50);
      }
      try {
        return await get(viewKey, path);
      } catch (e) {
        if (first || mfpLimitedWaitMs(e) === null || tries >= 1) throw e;
      }
    }
  };
  const account = parseMfpAccount(mfpData(await get(viewKey, "/v1/accounts/" + enc(accountId))));
  if (!account) throw new Error("the account was unreadable");
  const fresh: MfpClosed[] = [];
  const seen = new Set<string>();   // a close landing mid-sync can shift a row onto the next page too
  let cursor: string | null = null;
  for (let page = 0; page < CLOSED_MAX_PAGES; page++) {
    const path = "/v1/positions?account_id=" + enc(accountId) + "&status=closed&limit=" + CLOSED_PAGE + (cursor ? "&cursor=" + enc(cursor) : "");
    const p = parseMfpClosedPage(await pagedGet(path, page === 0));
    if (!p) throw new Error("the closed positions were unreadable");
    for (const r of p.rows) {
      if (known.has(r.id)) return { account, fresh, complete: true };
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      fresh.push(r);
    }
    if (!p.hasMore) return { account, fresh, complete: true };
    cursor = p.nextCursor;
  }
  return { account, fresh, complete: false };
}

// ---- writes ----------------------------------------------------------------

type SendOutcome =
  | { kind: "order"; order: MfpOrder | null }    // accepted (order unreadable = null)
  | { kind: "refused"; error: MfpError }
  | { kind: "unknown"; message: string };

// Send ONE write, once. Never retries.
async function send(key: string, w: MfpWrite): Promise<SendOutcome> {
  const r = await call(key, { method: "POST", write: w });
  if (r.kind === "transport") return { kind: "unknown", message: r.message };
  // "limited" is a GET outcome; call() never returns it for a POST (a 429 on
  // a write is the per-IP limit, refused before the API: a definite 4xx).
  if (r.kind === "http" || r.kind === "limited") return { kind: "refused", error: r.error };
  return { kind: "order", order: parseMfpOrder(mfpData(r.json)) };
}

const resolveDeadline = (p: MfpPolicy | null) =>
  Math.min(RESOLVE_MAX_MS, Math.max(RESOLVE_MIN_MS, (p ? p.executionDelayMaxMs : 0) + 10_000));

// Look the order up by the client_order_id this app assigned, until it is
// terminal or the deadline passes. Returns the last reading (null = never
// seen). Reads only. The pause between lookups grows (mfpLookupDelayMs), and
// a lookup the venue rate-limits is not spun through: the wait it names is
// sat out, and the deadline stretches just far enough for ONE lookup after
// it (never past RESOLVE_HOLD_EXTRA_MS), so a limited lookup ends with the
// venue's answer rather than "not found". `held` says a wait happened: the
// answer is true, but it is late.
type Resolved = { order: MfpOrder | null; held: boolean };
async function resolveOrder(
  key: string, accountId: string, clientOrderId: string, deadlineMs: number, onHeld?: (waitMs: number) => void,
): Promise<Resolved> {
  let until = Date.now() + deadlineMs;
  const hardStop = until + RESOLVE_HOLD_EXTRA_MS;
  let last: MfpOrder | null = null;
  let held = false;
  for (let attempt = 0; Date.now() < until; attempt++) {
    let heldMs: number | null = null;
    try {
      const o = parseMfpOrderLookup(await get(key, "/v1/orders?account_id=" + enc(accountId) + "&client_order_id=" + enc(clientOrderId)), clientOrderId);
      if (o) {
        last = o;
        if (mfpTerminal(o.status)) return { order: o, held };
      }
    } catch (e) {
      // a failed lookup is retried until the deadline; it never re-sends
      heldMs = mfpLimitedWaitMs(e);
    }
    if (heldMs !== null) {
      const plan = mfpLookupHoldPlan(Date.now(), heldMs, until, hardStop);
      if (!plan) break; // no time for a lookup after the wait: stop, do not sleep and leave unasked
      held = true;
      until = plan.until;
      if (onHeld) onHeld(plan.waitMs);
      await sleep(plan.waitMs);
    } else {
      await sleep(mfpLookupDelayMs(attempt));
    }
  }
  return { order: last, held };
}

const newIds = (kind: "close" | "rev-close" | "rev-open") => ({
  clientOrderId: mfpOperationId(kind, Date.now(), Math.random()),
  idempotencyKey: mfpOperationId(kind, Date.now(), Math.random()) + "-k",
});

export type MfpStep = { stage: "preparing" | "sent" | "waiting" | "verifying" | "done"; text: string };

export type MfpCloseResult = {
  marketId: string;
  requested: number;          // the venue's size closed (full close)
  order: MfpOrder | null;     // the close order as last read
  pending: boolean;           // seen but not terminal at the deadline: it may still fill
  residual: number | null;    // size still open on the market afterwards (0 = flat; null = unread)
  after: MfpPosition[] | null;
  error: string | null;
  ambiguous: boolean;         // the send's answer was lost; the order was looked up
  held: boolean;              // the lookup sat out an MFP rate-limit wait: the result is true, but late
};

// Leg 1 / a plain close, on a position the caller has just re-read.
async function closeOnce(key: string, pre: MfpPosition, kind: "close" | "rev-close", deadlineMs: number, step: (s: MfpStep) => void): Promise<MfpCloseResult> {
  const out: MfpCloseResult = { marketId: pre.marketId, requested: pre.size, order: null, pending: false, residual: null, after: null, error: null, ambiguous: false, held: false };
  // The venue requires the observed mid on a market close; read it fresh.
  const mid = await readMid(key, pre.marketId);
  if (mid === null) {
    out.error = "no price for " + pre.symbol + " - the close was not sent";
    out.residual = pre.size;
    return out;
  }
  const ids = newIds(kind);
  const w = buildMfpClose(pre, mid, ids.clientOrderId, ids.idempotencyKey);
  step({ stage: "sent", text: "closing " + pre.size + " " + pre.symbol + " at market" });
  const res = await send(key, w);
  if (res.kind === "refused") {
    out.error = errText(res.error);
  } else {
    if (res.kind === "unknown") out.ambiguous = true;
    out.order = res.kind === "order" ? res.order : null;
    if (!out.order || !mfpTerminal(out.order.status)) {
      step({ stage: "waiting", text: res.kind === "unknown" ? "answer lost (" + res.message + ") - looking the close up, not re-sending" : "waiting for the fill" });
      const looked = await resolveOrder(key, pre.accountId, ids.clientOrderId, deadlineMs, (ms) =>
        step({ stage: "waiting", text: "MFP rate limit - looking the close up again in " + Math.ceil(ms / 1000) + " s, not re-sending" }));
      if (looked.order) out.order = looked.order;
      out.held = looked.held;
    }
    if (!out.order) out.error = "no close order found after " + Math.round(deadlineMs / 1000) + " s - check MFP before acting";
    else if (!mfpTerminal(out.order.status)) { out.pending = true; out.error = "close still " + out.order.status + " on MFP"; }
    else if (out.order.status !== "filled") out.error = "close " + out.order.status + (out.order.rejectReason ? ": " + out.order.rejectReason : "");
  }
  step({ stage: "verifying", text: "reading the venue" });
  try {
    out.after = await readPositions(key, pre.accountId);
    out.residual = out.after.filter((p) => p.marketId === pre.marketId).reduce((a, p) => a + p.size, 0);
  } catch {
    out.after = null;
    out.residual = null;
  }
  return out;
}

// Close ONE position fully. `shown` is what the sheet displayed; the venue
// is re-read first and a changed position is not touched.
export async function mfpClosePosition(tradeKey: string, shown: MfpPosition, onStep?: (s: MfpStep) => void): Promise<{ close: MfpCloseResult | null; stopped: string | null }> {
  const step = (s: MfpStep) => onStep && onStep(s);
  step({ stage: "preparing", text: "re-reading the position" });
  let venue: MfpPosition[] | null = null;
  let held = "";
  try { venue = await readPositions(tradeKey, shown.accountId); } catch (e) { venue = null; held = limitNote(e); }
  const pre = mfpReversePreCheck(shown, venue);
  if (pre) return { close: null, stopped: pre + held + "; nothing was sent" };
  const now = (venue as MfpPosition[]).find((p) => p.id === shown.id) as MfpPosition;
  const policy = await readPolicy(tradeKey, shown.accountId);
  const close = await closeOnce(tradeKey, now, "close", resolveDeadline(policy), step);
  step({ stage: "done", text: "done" });
  return { close, stopped: null };
}

export type MfpOpenResult = {
  requested: number;
  order: MfpOrder | null;
  pending: boolean;          // seen but not terminal at the deadline: it may still fill
  held: { side: "long" | "short"; size: number } | null;  // the venue's position on the market afterwards
  heldRead: boolean;
  error: string | null;
  ambiguous: boolean;
};

export type MfpReverseResult = {
  close: MfpCloseResult | null;   // null = stopped before leg 1 (nothing sent)
  open: MfpOpenResult | null;     // null = leg 2 never sent
  stopped: string | null;
};

// Leg 2 is sent only when mfpReverseGate passes on readings taken AFTER the
// account's order cooldown (close filled flat; no position and no working
// order left on the market; the account may open), ONCE. An answer lost in
// transit is looked up, never re-sent.
export async function mfpReversePosition(tradeKey: string, shown: MfpPosition, onStep?: (s: MfpStep) => void): Promise<MfpReverseResult> {
  const step = (s: MfpStep) => onStep && onStep(s);
  const stopBefore = (why: string): MfpReverseResult => ({ close: null, open: null, stopped: why + "; nothing was sent" });
  // Refused before anything is read or sent when the trade key has no room
  // left for the whole sequence, or MFP has told it to wait.
  const tradeEnv = mfpEnvForKey(tradeKey);
  if (tradeEnv && !mfpRoomFor(mfpBucket(tradeKey), tradeEnv, Date.now(), REVERSE_GET_ROOM)) {
    return stopBefore("MFP's rate limit leaves this key too little room to finish a reverse - wait a minute (a plain Close is not held back)");
  }
  step({ stage: "preparing", text: "re-reading the position, orders and the account's rules" });
  let venue: MfpPosition[] | null = null;
  let held = "";
  try { venue = await readPositions(tradeKey, shown.accountId); } catch (e) { venue = null; held = limitNote(e); }
  const pre = mfpReversePreCheck(shown, venue);
  if (pre) return stopBefore(pre + held);
  const prePos = (venue as MfpPosition[]).find((p) => p.id === shown.id) as MfpPosition;
  // A reverse that could not open would end flat: refuse it up front.
  const policy = await readPolicy(tradeKey, shown.accountId);
  const blocked = mfpOpeningBlocked(policy);
  if (blocked) return stopBefore(blocked);
  const cooldown = (policy as MfpPolicy).orderCooldownMs;
  if (cooldown > COOLDOWN_CAP_MS) return stopBefore("the account's order cooldown is " + Math.round(cooldown / 1000) + " s - too long to reverse safely");
  let working: MfpOrder[] | null = null;
  try { working = await readWorking(tradeKey, shown.accountId); } catch (e) { working = null; held = limitNote(e); }
  const workBlock = mfpWorkingBlocksReverse(working, prePos.marketId);
  if (workBlock) return stopBefore(workBlock + held);
  const deadline = resolveDeadline(policy);

  const close = await closeOnce(tradeKey, prePos, "rev-close", deadline, step);
  if (close.error || !close.order || close.order.status !== "filled") {
    return { close, open: null, stopped: (close.pending ? "the close is still pending" : "the close did not complete") + "; no opening order was sent" };
  }
  // A close confirmed only after a rate-limit wait is a minute or more old.
  // A reverse is one decision at one price: its opening leg is never sent
  // that late. The account stays flat and says why.
  if (close.held) {
    return { close, open: null, stopped: "the close filled, but MFP's rate limit delayed its confirmation; no opening order was sent" };
  }

  // Fresh readings AFTER the cooldown: the gate never decides on a stale
  // flatness proof. The venue cancels the closed position's exits; give it a
  // few seconds to show none left on the market.
  await sleep(cooldown + 150);
  step({ stage: "verifying", text: "re-checking the market is flat and clear" });
  let after: MfpPosition[] | null = null;
  let workingAfter: MfpOrder[] | null = null;
  // A rate-limited read ends the loop at once: the remaining passes would be
  // refused too, and the gate below then stops the reverse (the account ends
  // flat - a reverse is never finished on a reading that could not be taken).
  let heldAfter = "";
  for (let i = 0; i < EXITS_SETTLE_TRIES; i++) {
    try { after = await readPositions(tradeKey, prePos.accountId); } catch (e) { after = null; heldAfter = limitNote(e) || heldAfter; }
    try { workingAfter = await readWorking(tradeKey, prePos.accountId); } catch (e) { workingAfter = null; heldAfter = limitNote(e) || heldAfter; }
    const clear = after !== null && workingAfter !== null && !workingAfter.some((o) => o.marketId === prePos.marketId);
    if (clear || heldAfter || i === EXITS_SETTLE_TRIES - 1) break;
    await sleep(EXITS_SETTLE_EVERY_MS);
  }
  const policyAfter = await readPolicy(tradeKey, prePos.accountId);
  const gate = mfpReverseGate({ pre: prePos, close: close.order, venueAfter: after, workingAfter, policy: policyAfter });
  if (!gate.ok) return { close, open: null, stopped: gate.reason + heldAfter + "; no opening order was sent" };

  const open: MfpOpenResult = { requested: gate.size, order: null, pending: false, held: null, heldRead: false, error: null, ambiguous: false };
  step({ stage: "preparing", text: "reading the price for the reverse" });
  const mid = await readMid(tradeKey, prePos.marketId);
  if (mid === null) {
    open.error = "no price for " + prePos.symbol + " - the reverse was not sent";
    return { close, open, stopped: null };
  }
  const ids = newIds("rev-open");
  let w: MfpWrite;
  try {
    w = buildMfpReverseOpen(gate, prePos, mid, ids.clientOrderId, ids.idempotencyKey);
  } catch (e) {
    open.error = e instanceof Error ? e.message : "could not prepare the reverse";
    return { close, open, stopped: null };
  }
  step({ stage: "sent", text: "opening " + (prePos.side === "long" ? "short " : "long ") + gate.size + " " + prePos.symbol });
  const res = await send(tradeKey, w);
  if (res.kind === "refused") {
    open.error = errText(res.error);
  } else {
    if (res.kind === "unknown") open.ambiguous = true;
    open.order = res.kind === "order" ? res.order : null;
    if (!open.order || !mfpTerminal(open.order.status)) {
      step({ stage: "waiting", text: res.kind === "unknown" ? "answer lost (" + res.message + ") - looking the order up, not re-sending" : "waiting for the fill" });
      const looked = await resolveOrder(tradeKey, prePos.accountId, ids.clientOrderId, deadline, (ms) =>
        step({ stage: "waiting", text: "MFP rate limit - looking the order up again in " + Math.ceil(ms / 1000) + " s, not re-sending" }));
      if (looked.order) open.order = looked.order;
    }
    if (!open.order) {
      // Lost answer AND never seen: it may still exist on the venue.
      open.pending = res.kind === "unknown";
      open.error = "no opening order found after " + Math.round(deadline / 1000) + " s - check MFP before acting";
    } else if (!mfpTerminal(open.order.status)) { open.pending = true; open.error = "open still " + open.order.status + " on MFP"; }
    else if (open.order.status !== "filled") open.error = "open " + open.order.status + (open.order.rejectReason ? ": " + open.order.rejectReason : "");
  }
  step({ stage: "verifying", text: "reading the venue" });
  try {
    const held = await readPositions(tradeKey, prePos.accountId);
    open.heldRead = true;
    const onMarket = held.filter((p) => p.marketId === prePos.marketId);
    if (onMarket.length) {
      const size = onMarket.reduce((a, p) => a + p.size, 0);
      open.held = { side: onMarket[0].side, size };
      // Loud flag, never an automatic extra trade.
      if (size > gate.size * (1 + 1e-9)) open.error = (open.error ? open.error + "; " : "") + "the venue holds MORE than the reverse asked for - check the position";
    }
  } catch {
    open.heldRead = false;
  }
  step({ stage: "done", text: "done" });
  return { close, open, stopped: null };
}
