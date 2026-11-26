// The ONLY file that talks to the MyFundedPerps (MFP) REST API with a key
// (scripts/check-exchange-guard.js enforces it; the keyless public market
// list lives in mfp_market_list.ts). The one fetch lives in call(), and
// call() takes a write
// only as an MfpWrite that it asserts itself - no raw body can reach the
// venue.
//
// Every write carries a fresh Idempotency-Key (and a client_order_id where
// the endpoint takes one) and is sent ONCE. A 4xx is a definitive refusal
// (nothing executed). A network error, a timeout, a 5xx or an unreadable
// success is AMBIGUOUS: the write may have landed, so it is never resent -
// an order is looked up by client_order_id until it shows or a deadline
// passes; a modify / cancel / exits write is resolved by re-reading the
// working orders. Truth is the venue's own positions and orders, re-read
// after every write.
//
// Keys are passed in by the caller for one read or one run and never stored
// or logged here.
//
// MFP counts GETs per key (mfp_rate.ts). Every GET sent here is counted; a
// 429 puts the key on hold for the venue's Retry-After. A read that is not
// on the trade path ("background": the poll, history, the ledger's lookups;
// "settle": the re-read after a write) is not sent at all while the key is
// held or its share of the minute is spent - it throws a heldError
// (venue.ts) and the store shows it. A trade-path read (the pre-trade
// re-read, the price, the lookup of an order this call just sent) is always
// sent: an exit must always be attempted.
import { Platform } from "react-native";

import {
  assertMfpWrite, buildMfpCancel, buildMfpClose, buildMfpExits, buildMfpModify, buildMfpOrder, mfpData, mfpEnvForKey, mfpForeignRows,
  mfpIsRefusal, mfpOpeningBlocked, mfpOperationId, mfpPickAccount, mfpReverseGate, mfpReversePreCheck, mfpSizeFloors, mfpTerminal, mfpWorkingBlocksReverse,
  parseMfpAccount, parseMfpAccounts, parseMfpError, parseMfpFills, parseMfpOrder, parseMfpOrderLookup, parseMfpPolicy,
  parseMfpPositions, parseMfpQuote, parseMfpRecentOrders, parseMfpWorkingOrders,
} from "./mfp_orders";
import type {
  ExitOp, MfpAccount, MfpAccountPick, MfpEnv, MfpError, MfpFill, MfpOrder, MfpOrderInput, MfpPolicy, MfpPosition, MfpQuote, MfpWrite,
} from "./mfp_orders";
import { holdUntil, noteGet, noteLimited, noteWarning, parseRetryAfter, rateBucket, rateWaitMs, tradeWaitMs } from "./mfp_rate";
import type { RateClass } from "./mfp_rate";
import { capRefusal } from "./order_policy";
import { sessionLive, sessionRefusal, STALE_SESSION_TEXT } from "./session";
import type { Session } from "./session";
import { heldError } from "./venue";

// A browser cannot call MFP: its CORS policy names one origin, MFP's own docs
// site. So the web build sends to the pass-through on ITS OWN origin
// (server/mfp_passthrough.mjs), which forwards a permitted request to the
// same path on the same two hosts and nothing else. Android calls MFP
// directly. The guard pins this declaration to exactly these values, frozen,
// and pins its one use (the fetch's address): nothing else may name it.
const HOSTS: Readonly<Record<MfpEnv, string>> = Object.freeze(Platform.OS === "web"
  ? { live: "/mfp/live", sandbox: "/mfp/sandbox" }
  : { live: "https://developers.myfundedperpetuals.com", sandbox: "https://sandbox.myfundedperpetuals.com" });
const TIMEOUT_MS = 15_000;
const RESOLVE_MIN_MS = 20_000;
const RESOLVE_MAX_MS = 60_000;
// The order lookup backs off: these waits in turn, then the last one.
const RESOLVE_STEPS_MS = [700, 1_000, 1_500, 2_000, 3_000];
// A lookup that ran into the key's hold waits the hold out and is owed ONE
// more look after it, even past its deadline - by at most this much.
const RESOLVE_HOLD_CAP_MS = 65_000;
const HOLD_PAD_MS = 250;
// What a reverse reads on the trade path, about: the pre-check (3), the
// close (2 and its lookups), the settle passes (2 each), the gate (2), the
// opening leg (1 and its lookups). A reverse is refused up front when this
// many more GETs would not fit under the venue's limit on the key.
const REVERSE_READS = 18;
const COOLDOWN_CAP_MS = 5_000;
const EXITS_SETTLE_TRIES = 6;
const EXITS_SETTLE_EVERY_MS = 800;
const VERIFY_DELAY_MS = 1_200;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// A write carries the session it began in; call() checks it on the last
// line before the request goes out (session.ts).
// trade: a GET on the trade path (it is sent even inside a hold, so a 429 on
// it does not push a running hold out: mfp_rate.ts noteLimited).
type Req = { method: "GET"; path: string; trade: boolean } | { method: "WRITE"; write: MfpWrite; session: Session };

type CallOutcome =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "http"; error: MfpError }            // a definitive 4xx (the venue's error body)
  | { kind: "limited"; until: number }           // a GET answered 429: the key is held until then
  | { kind: "transport"; message: string };      // ambiguous for a write

// A response header, or null. Test doubles and odd runtimes may hand back a
// response with no header bag: that reads as "no such header".
function header(r: unknown, name: string): string | null {
  try {
    const h = (r as { headers?: { get?: (n: string) => string | null } }).headers;
    const v = h && typeof h.get === "function" ? h.get(name) : null;
    return typeof v === "string" && v !== "" ? v : null;
  } catch {
    return null;
  }
}

async function call(key: string, req: Req): Promise<CallOutcome> {
  const env = mfpEnvForKey(key);
  if (!env) return { kind: "http", error: { status: 0, code: "bad_key", message: "not an MFP key (fp_live_ / fp_test_)" } };
  const headers: Record<string, string> = { Authorization: "Bearer " + key, Accept: "application/json" };
  let path: string;
  let method: string;
  let body: string | undefined;
  if (req.method === "WRITE") {
    assertMfpWrite(req.write); // the runtime lock: every write is a permitted, builder-made write
    // The app left the session this write began in (demo <-> live) while it
    // waited on a key or an earlier leg: a definite refusal, nothing is sent.
    if (!sessionLive(req.session)) return { kind: "http", error: { status: 0, code: "stale_session", message: sessionRefusal(req.session) ?? STALE_SESSION_TEXT } };
    path = req.write.path;
    method = req.write.method;
    if (req.write.body !== null) {
      body = JSON.stringify(req.write.body);
      headers["Content-Type"] = "application/json";
    }
    headers["Idempotency-Key"] = req.write.idempotencyKey;
  } else {
    path = req.path;
    method = "GET";
  }
  // Every GET that goes out is counted against this key's minute.
  const bucket = rateBucket(key);
  if (req.method === "GET") noteGet(bucket, Date.now());
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let r: Response;
    try {
      r = await fetch(HOSTS[env] + path, { method, headers, body, signal: ctl.signal });
    } catch (e) {
      return { kind: "transport", message: e instanceof Error && e.name === "AbortError" ? "timed out" : e instanceof Error ? e.message : "network error" };
    }
    // The grace period: an over-limit GET still succeeds and says so here.
    const warning = header(r, "x-ratelimit-warning");
    if (warning !== null) noteWarning(warning, Date.now());
    // A GET the venue rate limited: the key is held for its Retry-After. (A
    // write is never counted per key; a 429 on one keeps its old meaning
    // below: a refusal only with the venue's error body.)
    if (r.status === 429 && req.method === "GET") {
      // A trade-path read does not push a hold that is already running out.
      noteLimited(bucket, parseRetryAfter(header(r, "retry-after"), Date.now()), Date.now(), header(r, "x-ratelimit-scope"), header(r, "x-ratelimit-limit"), !req.trade);
      return { kind: "limited", until: holdUntil(bucket) };
    }
    let json: unknown = null;
    let readable = true;
    if (r.status === 204) json = {};
    else { try { json = await r.json(); } catch { readable = false; } }
    if (r.status >= 500) return { kind: "transport", message: "HTTP " + r.status };
    // A 4xx is a definite refusal only with the venue's error body (the
    // pass-through's own refusals carry it too). Any other 4xx did not come
    // from the venue's answer to this request, which may have gone on:
    // unknown, so a write is looked up and never taken as refused.
    if (r.status >= 400) {
      if (!readable || !mfpIsRefusal(json)) return { kind: "transport", message: "HTTP " + r.status + " without the venue's error body" };
      return { kind: "http", error: parseMfpError(r.status, json) };
    }
    if (!readable) return { kind: "transport", message: "unreadable response (HTTP " + r.status + ")" };
    return { kind: "ok", status: r.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const errText = (e: MfpError) => e.code + (e.message && e.message !== e.code ? ": " + e.message : "");

const heldText = (until: number) => "rate limited, next read in " + Math.max(1, Math.ceil((until - Date.now()) / 1000)) + " s";

// "trade": a read a write needs; always sent. The other two are sent only
// when mfp_rate.ts allows them.
type ReadClass = "trade" | RateClass;

// How long a read of `cost` GETs in this class has to wait on this key
// (0 = it may go now). Nothing is sent.
export function mfpReadWait(key: string, cost: number, cls: RateClass = "background"): number {
  const env = mfpEnvForKey(key);
  return env ? rateWaitMs(rateBucket(key), env, Date.now(), cost, cls) : 0;
}

async function get(key: string, path: string, cls: ReadClass = "trade"): Promise<unknown> {
  if (cls !== "trade") {
    const wait = mfpReadWait(key, 1, cls);
    if (wait > 0) throw heldError(Date.now() + wait, heldText(Date.now() + wait));   // not sent
  }
  const r = await call(key, { method: "GET", path, trade: cls === "trade" });
  if (r.kind === "ok") return r.json;
  if (r.kind === "limited") throw heldError(r.until, heldText(r.until));
  throw new Error(r.kind === "http" ? errText(r.error) : r.message);
}

const enc = encodeURIComponent;

// An account-scoped read asks for ONE account and is held to it. A key may
// see more than one account (a sandbox key does), so a row that names
// another account makes the whole answer unreadable: it is never shown, and
// never acted on as this account's.
async function getFor(key: string, accountId: string, path: string, cls: ReadClass = "trade"): Promise<unknown> {
  const json = await get(key, path, cls);
  if (mfpForeignRows(json, accountId) > 0) throw new Error("the venue answered with another account's rows");
  return json;
}

// ---- reads -----------------------------------------------------------------

// The key's environment and the ONE account it is stored for. `wanted` is
// the account the user picked when a sandbox key sees several; with none
// named yet such a key answers with the list to pick from (account: null)
// and the caller stores nothing. The rule is mfpPickAccount's.
export type MfpKeyCheck = { env: MfpEnv } & MfpAccountPick;

export async function verifyMfpKey(key: string, wanted: string | null = null): Promise<MfpKeyCheck> {
  const env = mfpEnvForKey(key);
  if (!env) throw new Error("not an MFP API key - expected fp_live_... or fp_test_...");
  const list = parseMfpAccounts(await get(key, "/v1/accounts"));
  if (!list) throw new Error("the venue's account list was unreadable");
  return { env, ...mfpPickAccount(env, list, wanted) };
}

// The book: the open positions and the working orders, read together. It
// is the read the pending ledger judges writes on, so it is all or nothing.
export type MfpBook = {
  positions: MfpPosition[];
  working: MfpOrder[];          // complete, or the whole read throws
  at: number;
};

async function readPositions(key: string, accountId: string, cls: ReadClass = "trade"): Promise<MfpPosition[]> {
  const p = parseMfpPositions(await getFor(key, accountId, "/v1/positions?account_id=" + enc(accountId), cls));
  if (!p) throw new Error("the open positions were unreadable");
  return p;
}

async function readWorking(key: string, accountId: string, cls: ReadClass = "trade"): Promise<MfpOrder[]> {
  const w = parseMfpWorkingOrders(await getFor(key, accountId, "/v1/orders?account_id=" + enc(accountId) + "&status=working", cls));
  if (!w) throw new Error("the working orders were unreadable");
  return w;
}

async function readPolicy(key: string, accountId: string): Promise<MfpPolicy | null> {
  try {
    return parseMfpPolicy(await getFor(key, accountId, "/v1/accounts/" + enc(accountId) + "/trading-policy"));
  } catch {
    return null;
  }
}

export async function fetchMfpQuote(key: string, marketId: string): Promise<MfpQuote> {
  try {
    return parseMfpQuote(await get(key, "/v1/markets/" + enc(marketId) + "/quote"));
  } catch {
    return { bid: null, ask: null, mid: null };
  }
}

async function readMid(key: string, marketId: string): Promise<number | null> {
  return (await fetchMfpQuote(key, marketId)).mid;
}

// The poll, in three parts read at their own pace (mfp_venue.ts decides
// which are due), on the ungated view key (or the trade key on web, where
// the session holds whichever was entered). Each part is whole or it throws.
//
// The book: two GETs. No fallback: orders that could not be read must not
// look like "no orders" (the pending ledger takes "not there" as proof).
export async function fetchMfpBook(key: string, accountId: string, cls: RateClass = "background"): Promise<MfpBook> {
  if (!mfpEnvForKey(key)) throw new Error("the stored key is not an MFP key");
  const [positions, working] = await Promise.all([readPositions(key, accountId, cls), readWorking(key, accountId, cls)]);
  return { positions, working, at: Date.now() };
}

// The account (balance, equity, the rule room): one GET.
export async function fetchMfpAccount(key: string, accountId: string, cls: RateClass = "background"): Promise<MfpAccount> {
  const account = parseMfpAccount(mfpData(await get(key, "/v1/accounts/" + enc(accountId), cls)));
  if (!account) throw new Error("the account was unreadable");
  if (account.id !== accountId) throw new Error("the venue answered with another account");
  return account;
}

// The trading policy for display (the exposure caps): one GET. Throws when
// the read fails; null when the venue's answer was not understood. A write
// never relies on this copy: it re-reads the policy itself (readPolicy).
export async function fetchMfpPolicy(key: string, accountId: string, cls: RateClass = "background"): Promise<MfpPolicy | null> {
  return parseMfpPolicy(await getFor(key, accountId, "/v1/accounts/" + enc(accountId) + "/trading-policy", cls));
}

export async function fetchMfpRecentOrders(key: string, accountId: string): Promise<MfpOrder[]> {
  return parseMfpRecentOrders(await getFor(key, accountId, "/v1/orders?account_id=" + enc(accountId) + "&limit=100", "background"));
}

// GET /v1/fills (query parameters UNVERIFIED beyond account_id and limit).
export async function fetchMfpFills(key: string, accountId: string): Promise<MfpFill[]> {
  return parseMfpFills(await getFor(key, accountId, "/v1/fills?account_id=" + enc(accountId) + "&limit=100", "background"));
}

// ---- writes ----------------------------------------------------------------

type SendOutcome =
  | { kind: "ok"; json: unknown }
  | { kind: "refused"; error: MfpError }
  | { kind: "unknown"; message: string };

// Send ONE write, once. Never retries.
async function send(s: Session, key: string, w: MfpWrite): Promise<SendOutcome> {
  const r = await call(key, { method: "WRITE", write: w, session: s });
  if (r.kind === "transport") return { kind: "unknown", message: r.message };
  // call() only ever answers "limited" to a GET; were a write to get it, the
  // safe reading is unknown (look it up), never refused.
  if (r.kind === "limited") return { kind: "unknown", message: "HTTP 429" };
  if (r.kind === "http") return { kind: "refused", error: r.error };
  return { kind: "ok", json: r.json };
}

const resolveDeadline = (p: MfpPolicy | null) =>
  Math.min(RESOLVE_MAX_MS, Math.max(RESOLVE_MIN_MS, (p ? p.executionDelayMaxMs : 0) + 10_000));

// How long this key is still held (0 = it is not).
const holdLeft = (key: string): number => Math.max(0, holdUntil(rateBucket(key), Date.now()) - Date.now());

// How long a SEQUENCE of `cost` trade-path reads would have to wait to fit
// under the venue's own limit on this key (0 = it fits now and the key is
// not held). Nothing is sent.
export function mfpTradeWait(key: string, cost: number): number {
  const env = mfpEnvForKey(key);
  return env ? tradeWaitMs(rateBucket(key), env, Date.now(), cost) : 0;
}

// Look the order up by the client_order_id this app assigned, until it is
// terminal or the deadline passes. Returns the last reading (null = never
// seen). Reads only; it never re-sends.
//
// The looks back off (RESOLVE_STEPS_MS). When the venue rate limits the key
// the loop does not spin against the hold: it waits the hold out and is then
// owed ONE look, even past the deadline (by at most RESOLVE_HOLD_CAP_MS), so
// a rate-limited lookup ends on the venue's answer, not on "no order found".
// A hold too long to leave time for that look ends the loop AT ONCE: it never
// sleeps to its limit and then leaves without looking. note.waited: a hold
// was waited out (the answer came late).
async function resolveOrder(key: string, accountId: string, clientOrderId: string, deadlineMs: number, note: { waited: boolean } | null = null): Promise<MfpOrder | null> {
  const until = Date.now() + deadlineMs;
  const hardStop = until + RESOLVE_HOLD_CAP_MS;
  let last: MfpOrder | null = null;
  let owed = false;
  for (let i = 0; ; i++) {
    const held = holdLeft(key);
    if (held > 0) {
      if (Date.now() + held + HOLD_PAD_MS > hardStop) break;   // no time for a look after this hold
      owed = true;
      if (note) note.waited = true;
      await sleep(held + HOLD_PAD_MS);
      continue;
    }
    if ((Date.now() >= until && !owed) || Date.now() > hardStop) break;
    owed = false;
    try {
      const o = parseMfpOrderLookup(await getFor(key, accountId, "/v1/orders?account_id=" + enc(accountId) + "&client_order_id=" + enc(clientOrderId)), clientOrderId);
      if (o) {
        last = o;
        if (mfpTerminal(o.status) || o.status === "resting") return o;
      }
    } catch {
      // a failed lookup is retried until the deadline; it never re-sends. A
      // 429 set the key's hold: the top of the loop waits it out.
    }
    await sleep(RESOLVE_STEPS_MS[Math.min(i, RESOLVE_STEPS_MS.length - 1)]);
  }
  return last;
}

// One look at an order by the client_order_id this app gave it (the store's
// reconciliation of an unresolved write). null = the venue has no such
// order; throws when the read fails or may not be sent yet (a background
// read). Reads only; works on the view key.
export async function lookupMfpOrder(key: string, accountId: string, clientOrderId: string): Promise<MfpOrder | null> {
  return parseMfpOrderLookup(await getFor(key, accountId, "/v1/orders?account_id=" + enc(accountId) + "&client_order_id=" + enc(clientOrderId), "background"), clientOrderId);
}

const newIds = (kind: Parameters<typeof mfpOperationId>[0]) => ({
  clientOrderId: mfpOperationId(kind, Date.now(), Math.random()),
  idempotencyKey: mfpOperationId(kind, Date.now(), Math.random()) + "-k",
});

// "waiting": the venue has the request and is still working on it; "lost":
// its answer was lost. In both the call is only looking the order up.
export type MfpStep = { stage: "preparing" | "sent" | "waiting" | "lost" | "verifying" | "done"; text: string };

// "partial": the order is finished without filling, but part of it executed
// (filled_size): a position exists and the exits owed for it are real.
export type MfpSendResult = {
  kind: "filled" | "resting" | "pending" | "partial" | "rejected" | "unknown";
  order: MfpOrder | null;
  clientOrderId: string;
  message: string | null;
  ambiguous: boolean;
};

// Place one order (market or limit, optional attached exits). The order
// panel has already run the policy; the builder re-checks the fields. The
// account's rules are re-read first: an opening order on a blocked account
// is refused before it is sent.
export async function mfpPlaceOrder(s: Session, key: string, input: MfpOrderInput, onStep?: (s: MfpStep) => void): Promise<MfpSendResult> {
  const step = (s: MfpStep) => onStep && onStep(s);
  const ids = newIds("open");
  const out: MfpSendResult = { kind: "unknown", order: null, clientOrderId: ids.clientOrderId, message: null, ambiguous: false };
  step({ stage: "preparing", text: "reading the account's rules" });
  const policy = await readPolicy(key, input.accountId);
  if (!input.reduceOnly) {
    const blocked = mfpOpeningBlocked(policy);
    if (blocked) return { ...out, kind: "rejected", message: blocked + "; nothing was sent" };
  }
  let w: MfpWrite;
  try {
    w = buildMfpOrder(input, ids.clientOrderId, ids.idempotencyKey);
  } catch (e) {
    return { ...out, kind: "rejected", message: e instanceof Error ? e.message : "could not build the order" };
  }
  step({ stage: "sent", text: input.side + " " + input.size + " " + input.marketId + " " + input.type });
  const res = await send(s, key, w);
  if (res.kind === "refused") return { ...out, kind: "rejected", message: errText(res.error) };
  if (res.kind === "unknown") { out.ambiguous = true; out.message = "answer lost (" + res.message + ") - looking the order up, not re-sending"; }
  else out.order = parseMfpOrder(mfpData(res.json));
  if (!out.order || (!mfpTerminal(out.order.status) && out.order.status !== "resting")) {
    step({ stage: out.ambiguous ? "lost" : "waiting", text: out.ambiguous ? out.message ?? "waiting" : "waiting for the venue" });
    const looked = await resolveOrder(key, input.accountId, ids.clientOrderId, resolveDeadline(policy));
    if (looked) out.order = looked;
  }
  if (!out.order) return { ...out, kind: "unknown", message: out.message ?? "no order found - check MFP before acting" };
  const st = out.order.status;
  if (st === "filled") return { ...out, kind: "filled", message: null };
  if (st === "resting" || st === "armed") return { ...out, kind: "resting", message: null };
  const ran = Math.max(0, out.order.filledSize ?? 0);
  const why = st + (out.order.rejectReason ? ": " + out.order.rejectReason : "");
  // Finished with a part executed is not a refusal: that part is held.
  if (mfpTerminal(st) && ran > 0) return { ...out, kind: "partial", message: why + "; " + ran + " executed before it ended" };
  if (mfpTerminal(st)) return { ...out, kind: "rejected", message: why };
  return { ...out, kind: "pending", message: "still " + st + " on MFP" };
}

// size: on a modify, the size the venue took the order to (null = not said).
export type MfpSimpleResult = { ok: boolean; message: string | null; ambiguous: boolean; size?: number | null };

async function orderStillWorking(key: string, accountId: string, orderId: string): Promise<boolean | null> {
  try {
    return (await readWorking(key, accountId)).some((o) => o.id === orderId);
  } catch {
    return null;
  }
}

// The venue floors a modify's size to the market's step (the modify
// endpoint's docs). The size it reports is the one this app then checks.
// `before`: the order as it was shown before the move. On a lost answer a
// re-read that matches it exactly shows nothing (the move would be a no-op
// after flooring), so it is not taken as the move.
export async function mfpModifyOrder(s: Session, key: string, accountId: string, orderId: string, price: number, size: number | null, before: { price: number; size: number } | null = null): Promise<MfpSimpleResult> {
  const w = buildMfpModify(orderId, price, size, newIds("modify").idempotencyKey);
  const res = await send(s, key, w);
  if (res.kind === "ok") {
    const o = parseMfpOrder(mfpData(res.json));
    const took = size !== null && o !== null && o.id === orderId && o.size !== null && mfpSizeFloors(size, o.size) ? o.size : null;
    return { ok: true, message: null, ambiguous: false, size: took };
  }
  if (res.kind === "refused") return { ok: false, message: errText(res.error), ambiguous: false };
  await sleep(VERIFY_DELAY_MS);
  try {
    const now = (await readWorking(key, accountId)).find((o) => o.id === orderId);
    if (!now) return { ok: false, message: "transport: " + res.message + "; the order is gone - check MFP", ambiguous: true };
    const sized = size === null || (now.size !== null && mfpSizeFloors(size, now.size));
    const asBefore = before !== null && now.price !== null && now.size !== null && Math.abs(now.price - before.price) < 1e-9 && Math.abs(now.size - before.size) < 1e-12;
    if (asBefore) return { ok: false, message: "transport: " + res.message + "; the order reads exactly as before the move - check MFP", ambiguous: true };
    const moved = now.price !== null && Math.abs(now.price - price) < 1e-9 && sized;
    return moved ? { ok: true, message: null, ambiguous: true, size: size === null ? null : now.size } : { ok: false, message: "transport: " + res.message + "; the order is unchanged", ambiguous: true };
  } catch {
    return { ok: false, message: "transport: " + res.message + "; could not re-read the venue", ambiguous: true };
  }
}

export async function mfpCancelOrder(s: Session, key: string, accountId: string, orderId: string): Promise<MfpSimpleResult> {
  const w = buildMfpCancel(orderId, newIds("cancel").idempotencyKey);
  const res = await send(s, key, w);
  if (res.kind === "ok") return { ok: true, message: null, ambiguous: false };
  if (res.kind === "refused") return { ok: false, message: errText(res.error), ambiguous: false };
  await sleep(VERIFY_DELAY_MS);
  const still = await orderStillWorking(key, accountId, orderId);
  if (still === null) return { ok: false, message: "transport: " + res.message + "; could not re-read the venue", ambiguous: true };
  return still ? { ok: false, message: "transport: " + res.message + "; the order still works", ambiguous: true } : { ok: true, message: null, ambiguous: true };
}

// Set or replace a position's exits. The caller passes the exits it
// currently sees (the stale-snapshot guard) and the operations.
export async function mfpReplaceExits(
  s: Session, key: string, pos: MfpPosition, expected: { orderId: string; price: number; size: number }[], ops: ExitOp[],
): Promise<MfpSimpleResult> {
  const w = buildMfpExits(pos, expected, ops, newIds("exits").idempotencyKey);
  const res = await send(s, key, w);
  if (res.kind === "ok") return { ok: true, message: null, ambiguous: false };
  if (res.kind === "refused") return { ok: false, message: errText(res.error), ambiguous: false };
  // Ambiguous: the venue's working orders decide; the store's next poll
  // redraws whatever is there. Report it as unproven.
  return { ok: false, message: "transport: " + res.message + "; the exits were re-read, check the chart", ambiguous: true };
}

export type MfpCloseResult = {
  marketId: string;
  basis: number;              // the venue's position size this close was sized on, read just before it
  requested: number;
  order: MfpOrder | null;
  pending: boolean;
  residual: number | null;    // size still open on the market afterwards (0 = flat; null = unread)
  error: string | null;
  ambiguous: boolean;
  clientOrderId: string | null;   // the close order's id (null = nothing was sent)
  refused: boolean;               // the venue itself refused the close (a definite no)
  waited?: boolean;               // its lookup waited out a rate-limit hold: what it says came late
};

async function closeOnce(s: Session, key: string, pre: MfpPosition, size: number | null, slippage: number, kind: "close" | "rev-close", deadlineMs: number, step: (s: MfpStep) => void): Promise<MfpCloseResult> {
  const want = size ?? pre.size;
  const out: MfpCloseResult = { marketId: pre.marketId, basis: pre.size, requested: want, order: null, pending: false, residual: null, error: null, ambiguous: false, clientOrderId: null, refused: false };
  const mid = await readMid(key, pre.marketId);
  if (mid === null) {
    out.error = "no price for " + pre.symbol + " - the close was not sent";
    out.residual = pre.size;
    return out;
  }
  const ids = newIds(kind);
  let w: MfpWrite;
  try {
    w = buildMfpClose(pre, mid, size, slippage, ids.clientOrderId, ids.idempotencyKey);
  } catch (e) {
    out.error = e instanceof Error ? e.message : "could not build the close";
    out.residual = pre.size;
    return out;
  }
  step({ stage: "sent", text: "closing " + want + " " + pre.symbol + " at market" });
  out.clientOrderId = ids.clientOrderId;
  const res = await send(s, key, w);
  if (res.kind === "refused") {
    out.error = errText(res.error);
    out.refused = true;
  } else {
    if (res.kind === "unknown") out.ambiguous = true;
    out.order = res.kind === "ok" ? parseMfpOrder(mfpData(res.json)) : null;
    if (!out.order || !mfpTerminal(out.order.status)) {
      step({ stage: res.kind === "unknown" ? "lost" : "waiting", text: res.kind === "unknown" ? "answer lost (" + res.message + ") - looking the close up, not re-sending" : "waiting for the fill" });
      const note = { waited: false };
      const looked = await resolveOrder(key, pre.accountId, ids.clientOrderId, deadlineMs, note);
      out.waited = note.waited;
      if (looked) out.order = looked;
    }
    if (!out.order) out.error = "no close order found after " + Math.round(deadlineMs / 1000) + " s - check MFP before acting";
    else if (!mfpTerminal(out.order.status)) { out.pending = true; out.error = "close still " + out.order.status + " on MFP"; }
    else if (out.order.status !== "filled") out.error = "close " + out.order.status + (out.order.rejectReason ? ": " + out.order.rejectReason : "");
  }
  step({ stage: "verifying", text: "reading the venue" });
  try {
    const after = await readPositions(key, pre.accountId);
    out.residual = after.filter((p) => p.marketId === pre.marketId).reduce((a, p) => a + p.size, 0);
  } catch {
    out.residual = null;
  }
  return out;
}

// Close `fraction` of ONE position. `shown` is what the UI displayed; the
// venue is re-read first and a changed position is not touched.
export async function mfpClosePosition(s: Session, tradeKey: string, shown: MfpPosition, fraction: number, slippage: number, onStep?: (s: MfpStep) => void): Promise<{ close: MfpCloseResult | null; stopped: string | null }> {
  const step = (s: MfpStep) => onStep && onStep(s);
  step({ stage: "preparing", text: "re-reading the position" });
  let venue: MfpPosition[] | null = null;
  try { venue = await readPositions(tradeKey, shown.accountId); } catch { venue = null; }
  const pre = mfpReversePreCheck(shown, venue);
  if (pre) return { close: null, stopped: pre + "; nothing was sent" };
  const now = (venue as MfpPosition[]).find((p) => p.id === shown.id) as MfpPosition;
  const policy = await readPolicy(tradeKey, shown.accountId);
  let size: number | null = null;
  if (fraction < 1) {
    const raw = now.size * fraction;
    size = now.sizeDecimals !== null ? Math.floor(raw * Math.pow(10, now.sizeDecimals) + 1e-9) / Math.pow(10, now.sizeDecimals) : raw;
    if (!(size > 0)) return { close: null, stopped: "the partial close rounds to nothing; nothing was sent" };
  }
  const close = await closeOnce(s, tradeKey, now, size, slippage, "close", resolveDeadline(policy), step);
  step({ stage: "done", text: "done" });
  return { close, stopped: null };
}

// Cancel every working order on one market (Flat's second half). `live`
// are the orders whose cancel may still land: its answer was lost and the
// re-read did not show the order gone. Those are not failures to report and
// forget; the caller keeps them on the ledger.
export async function mfpCancelMarketOrders(s: Session, key: string, accountId: string, marketId: string): Promise<{ count: number; errors: string[]; live: string[] }> {
  const working = await readWorking(key, accountId);
  const mine = working.filter((o) => o.marketId === marketId);
  const errors: string[] = [];
  const live: string[] = [];
  for (const o of mine) {
    const r = await mfpCancelOrder(s, key, accountId, o.id);
    if (r.ok) continue;
    errors.push(r.message ?? "cancel failed");
    if (r.ambiguous) live.push(o.id);
  }
  return { count: mine.length - errors.length, errors, live };
}

export type MfpOpenResult = {
  requested: number;
  order: MfpOrder | null;
  pending: boolean;
  held: { side: "long" | "short"; size: number } | null;
  heldRead: boolean;
  error: string | null;
  ambiguous: boolean;
  clientOrderId: string | null;   // the opening order's id (null = it was never sent)
};

export type MfpReverseResult = {
  close: MfpCloseResult | null;
  open: MfpOpenResult | null;
  stopped: string | null;
};

// The MFP reverse: leg 2 is sent only when the gate
// passes on readings taken AFTER the account's order cooldown (close
// filled flat; no position and no working order left on the market; the
// account may open), ONCE. An answer lost in transit is looked up, never
// re-sent.
export async function mfpReversePosition(s: Session, tradeKey: string, shown: MfpPosition, slippage: number, maxNotional: number, onStep?: (s: MfpStep) => void): Promise<MfpReverseResult> {
  const step = (s: MfpStep) => onStep && onStep(s);
  const stopBefore = (why: string): MfpReverseResult => ({ close: null, open: null, stopped: why + "; nothing was sent" });
  // A reverse that runs out of requests between its legs ends flat. So it
  // does not start unless the whole sequence fits under the venue's limit
  // on this key right now, and the key is not held by a 429. (A plain close,
  // Flat and cancel are never held back this way.)
  const room = mfpTradeWait(tradeKey, REVERSE_READS);
  // No "try again in N s": on one key the poll shares this budget and room
  // may not come while the app is open. The message promises nothing.
  if (room > 0) return stopBefore("the key has no room this minute for a reverse (about " + REVERSE_READS + " reads under MFP's per-key limit; on one key the poll shares that budget) - close and reopen by hand, or keep a separate Read Only view key for the reads");
  step({ stage: "preparing", text: "re-reading the position, orders and the account's rules" });
  let venue: MfpPosition[] | null = null;
  try { venue = await readPositions(tradeKey, shown.accountId); } catch { venue = null; }
  const pre = mfpReversePreCheck(shown, venue);
  if (pre) return stopBefore(pre);
  const prePos = (venue as MfpPosition[]).find((p) => p.id === shown.id) as MfpPosition;
  const policy = await readPolicy(tradeKey, shown.accountId);
  const blocked = mfpOpeningBlocked(policy);
  if (blocked) return stopBefore(blocked);
  const cooldown = (policy as MfpPolicy).orderCooldownMs;
  if (cooldown > COOLDOWN_CAP_MS) return stopBefore("the account's order cooldown is " + Math.round(cooldown / 1000) + " s - too long to reverse safely");
  let working: MfpOrder[] | null = null;
  try { working = await readWorking(tradeKey, shown.accountId); } catch { working = null; }
  const workBlock = mfpWorkingBlocksReverse(working, prePos.marketId);
  if (workBlock) return stopBefore(workBlock);
  const deadline = resolveDeadline(policy);

  const close = await closeOnce(s, tradeKey, prePos, null, slippage, "rev-close", deadline, step);
  if (close.error || !close.order || close.order.status !== "filled") {
    return { close, open: null, stopped: (close.pending ? "the close is still pending" : "the close did not complete") + "; no opening order was sent" };
  }
  // The close filled, but its answer was only read after a rate-limit wait:
  // the opening leg would go out a minute late, at another price. It is not
  // sent; the account stays flat.
  if (close.waited) return { close, open: null, stopped: "the close was confirmed only after a rate-limit wait; no opening order was sent" };

  await sleep(cooldown + 150);
  step({ stage: "verifying", text: "re-checking the market is flat and clear" });
  let after: MfpPosition[] | null = null;
  let workingAfter: MfpOrder[] | null = null;
  for (let i = 0; i < EXITS_SETTLE_TRIES; i++) {
    // The key is rate limited: a pass now would only be refused. A short
    // hold is waited out (no pass is spent on it); a long one ends the
    // reverse here, closed and not reopened - the same reason a long order
    // cooldown refuses it up front: the opening leg must follow the close
    // closely or not at all.
    const held = holdLeft(tradeKey);
    if (held > COOLDOWN_CAP_MS) return { close, open: null, stopped: "the key is rate limited for another " + Math.ceil(held / 1000) + " s, so the market could not be re-read; no opening order was sent" };
    if (held > 0) await sleep(held + HOLD_PAD_MS);
    try { after = await readPositions(tradeKey, prePos.accountId); } catch { after = null; }
    try { workingAfter = await readWorking(tradeKey, prePos.accountId); } catch { workingAfter = null; }
    const clear = after !== null && workingAfter !== null && !workingAfter.some((o) => o.marketId === prePos.marketId);
    if (clear || i === EXITS_SETTLE_TRIES - 1) break;
    await sleep(EXITS_SETTLE_EVERY_MS);
  }
  const policyAfter = await readPolicy(tradeKey, prePos.accountId);
  const gate = mfpReverseGate({ pre: prePos, close: close.order, venueAfter: after, workingAfter, policy: policyAfter });
  if (!gate.ok) return { close, open: null, stopped: gate.reason + "; no opening order was sent" };

  const open: MfpOpenResult = { requested: gate.size, order: null, pending: false, held: null, heldRead: false, error: null, ambiguous: false, clientOrderId: null };
  step({ stage: "preparing", text: "reading the price for the reverse" });
  const mid = await readMid(tradeKey, prePos.marketId);
  if (mid === null) {
    open.error = "no price for " + prePos.symbol + " - the reverse was not sent";
    return { close, open, stopped: null };
  }
  // Leg 2 OPENS: the market's cap applies to the size and the price it is
  // about to be sent at, not to the mark the reverse was asked on.
  const cap = capRefusal(gate.size, mid, maxNotional);
  if (cap) {
    open.error = cap + " - the opening order was not sent";
    return { close, open, stopped: null };
  }
  const ids = newIds("rev-open");
  let w: MfpWrite;
  try {
    w = buildMfpOrder({
      accountId: prePos.accountId, marketId: prePos.marketId, side: prePos.side === "long" ? "sell" : "buy", type: "market",
      size: gate.size, limitPrice: null, reduceOnly: false, leverage: prePos.leverage, marginMode: prePos.marginMode,
      expectedPrice: mid, slippage, tp: null, sl: null,
    }, ids.clientOrderId, ids.idempotencyKey);
  } catch (e) {
    open.error = e instanceof Error ? e.message : "could not prepare the reverse";
    return { close, open, stopped: null };
  }
  step({ stage: "sent", text: "opening " + (prePos.side === "long" ? "short " : "long ") + gate.size + " " + prePos.symbol });
  open.clientOrderId = ids.clientOrderId;
  const res = await send(s, tradeKey, w);
  if (res.kind === "refused") {
    // A definite no (the venue's, or the session guard's): nothing is in flight.
    open.error = errText(res.error);
  } else {
    if (res.kind === "unknown") open.ambiguous = true;
    open.order = res.kind === "ok" ? parseMfpOrder(mfpData(res.json)) : null;
    if (!open.order || !mfpTerminal(open.order.status)) {
      step({ stage: res.kind === "unknown" ? "lost" : "waiting", text: res.kind === "unknown" ? "answer lost (" + res.message + ") - looking the order up, not re-sending" : "waiting for the fill" });
      const looked = await resolveOrder(tradeKey, prePos.accountId, ids.clientOrderId, deadline);
      if (looked) open.order = looked;
    }
    if (!open.order) {
      // Sent, and the venue has no record of it yet (answer lost, or an
      // answer without an order): it may still appear. Not a refusal.
      open.pending = true;
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
      if (size > gate.size * (1 + 1e-9)) open.error = (open.error ? open.error + "; " : "") + "the venue holds MORE than the reverse asked for - check the position";
    }
  } catch {
    open.heldRead = false;
  }
  step({ stage: "done", text: "done" });
  return { close, open, stopped: null };
}
