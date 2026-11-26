// The app's venue state: both venues' positions, orders, balances and
// history, the market registry, the pending ledger and the action log,
// read by screens through useSyncExternalStore. It owns the clients (real
// or mock), polls each venue, and runs every write through one path:
// register a pending item -> call the client -> record what the venue
// ANSWERED -> re-read the venue -> settle the item only when that re-read
// (or the venue's own status for the order) shows the effect.
//
// The rules live in write_ledger.ts (pure, unit-tested): an answer is a
// claim, never proof; an unresolved write never expires by time; while one
// is unresolved nothing that could add exposure is sent on that market,
// and closing or cancelling stays available. The position / order lists
// always come from the last venue read.
//
// Polling. One timer beats every POLL_MS; each venue is read when its own
// PACE says so. MyFundedPerps counts GETs per key, so its book is read less
// often than Hyperliquid's, one read at a time, and a read the key's budget
// does not allow is skipped and shown ("rate limited, next read in N s":
// the venue client throws a heldError, venue.ts). Nothing is polled while
// the app is hidden or in the background; one read follows on return. The
// re-read after a write is never skipped by the timer's rules: it is asked
// for by the write itself.
//
// A venue with a push channel (VenueClient.watch: MFP's account stream) is
// read when the channel says something changed, and the timer drops to a
// safety pace while the channel is live. A signal carries no venue state:
// it ends in the same read the timer makes, and only that read - begun
// after a write's answer - can settle the write (write_ledger.ts).
import { AppState } from "react-native";

import { capRefusal, checkIntent, closeSize, exitSideOk, oneClickAllowed, reduces } from "./order_policy";
import { midOf, resetTicker, tickerMarketsChanged } from "./ticker_store";
import type { OrderIntent } from "./order_policy";
import { hlVenue } from "./hl_venue";
import { isMock } from "./mode";
import { makeMockVenue, mockSubscribeTicks } from "./mock_venue";
import { mfpVenue } from "./mfp_venue";
import { endSession, STALE_SESSION_TEXT, withClaim } from "./session";
import type { Claim } from "./session";
import { getSettings, marketSettings, settingsReady, subscribeSettings } from "./settings_store";
import type { Balance, HistoryRow, Market, OpenOrder, Position, VenueId, VenueSnapshot, VenueStatus } from "./types";
import { heldUntilOf } from "./venue";
import type { LeverageRead, Lookup, ReadWhy, StepFn, StepPhase, VenueClient, WatchSignal, WriteOutcome, WriteRef } from "./venue";
import { blockedBy, blockText, dismissedExits, onAnswer, onRead, onWatch, signedSize, wantsLeverage, wantsLookup, wantsWatchLookup } from "./write_ledger";
import type { ExitWatch, LogLine, LogState, Pending, PendingKind, Want, WriteClass } from "./write_ledger";

export type { Pending, PendingKind, PendingState } from "./write_ledger";

// The timer's beats. A venue is read on a beat when its PACE is due.
const POLL_MS = 5_000;
const HISTORY_MS = 30_000;
const BALANCE_MS = 15_000;
const MARKETS_MS = 5 * 60_000;
// How often the timer reads each venue's book (positions + orders) and its
// history. `single`: one book read at a time - a beat that finds the last
// one still out is skipped (the venue counts requests).
// MFP, per key and per minute: book 2 GETs x 6 = 12, account 2, policy 1
// (mfp_venue.ts), history 2 GETs x 1 = 2: about 17, against a limit of 60
// (live) or 30 (sandbox). It was 52.
type Pace = { book: number; history: number; single: boolean };
const PACE: Record<VenueId, Pace> = {
  hl: { book: POLL_MS, history: HISTORY_MS, single: false },
  mfp: { book: 10_000, history: 60_000, single: true },
};
// A venue whose push channel is live (VenueClient.watch: MFP's account
// stream) says when something changed, and the store reads it THEN. The
// timer keeps only a safety pace: the book once a minute - every 15 s while
// a position is open there, because the stream carries no mark price or
// PnL and those are read with the book - and the history every 5 minutes
// (plus whenever the stream reports a fill or an order that ended). The
// account is read every 15 s meanwhile (mfp_venue.ts, the balance beat).
// MFP per minute, flat: book 2, account 4, policy 1, history 0.4: about 7.
// With a position open: book 8, account 4, policy 1, history 0.4: about 13.
const WATCHED_BOOK_MS = 60_000;
const WATCHED_BOOK_HELD_MS = 15_000;
const WATCHED_HISTORY_MS = 5 * 60_000;
// Whether each venue's push channel can be relied on right now.
const watched: Record<VenueId, boolean> = { hl: false, mfp: false };
// SETTLEMENT NEVER DEPENDS ON THE PUSH CHANNEL. While a venue has a write
// that is not settled, or a resting entry whose exits are being watched, its
// timer keeps the FULL pace, live channel or not: were the one event that
// tells of the fill missed (the channel's frames are unverified), the write
// would otherwise wait a whole safety pace, with its market locked for new
// exposure meanwhile.
const owesSettlement = (v: VenueId): boolean => state.pending.some((p) => p.venue === v) || exitWatches.some((x) => x.venue === v);
const paceOf = (v: VenueId): Pace => {
  if (!watched[v] || owesSettlement(v)) return PACE[v];
  const holds = (snapshots[v]?.positions.length ?? 0) > 0;
  return { book: holds ? WATCHED_BOOK_HELD_MS : WATCHED_BOOK_MS, history: WATCHED_HISTORY_MS, single: PACE[v].single };
};
// Two reads the store was ASKED for (a push signal, a held read's retry)
// never start closer together than this.
const ASKED_GAP_MS = 1_000;
const ASKED_HISTORY_GAP_MS = 5_000;
// A beat this close to a venue's pace counts as due (timers drift).
const BEAT_SLACK_MS = 500;
// One manual refresh (the status bar's tap) per this long.
const MANUAL_REFRESH_MS = 2_000;
// After a write that is not settled by its first re-read, look again soon
// instead of waiting for the next regular poll.
const FOLLOW_UP_MS = 1_500;
// One question to the venue about one pending write (its order's status, the
// market's leverage) may take this long. A question that never answers must
// not hold the venue's reconcile chain - every other write on that venue
// waits behind it - so it is given up as "no answer", which settles nothing.
const ASK_TIMEOUT_MS = 12_000;

// The answer, or null when it failed or took too long. Never throws.
function ask<T>(p: Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

export type LogEntry = { id: number; at: number; venue: VenueId; text: string; state: LogState };

export type VenueState = {
  mock: boolean;
  markets: Market[];
  marketsAt: number;
  positions: Position[];
  orders: OpenOrder[];
  history: HistoryRow[];
  balances: Record<VenueId, Balance | null>;
  mids: Record<string, number>;      // by market key ("hl:BTC", "mfp:binance|ETHUSDT")
  chg24: Record<string, number>;     // 24h change percent by market key
  status: Record<VenueId, VenueStatus>;
  pending: Pending[];
  log: LogEntry[];
  busy: number;                      // writes in flight
  // An opening write that needs the user's confirm (one-click off): the
  // screen renders it; confirmReverse() / dismissConfirm() settle it.
  confirm: { kind: "reverse"; posKey: string; text: string } | null;
};

const idleStatus = (venue: VenueId): VenueStatus => ({ venue, state: "idle", latencyMs: null, lastAt: null, error: null, heldUntil: null });

let state: VenueState = {
  mock: false, markets: [], marketsAt: 0, positions: [], orders: [], history: [],
  balances: { hl: null, mfp: null }, mids: {}, chg24: {}, status: { hl: idleStatus("hl"), mfp: idleStatus("mfp") },
  pending: [], log: [], busy: 0, confirm: null,
};
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
function set(patch: Partial<VenueState>): void {
  state = { ...state, ...patch };
  emit();
}

export function subscribeVenues(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export const venueState = (): VenueState => state;

const snapshots: Record<VenueId, VenueSnapshot | null> = { hl: null, mfp: null };
const histories: Record<VenueId, HistoryRow[]> = { hl: [], mfp: [] };
let clients: Record<VenueId, VenueClient> = { hl: hlVenue, mfp: mfpVenue };
let started = false;
let mockMode = false;
// The wallet the Hyperliquid reads and the agent key belong to. A change is
// a new session, exactly like a demo / live switch: nothing read, sent or
// left unsettled under the old wallet may be shown, or asked about, under
// the new one.
let trackedWallet = "";
const walletOf = (): string => getSettings().wallet.trim().toLowerCase();
let logId = 0;
// The client generation: bumps when the clients are swapped (demo <-> live).
// A read or a write answer that began under an older generation is dropped,
// never published into the new one.
let gen = 0;
// Reads of one venue can overlap (the interval, a write's re-read, a
// follow-up). Each takes a number when it starts; one that finishes after a
// later-started read has been applied is dropped, so the lists never step
// back in time and a write is never judged on a read older than its answer.
const pollSeq: Record<VenueId, number> = { hl: 0, mfp: 0 };
const appliedSeq: Record<VenueId, number> = { hl: 0, mfp: 0 };

function clientsFor(mock: boolean): Record<VenueId, VenueClient> {
  return mock ? { hl: makeMockVenue("hl"), mfp: makeMockVenue("mfp") } : { hl: hlVenue, mfp: mfpVenue };
}

function merge(): void {
  const positions: Position[] = [];
  const orders: OpenOrder[] = [];
  const mids: Record<string, number> = {};
  const chg24: Record<string, number> = {};
  const balances: Record<VenueId, Balance | null> = { hl: null, mfp: null };
  for (const v of ["hl", "mfp"] as VenueId[]) {
    const s = snapshots[v];
    if (!s) continue;
    positions.push(...s.positions);
    orders.push(...s.orders);
    balances[v] = s.balance;
    for (const [id, px] of Object.entries(s.mids)) mids[v + ":" + id] = px;
    for (const [id, c] of Object.entries(s.chg24)) chg24[v + ":" + id] = c;
  }
  positions.sort((a, b) => b.notional - a.notional);
  const history = [...histories.hl, ...histories.mfp].sort((a, b) => b.time - a.time).slice(0, 400);
  set({ positions, orders, mids, chg24, balances, history });
}

// When each venue's book / history read last STARTED, and how many book
// reads are out. The timer paces itself on these; a write's own re-read
// moves them too (the next timed read follows a full pace after it).
const lastBookAt: Record<VenueId, number> = { hl: 0, mfp: 0 };
const lastHistoryAt: Record<VenueId, number> = { hl: 0, mfp: 0 };
const reading: Record<VenueId, number> = { hl: 0, mfp: 0 };

// why: "tick" = the timer (or a push signal); "settle" = the re-read a write
// asks for, which a venue with a request budget gives more room.
async function pollVenue(v: VenueId, why: ReadWhy = "tick"): Promise<boolean> {
  const c = clients[v];
  const g = gen;
  const seq = ++pollSeq[v];
  lastBookAt[v] = Date.now();
  const ready = await c.ready().catch(() => false);
  if (g !== gen) return false;
  if (!ready) {
    snapshots[v] = null;
    set({ status: { ...state.status, [v]: { venue: v, state: "nokey", latencyMs: null, lastAt: state.status[v].lastAt, error: v === "hl" ? "no wallet address" : "no MFP view key", heldUntil: null } } });
    merge();
    return false;
  }
  const t0 = Date.now();
  let snap: VenueSnapshot;
  reading[v]++;
  try {
    snap = await c.snapshot(why);
  } catch (e) {
    if (g !== gen) return false;
    // Not sent, or refused, for the key's request budget: nothing was learned
    // about the venue. The lists stay as they are; the status says when the
    // next read may go. It is not a venue error.
    const held = heldUntilOf(e);
    if (held !== null) {
      set({ status: { ...state.status, [v]: { ...state.status[v], heldUntil: held } } });
      // Read again when the budget says it may go, not a whole pace later.
      askRead(v, held + 50);
    }
    else set({ status: { ...state.status, [v]: { venue: v, state: "error", latencyMs: null, lastAt: state.status[v].lastAt, error: e instanceof Error ? e.message : "read failed", heldUntil: null } } });
    return false;
  } finally {
    reading[v] = Math.max(0, reading[v] - 1);
    // A read was asked for while this one was out: it is owed one that
    // STARTS after the request, so it cannot miss what the request was about.
    if (g === gen && reading[v] === 0 && asked[v].again) { asked[v].again = false; askRead(v); }
  }
  if (g !== gen || seq < appliedSeq[v]) return false;
  appliedSeq[v] = seq;
  snapshots[v] = snap;
  set({ status: { ...state.status, [v]: { venue: v, state: "ok", latencyMs: Date.now() - t0, lastAt: Date.now(), error: null, heldUntil: null } } });
  merge();
  await reconcile(v, c, snap, t0, g);
  return true;
}

// ---- reads that were asked for ---------------------------------------------
//
// A push signal ("the venue changed") and the retry of a read the budget
// held back both ask for a book read. However many ask, and however close
// together:
// - a request made while a read is out is served by ONE read that starts
//   after it (pollVenue's finally);
// - a request made while one is already scheduled is served by that one;
// - two asked-for reads never start closer than ASKED_GAP_MS, also when the
//   venue was idle;
// - notBefore: not before this time (the moment the budget named).
// A finished read is never thrown away because a newer request came in: it
// is applied, and the request gets its own read. Nothing is asked for while
// the app is hidden; the read on return covers it.
const asked: Record<VenueId, { timer: ReturnType<typeof setTimeout> | null; again: boolean }> = { hl: { timer: null, again: false }, mfp: { timer: null, again: false } };
function askRead(v: VenueId, notBefore = 0): void {
  const a = asked[v];
  if (a.timer) return;
  const now = Date.now();
  if (reading[v] > 0 && notBefore <= now) { a.again = true; return; }
  const g = gen;
  const wait = Math.max(0, lastBookAt[v] + ASKED_GAP_MS - now, notBefore - now);
  a.timer = setTimeout(() => {
    a.timer = null;
    if (g !== gen || !shown) return;
    if (reading[v] > 0) { a.again = true; return; }
    // A write still waiting to be shown gets the roomier class.
    pollVenue(v, state.pending.some((p) => p.venue === v && p.state !== "working") ? "settle" : "tick");
  }, wait);
}
function dropAsked(): void {
  for (const v of ["hl", "mfp"] as VenueId[]) {
    const a = asked[v];
    if (a.timer) clearTimeout(a.timer);
    a.timer = null; a.again = false;
    const h = askedHistory[v];
    if (h) clearTimeout(h);
    askedHistory[v] = null;
  }
}
// The same for the history (a fill, an order that ended, a held read).
const askedHistory: Record<VenueId, ReturnType<typeof setTimeout> | null> = { hl: null, mfp: null };
function askHistory(v: VenueId, notBefore = 0): void {
  if (askedHistory[v]) return;
  const g = gen;
  const now = Date.now();
  const wait = Math.max(0, lastHistoryAt[v] + ASKED_HISTORY_GAP_MS - now, notBefore - now);
  askedHistory[v] = setTimeout(() => {
    askedHistory[v] = null;
    if (g === gen && shown) pollHistory(v);
  }, wait);
}

// What a venue's push channel said (VenueClient.watch). It carries no venue
// state: every signal ends in the same REST read the timer makes, through
// pollVenue -> merge -> reconcile. Nothing here shows or settles anything.
function onWatchSignal(v: VenueId, g: number, signal: WatchSignal): void {
  if (g !== gen) return;
  if (signal === "live") {
    watched[v] = true;
    // One read as the channel goes live: what changed between the app's
    // last read and the channel's own start was pushed to nobody.
    askRead(v);
  } else if (signal === "down") {
    watched[v] = false;      // the timer is back at its full pace from the next beat
  } else if (signal === "history") {
    askHistory(v);
  } else {
    askRead(v);              // "state", "resync": the book is always read whole
  }
}
let stopWatches: (() => void)[] = [];
function startWatches(): void {
  for (const stop of stopWatches) stop();
  stopWatches = [];
  watched.hl = false; watched.mfp = false;
  const g = gen;
  for (const v of ["hl", "mfp"] as VenueId[]) {
    const c = clients[v];
    if (c.watch) stopWatches.push(c.watch((signal) => onWatchSignal(v, g, signal)));
  }
}

// The balance alone, for a venue that reads it apart from its book (MFP).
// It never touches the positions or the orders, and settles nothing.
async function pollBalance(v: VenueId): Promise<void> {
  const c = clients[v];
  if (!c.balance) return;
  const g = gen;
  let b: Balance | null;
  try { b = await c.balance(); } catch { return; }
  const snap = snapshots[v];
  if (g !== gen || !b || !snap) return;
  snapshots[v] = { ...snap, balance: b };
  merge();
}

// ---- the pending ledger: settling writes against venue reads --------------

// How a write that run() is waiting on was settled (read once by run()).
const settled = new Map<string, LogLine>();
const watching = new Set<string>();
// Resting entries whose attached exits are checked when they fill
// (write_ledger.ts ExitWatch). Not pending writes: they lock nothing.
let exitWatches: ExitWatch[] = [];
const chain: Record<VenueId, Promise<void>> = { hl: Promise.resolve(), mfp: Promise.resolve() };

// One venue read is checked against that venue's unresolved writes. Passes
// run one after another per venue, so two overlapping reads cannot settle
// (or log) the same write twice.
function reconcile(v: VenueId, client: VenueClient, snap: VenueSnapshot, startedAt: number, g: number): Promise<void> {
  const job = chain[v].then(() => reconcileNow(v, client, snap, startedAt, g)).catch(() => undefined);
  chain[v] = job;
  return job;
}

// When each unsettled write (or watched entry) was last asked about. A venue
// that caps the lookups of one pass (client.maxLookups: each is a request
// against its budget) asks about the ones that have waited longest, so
// several unsettled writes take turns and none is starved.
const lookedAt = new Map<string, number>();
let lookSeq = 0;

async function reconcileNow(v: VenueId, client: VenueClient, snap: VenueSnapshot, startedAt: number, g: number): Promise<void> {
  const view = { positions: snap.positions, orders: snap.orders };
  const ids = state.pending.filter((p) => p.venue === v && p.state !== "working").map((p) => p.id);
  // Who may be asked about on this pass. No lookup is "no answer yet": it
  // settles nothing either way (write_ledger.ts onRead / onWatch).
  let turn: Map<string, Lookup | null> | null = null;
  if (client.maxLookups !== undefined) {
    const wanting = [
      ...state.pending.filter((p) => p.venue === v && p.ref && wantsLookup(p, view, startedAt)).map((p) => p.id),
      ...exitWatches.filter((x) => x.venue === v && x.ref && wantsWatchLookup(x, view)).map((x) => x.id),
    ];
    wanting.sort((a, b) => (lookedAt.get(a) ?? 0) - (lookedAt.get(b) ?? 0));
    const chosen = wanting.slice(0, Math.max(0, client.maxLookups));
    for (const id of [...lookedAt.keys()]) if (!wanting.includes(id)) lookedAt.delete(id);
    // The chosen ones are asked about HERE, in the order they were chosen
    // (the one that has waited longest first), not in the order the loops
    // below reach them: when the budget lets only one look out, it is the
    // longest-waiting one's. A look that did not go out (held) is not a turn
    // taken: that write stays first in line.
    turn = new Map();
    for (const id of chosen) {
      if (g !== gen) return;
      const ref = state.pending.find((p) => p.id === id)?.ref ?? exitWatches.find((x) => x.id === id)?.ref ?? null;
      if (!ref) continue;
      const lookup = await ask(client.lookup(ref));
      turn.set(id, lookup);
      if (!(lookup && lookup.held)) lookedAt.set(id, ++lookSeq);
    }
  }
  // The look for one item: already made above (a capped venue), or made now.
  const lookFor = async (id: string, ref: WriteRef): Promise<Lookup | null> => {
    if (!turn) return ask(client.lookup(ref));
    return turn.get(id) ?? null;
  };
  for (const id of ids) {
    if (g !== gen) return;
    const item = state.pending.find((p) => p.id === id);
    if (!item || item.state === "working") continue;
    // A single order the read does not show yet: ask the venue about it by
    // the id this app gave it (a read; nothing is ever resent).
    let lookup: Lookup | null = null;
    if (item.ref && wantsLookup(item, view, startedAt)) lookup = await lookFor(id, item.ref);
    // A leverage change on a market with no position: the position list
    // cannot show it, so the venue's own setting for the market is read.
    let leverage: LeverageRead | null = null;
    if (wantsLeverage(item, view)) {
      const m = marketByKey(v + ":" + item.marketId);
      if (m) leverage = await ask(client.leverage(m));
    }
    if (g !== gen) return;
    const cur = state.pending.find((p) => p.id === id);   // it may have been dismissed while the lookup ran
    if (!cur) continue;
    const r = onRead(cur, { view, startedAt, lookup, leverage, now: Date.now() }, nextPendingId);
    if (r.item === cur) continue;
    if (r.log) log(v, r.log.text, r.log.state);
    for (const l of r.logs) log(v, l.text, l.state);
    if (!r.item && r.log && watching.has(id)) settled.set(id, r.log);
    // An entry that settled as filled hands over the exits attached to it:
    // each becomes its own pending item, verified by a later read.
    const rest = r.item ? state.pending.map((p) => (p.id === id ? (r.item as Pending) : p)) : state.pending.filter((p) => p.id !== id);
    set({ pending: [...rest, ...r.legs] });
    if (r.watch) exitWatches = [...exitWatches, r.watch];
  }
  // Resting entries with exits attached: once one has left the book, the
  // venue's status for it says whether it filled; its exits are then
  // verified like any other.
  for (const w of exitWatches.filter((x) => x.venue === v)) {
    if (g !== gen) return;
    let lookup: Lookup | null = null;
    if (w.ref && wantsWatchLookup(w, view)) lookup = await lookFor(w.id, w.ref);
    if (g !== gen) return;
    const r = onWatch(w, { view, lookup, now: Date.now() }, nextPendingId);
    if (r.keep) continue;
    exitWatches = exitWatches.filter((x) => x.id !== w.id);
    for (const l of r.logs) log(v, l.text, l.state);
    if (r.legs.length) set({ pending: [...state.pending, ...r.legs] });
  }
}

async function pollHistory(v: VenueId): Promise<void> {
  const g = gen;
  lastHistoryAt[v] = Date.now();
  try {
    if (!(await clients[v].ready())) return;
    const rows = await clients[v].history();
    if (g !== gen) return;
    histories[v] = rows;
    merge();
  } catch (e) {
    // History is display only. A read that failed, or that the key's budget
    // did not allow, leaves the rows that are there. A failed one is tried
    // again on the next pass; a held one when the budget says it may go.
    const held = heldUntilOf(e);
    if (held !== null && g === gen) askHistory(v, held + 50);
  }
}

async function loadMarkets(): Promise<void> {
  const g = gen;
  const lists = await Promise.all((["hl", "mfp"] as VenueId[]).map((v) => clients[v].markets().catch(() => [] as Market[])));
  if (g !== gen) return;
  const markets = [...lists[0], ...lists[1]];
  if (markets.length) { set({ markets, marketsAt: Date.now() }); tickerMarketsChanged(); }
}

let timers: ReturnType<typeof setInterval>[] = [];
let stopTick: (() => void) | null = null;
const VENUES: VenueId[] = ["hl", "mfp"];

// Hidden (a browser tab that is not shown) or in the background (Android):
// nobody is looking, so nothing is polled. A write still re-reads the venue
// itself; the timers only skip their beats.
const isShown = (s: string | null | undefined): boolean => s !== "background" && s !== "inactive";
let shown = isShown(AppState.currentState);
let watchingApp = false;

// One beat of the book timer: each venue whose pace is due is read, unless
// its last read is still out (a venue that takes one read at a time).
function bookBeat(): void {
  if (!shown) return;
  const now = Date.now();
  for (const v of VENUES) {
    const pace = paceOf(v);
    if (pace.single && reading[v] > 0) continue;
    if (pace.book > POLL_MS && now - lastBookAt[v] < pace.book - BEAT_SLACK_MS) continue;
    // While a write is unsettled the book read is the one that can settle
    // it: it gets the "settle" room, so the lookups and the account (which
    // only get the background share) cannot crowd it out of a tight budget.
    pollVenue(v, owesSettlement(v) ? "settle" : "tick");
  }
}

function historyBeat(): void {
  if (!shown) return;
  const now = Date.now();
  for (const v of VENUES) {
    if (now - lastHistoryAt[v] < paceOf(v).history - BEAT_SLACK_MS) continue;
    pollHistory(v);
  }
}

function balanceBeat(): void {
  if (!shown) return;
  for (const v of VENUES) pollBalance(v);
}

function startPolling(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
  if (stopTick) { stopTick(); stopTick = null; }
  dropAsked();
  refreshAll();
  loadMarkets();
  pollHistory("hl"); pollHistory("mfp");
  startWatches();
  timers.push(setInterval(bookBeat, POLL_MS));
  timers.push(setInterval(historyBeat, HISTORY_MS));
  timers.push(setInterval(balanceBeat, BALANCE_MS));
  timers.push(setInterval(loadMarkets, MARKETS_MS));
  if (mockMode) stopTick = mockSubscribeTicks(() => { if (snapshots.hl || snapshots.mfp) refreshAll(); });
  if (!watchingApp) {
    watchingApp = true;
    AppState.addEventListener("change", (s) => {
      const now = isShown(s);
      if (now === shown) return;
      shown = now;
      // Back in view: one read of everything, then the timers carry on.
      if (shown && started) { refreshAll(); historyBeat(); }
    });
  }
}

// Read both venues now (a background read: a venue with a request budget
// may still decline it).
export function refreshAll(): void {
  pollVenue("hl");
  pollVenue("mfp");
}

// The status bar's tap. At most one per MANUAL_REFRESH_MS: a run of taps
// costs one read, not one each.
let lastManualAt = 0;
export function manualRefresh(): void {
  const now = Date.now();
  if (now - lastManualAt < MANUAL_REFRESH_MS) return;
  lastManualAt = now;
  refreshAll();
}

export async function startVenues(): Promise<void> {
  if (started) return;
  started = true;
  await settingsReady();
  mockMode = isMock();
  trackedWallet = walletOf();
  clients = clientsFor(mockMode);
  set({ mock: mockMode });
  startPolling();
  // Demo toggle or a wallet change: a new session. Rebuild the clients,
  // drop everything of the old one and re-poll.
  subscribeSettings(() => {
    const m = isMock();
    const w = walletOf();
    if (m !== mockMode || w !== trackedWallet) {
      const why = m !== mockMode ? (m ? "demo was switched on" : "demo was switched off") : "the tracked wallet changed";
      const wasLive = !mockMode;
      const dropped = state.pending;
      const unwatched = exitWatches;
      exitWatches = [];
      mockMode = m;
      trackedWallet = w;
      gen++;
      // Every write that began before this line is now stale: the exchange
      // clients refuse to sign or send for it (session.ts), whatever it was
      // waiting on - a key prompt, a read, the first leg of a sequence.
      endSession();
      clients = clientsFor(m);
      snapshots.hl = null; snapshots.mfp = null; histories.hl = []; histories.mfp = [];
      reading.hl = 0; reading.mfp = 0;
      lookedAt.clear();
      // Nothing of the old mode may be shown, or priced from, in the new one:
      // the lists, the balances, the marks and the live ticker all start empty.
      set({ mock: m, markets: [], positions: [], orders: [], history: [], pending: [], mids: {}, chg24: {}, balances: { hl: null, mfp: null }, confirm: null });
      // Writes that were unsettled on a real venue are still unsettled there.
      // This screen no longer follows them: say so, one line each.
      if (wasLive) for (const p of dropped) log(p.venue, p.label + ": no longer followed here (" + why + "; it was: " + p.text + ") - check the venue", "unknown");
      if (wasLive) for (const w of unwatched) log(w.venue, w.label + ": the exits attached to this resting order are no longer followed here (" + why + ") - check them when it fills", "unknown");
      resetTicker();
      startPolling();
    }
  });
}

// Keys entered in Settings (web session) or a wallet change: re-poll now.
export function venuesChanged(): void {
  if (!started) return;
  refreshAll();
  pollHistory("hl"); pollHistory("mfp");
  loadMarkets();
  // A key may have been stored, changed or removed: each client starts its
  // push channel over IF the key or account it runs on changed. Saving
  // something else (the wallet, the Hyperliquid key) leaves a live channel
  // alone, and does not give a key the venue rejected one more try.
  for (const v of VENUES) {
    const c = clients[v];
    if (c.rewatch) Promise.resolve(c.rewatch()).catch(() => undefined);
  }
}

// ---- lookups ---------------------------------------------------------------

export const marketByKey = (key: string | null): Market | null => (key ? state.markets.find((m) => m.key === key) ?? null : null);
export const positionByKey = (key: string): Position | null => state.positions.find((p) => p.key === key) ?? null;
export const orderByKey = (key: string): OpenOrder | null => state.orders.find((o) => o.key === key) ?? null;
export const positionsOn = (chartCoin: string): Position[] => state.positions.filter((p) => p.chartCoin === chartCoin);
export const ordersOn = (venue: VenueId, marketId: string): OpenOrder[] => state.orders.filter((o) => o.venue === venue && o.marketId === marketId);
// The freshest mark: the live stream's mid for a Hyperliquid market, the
// venue's own mark for an MFP market, each falling back to the other.
export const markFor = (m: Market | null): number | null => {
  if (!m) return null;
  const live = midOf(m.chartCoin);
  if (m.venue === "hl") return live ?? state.mids[m.key] ?? null;
  return state.mids[m.key] ?? live ?? null;
};

// A position's TP / SL: the reduce-only triggers resting on its market.
export function exitsFor(p: Position): { tp: OpenOrder | null; sl: OpenOrder | null } {
  let tp: OpenOrder | null = null, sl: OpenOrder | null = null;
  const closing = p.side === "long" ? "sell" : "buy";
  for (const o of state.orders) {
    if (o.venue !== p.venue || o.marketId !== p.marketId || !o.reduceOnly || o.side !== closing) continue;
    if (o.kind === "tp" && !tp) tp = o;
    if (o.kind === "sl" && !sl) sl = o;
  }
  return { tp, sl };
}

// ---- writes ----------------------------------------------------------------

function log(venue: VenueId, text: string, st: LogState): void {
  const entry: LogEntry = { id: ++logId, at: Date.now(), venue, text, state: st };
  set({ log: [entry, ...state.log].slice(0, 60) });
}

let pendingSeq = 0;
const nextPendingId = (): string => "p" + ++pendingSeq;

// The lock (write_ledger.ts blockedBy). A write in flight on a market
// blocks everything on it: a second tap is refused here, not just by a
// disabled button (on Android the button's disabled state lags the bridge).
// An UNRESOLVED write (answered but not yet shown by the venue, or its
// answer lost) blocks only what could add exposure or re-arrange orders;
// closing and cancelling stay available.
function gate(venue: VenueId, marketId: string, cls: WriteClass): WriteOutcome | null {
  const b = blockedBy(state.pending, venue, marketId, cls);
  if (!b) return null;
  const message = blockText(b);
  if (b.state !== "working") log(venue, "refused: " + message, "rejected");
  return { state: "rejected", message, ambiguous: false };
}

// Which of a market's controls the pending ledger locks right now (the UI
// mirrors the store's gate; the store still refuses on its own).
export function marketLocks(pending: Pending[], venue: VenueId, marketId: string): { reduce: boolean; open: boolean } {
  return { reduce: blockedBy(pending, venue, marketId, "reduce") !== null, open: blockedBy(pending, venue, marketId, "open") !== null };
}

type NewPending = { venue: VenueId; marketId: string; symbol: string; kind: PendingKind; side: "buy" | "sell" | null; price: number | null; size: number | null; label: string; text: string; orderKey: string | null; posKey: string | null; want: Want };

// The write's claim on its market (session.ts). Every write the user starts
// on a market takes the next number for that market; a write may send a
// later leg only while its number is still the market's newest. A Close,
// Flat or Cancel accepted while it waited takes a newer one, and the waiting
// write's next leg is refused at the exchange client's last line.
const marketTurn = new Map<string, number>();
const turnOf = new Map<string, number>();   // pending id -> the market number it took
export const MARKET_TAKEN_TEXT = "another write on this market started while this one was waiting; nothing more of this one was sent - check the position and orders";
function addPending(p: NewPending): Pending {
  const item: Pending = { ...p, id: nextPendingId(), since: Date.now(), state: "working", expects: [], ref: null, deadAfter: null, answeredAt: null, claim: null, note: null, exits: [] };
  const mk = p.venue + ":" + p.marketId;
  const turn = (marketTurn.get(mk) ?? 0) + 1;
  marketTurn.set(mk, turn);
  turnOf.set(item.id, turn);
  set({ pending: [...state.pending, item], busy: state.busy + 1 });
  return item;
}
function claimFor(item: Pending): Claim {
  const mk = item.venue + ":" + item.marketId;
  const mine = turnOf.get(item.id);
  return () => (marketTurn.get(mk) === mine ? null : MARKET_TAKEN_TEXT);
}

const signedOn = (venue: VenueId, marketId: string): number => signedSize({ positions: state.positions, orders: [] }, venue, marketId);
const orderKeysOn = (venue: VenueId, marketId: string): string[] => ordersOn(venue, marketId).map((o) => o.key);

async function run(item: Pending, call: (step: StepFn) => Promise<WriteOutcome>): Promise<WriteOutcome> {
  const g = gen;
  // A write that outlived its session (demo <-> live) publishes nothing
  // into the new one: not its progress lines, not its answer.
  // A step with a phase says the request is out and the client is only
  // waiting (a lost answer's payload to expire, the venue to finish). The
  // write then stops counting as in flight: Close, Flat and Cancel are free,
  // new exposure stays locked. A step without one puts it back in flight;
  // whether it may SEND again is the claim's call, made at the exchange
  // client's last line before the send (claimFor, session.ts).
  const step =(t: string, phase?: StepPhase) => {
    if (g !== gen) return;
    log(item.venue, t, "step");
    const st: Pending["state"] = phase === "lost" ? "unknown" : phase === "placed" ? "verifying" : "working";
    set({ pending: state.pending.map((p) => (p.id === item.id ? { ...p, text: t, state: st } : p)) });
  };
  let out: WriteOutcome;
  try {
    // The adapter captures the session (with this write's claim) before its
    // first await, i.e. inside this synchronous start.
    out = await withClaim(claimFor(item), () => call(step));
  } catch (e) {
    out = { state: "unknown", message: e instanceof Error ? e.message : "failed", ambiguous: true };
  }
  turnOf.delete(item.id);
  if (g !== gen) {
    // The clients were swapped under this write (demo <-> live): the ledger
    // was reset with them, and the exchange clients refused every send that
    // had not gone out yet. What had already gone out is on the venue and
    // not on this screen: say exactly that, and publish nothing.
    set({ busy: Math.max(0, state.busy - 1) });
    return { state: "unknown", message: STALE_SESSION_TEXT + " - check the venue for what had already been sent", ambiguous: true };
  }
  // What the venue answered is recorded; nothing is shown as done yet.
  const a = onAnswer(item, out, Date.now(), nextPendingId);
  for (const l of a.logs) log(item.venue, l.text, l.state);
  const rest = state.pending.filter((p) => p.id !== item.id);
  set({ pending: [...rest, ...(a.item ? [a.item] : []), ...a.legs], busy: Math.max(0, state.busy - 1) });
  if (a.item) watching.add(item.id);
  // The venue is the truth: re-read at once and let that read settle it.
  await pollVenue(item.venue, "settle");
  const fin = settled.get(item.id);
  settled.delete(item.id);
  watching.delete(item.id);
  if (state.pending.some((p) => p.venue === item.venue && p.state !== "working")) {
    const v = item.venue;
    setTimeout(() => { pollVenue(v, "settle"); }, FOLLOW_UP_MS);
  }
  if (!a.item) return out;
  if (fin) return { state: fin.state === "confirmed" ? "confirmed" : fin.state === "partial" ? "partial" : "rejected", message: fin.text, ambiguous: out.ambiguous };
  const still = state.pending.find((p) => p.id === item.id);
  if (still) return { state: still.state === "unknown" ? "unknown" : "pending", message: still.text, ambiguous: out.ambiguous };
  return out;
}

// The user checked the venue and clears an unresolved write. A write that
// is still in flight, or whose call has not come back yet (it is waiting out
// a lost answer), cannot be dismissed: it would only come back.
export const canDismiss = (p: Pending): boolean => p.state !== "working" && p.answeredAt !== null;
export function dismissPending(id: string): void {
  const p = state.pending.find((x) => x.id === id);
  if (!p || !canDismiss(p)) return;
  log(p.venue, p.label + ": dismissed by you (was: " + p.text + ")", "unknown");
  // Exits attached to a dismissed entry were never seen: say so, each one.
  for (const l of dismissedExits(p)) log(p.venue, l.text, l.state);
  set({ pending: state.pending.filter((x) => x.id !== id) });
}

export async function placeOrder(raw: OrderIntent, market: Market): Promise<WriteOutcome> {
  const mark = markFor(market);
  const pos = state.positions.find((p) => p.venue === market.venue && p.marketId === market.id) ?? null;
  const lite = pos ? { side: pos.side, size: pos.size } : null;
  // A reducing intent is sent reduce-only, always: the cap is waived for it
  // precisely because the venue can then never let it open or flip.
  const reducing = reduces(raw, lite);
  const intent: OrderIntent = reducing ? { ...raw, reduceOnly: true } : raw;
  const blocked = gate(market.venue, market.id, reducing ? "reduce" : "open");
  if (blocked) return blocked;
  const check = checkIntent(intent, { mark, position: lite, settings: marketSettings(market.key), szDecimals: market.szDecimals });
  if (!check.ok) {
    log(market.venue, "refused: " + check.reason, "rejected");
    return { state: "rejected", message: check.reason, ambiguous: false };
  }
  const price = intent.type === "limit" ? intent.price : null;
  const label = intent.side.toUpperCase() + " " + intent.size + " " + market.symbol + (price !== null ? " limit " + price : "");
  const item = addPending({
    venue: market.venue, marketId: market.id, symbol: market.symbol, kind: "order", side: intent.side, price, size: intent.size, label,
    text: "sending " + intent.side + " " + intent.size + " " + market.symbol, orderKey: null, posKey: null,
    want: { kind: "order", side: intent.side, type: intent.type, size: intent.size, price, from: signedOn(market.venue, market.id), before: orderKeysOn(market.venue, market.id) },
  });
  return run(item, (step) => clients[market.venue].placeOrder(intent, market, mark, step));
}

export async function closePosition(posKey: string, fraction: number): Promise<WriteOutcome> {
  const pos = positionByKey(posKey);
  if (!pos) return { state: "rejected", message: "no such position", ambiguous: false };
  const blocked = gate(pos.venue, pos.marketId, "reduce");
  if (blocked) return blocked;
  const m = marketByKey(pos.venue + ":" + pos.marketId);
  const size = closeSize(pos, fraction, m?.szDecimals ?? (pos.ref.kind === "mfp" ? pos.ref.sizeDecimals : null));
  if (!(size > 0)) return { state: "rejected", message: "that fraction rounds to nothing", ambiguous: false };
  const slippage = marketSettings(pos.venue + ":" + pos.marketId).slippage;
  const pct = Math.round(fraction * 100);
  const item = addPending({
    venue: pos.venue, marketId: pos.marketId, symbol: pos.symbol, kind: "close", side: pos.side === "long" ? "sell" : "buy", price: null, size,
    label: "close " + pct + "% " + pos.symbol, text: "closing " + pct + "% of " + pos.symbol, orderKey: null, posKey,
    want: { kind: "close", side: pos.side, from: pos.size, size },
  });
  return run(item, (step) => clients[pos.venue].closePosition(pos, fraction, slippage, step));
}

export async function flatPosition(posKey: string): Promise<WriteOutcome> {
  const pos = positionByKey(posKey);
  if (!pos) return { state: "rejected", message: "no such position", ambiguous: false };
  const blocked = gate(pos.venue, pos.marketId, "reduce");
  if (blocked) return blocked;
  const slippage = marketSettings(pos.venue + ":" + pos.marketId).slippage;
  const item = addPending({
    venue: pos.venue, marketId: pos.marketId, symbol: pos.symbol, kind: "flat", side: pos.side === "long" ? "sell" : "buy", price: null, size: pos.size,
    label: "flat " + pos.symbol, text: "flattening " + pos.symbol, orderKey: null, posKey,
    want: { kind: "flat", side: pos.side },
  });
  return run(item, (step) => clients[pos.venue].flat(pos, slippage, step));
}

// Reverse: leg 2 is an OPENING order, so the market's cap applies and,
// with One-click trading off, the user confirms first (the screen renders
// state.confirm; confirmReverse sends).
export async function reversePosition(posKey: string, confirmed = false): Promise<WriteOutcome> {
  const pos = positionByKey(posKey);
  if (!pos) return { state: "rejected", message: "no such position", ambiguous: false };
  const blocked = gate(pos.venue, pos.marketId, "open");
  if (blocked) return blocked;
  const mark = markFor(marketByKey(pos.venue + ":" + pos.marketId)) ?? pos.mark ?? pos.entry;
  const ms = marketSettings(pos.venue + ":" + pos.marketId);
  const notional = pos.size * mark;
  if (notional > ms.maxNotional + 1e-9) {
    const reason = "reverse would open $" + Math.round(notional) + ", above this market's max $" + ms.maxNotional;
    log(pos.venue, "refused: " + reason, "rejected");
    return { state: "rejected", message: reason, ambiguous: false };
  }
  if (!confirmed && !oneClickAllowed(getSettings().oneClick, false, notional, ms)) {
    set({ confirm: { kind: "reverse", posKey, text: "Close the " + pos.side + " " + pos.size + " " + pos.symbol + " on " + (pos.venue === "hl" ? "Hyperliquid" : "MyFundedPerps") + ", then open a " + (pos.side === "long" ? "short" : "long") + " of the same size (about $" + Math.round(notional) + ") once the venue reads flat." } });
    return { state: "pending", message: "confirm the reverse", ambiguous: false };
  }
  const slippage = marketSettings(pos.venue + ":" + pos.marketId).slippage;
  const item = addPending({
    venue: pos.venue, marketId: pos.marketId, symbol: pos.symbol, kind: "reverse", side: pos.side === "long" ? "sell" : "buy", price: null, size: pos.size,
    label: "reverse " + pos.symbol, text: "reversing " + pos.symbol, orderKey: null, posKey,
    want: { kind: "reverse", side: pos.side === "long" ? "short" : "long" },
  });
  // The cap is checked again by the venue client on the opening leg itself.
  return run(item, (step) => clients[pos.venue].reverse(pos, slippage, step, ms.maxNotional));
}

export function dismissConfirm(): void { set({ confirm: null }); }
export async function confirmReverse(): Promise<WriteOutcome> {
  const c = state.confirm;
  set({ confirm: null });
  if (!c) return { state: "rejected", message: "nothing to confirm", ambiguous: false };
  return reversePosition(c.posKey, true);
}

export async function cancelOrder(orderKey: string): Promise<WriteOutcome> {
  const o = orderByKey(orderKey);
  if (!o) return { state: "rejected", message: "no such order", ambiguous: false };
  const blocked = gate(o.venue, o.marketId, "reduce");
  if (blocked) return blocked;
  const item = addPending({
    venue: o.venue, marketId: o.marketId, symbol: o.symbol, kind: "cancel", side: o.side, price: o.price, size: o.size,
    label: "cancel " + o.kind + " " + o.symbol, text: "cancelling " + o.kind + " on " + o.symbol, orderKey, posKey: null,
    want: { kind: "cancel", orderKey },
  });
  return run(item, () => clients[o.venue].cancelOrder(o));
}

export async function modifyOrder(orderKey: string, price: number, size: number | null): Promise<WriteOutcome> {
  const o = orderByKey(orderKey);
  if (!o) return { state: "rejected", message: "no such order", ambiguous: false };
  if (!(price > 0)) return { state: "rejected", message: "price must be positive", ambiguous: false };
  const blocked = gate(o.venue, o.marketId, "open");
  if (blocked) return blocked;
  // A moved order that is not reduce-only can open or add exposure: the
  // market's cap applies to what it becomes (new price, new size).
  if (!o.reduceOnly) {
    const cap = capRefusal(size ?? o.size, price, marketSettings(o.venue + ":" + o.marketId).maxNotional);
    if (cap) {
      log(o.venue, "refused: the moved order's " + cap, "rejected");
      return { state: "rejected", message: "the moved order's " + cap, ambiguous: false };
    }
  }
  const m = marketByKey(o.venue + ":" + o.marketId);
  const mark = markFor(m);
  if (o.kind === "tp" || o.kind === "sl") {
    const pos = state.positions.find((p) => p.venue === o.venue && p.marketId === o.marketId) ?? null;
    if (!pos) return { state: "rejected", message: "no position for that " + o.kind, ambiguous: false };
    if (mark === null) return { state: "rejected", message: "no mark to check the " + o.kind + " side", ambiguous: false };
    if (!exitSideOk(o.kind, pos.side, price, mark)) return { state: "rejected", message: "a " + o.kind + " for a " + pos.side + " must be " + ((o.kind === "tp") === (pos.side === "long") ? "above" : "below") + " the mark (" + +mark.toPrecision(6) + ")", ambiguous: false };
  }
  const item = addPending({
    venue: o.venue, marketId: o.marketId, symbol: o.symbol, kind: "modify", side: o.side, price, size: size ?? o.size,
    label: "move " + o.kind + " " + o.symbol + " to " + price, text: "moving " + o.kind + " on " + o.symbol + " to " + price, orderKey, posKey: null,
    want: { kind: "modify", orderKey, side: o.side, orderKind: o.kind, price, size, fromPrice: o.price, before: orderKeysOn(o.venue, o.marketId) },
  });
  return run(item, () => clients[o.venue].modifyOrder(o, price, size, mark));
}

export async function setExit(posKey: string, kind: "tp" | "sl", price: number): Promise<WriteOutcome> {
  const pos = positionByKey(posKey);
  if (!pos) return { state: "rejected", message: "no such position", ambiguous: false };
  const blocked = gate(pos.venue, pos.marketId, "open");
  if (blocked) return blocked;
  const existing = exitsFor(pos)[kind];
  const mark = markFor(marketByKey(pos.venue + ":" + pos.marketId)) ?? pos.mark;
  if (mark === null) return { state: "rejected", message: "no mark to check the " + kind + " side", ambiguous: false };
  if (!exitSideOk(kind, pos.side, price, mark)) {
    const reason = "a " + kind + " for a " + pos.side + " must be " + ((kind === "tp") === (pos.side === "long") ? "above" : "below") + " the mark (" + +mark.toPrecision(6) + ")";
    log(pos.venue, "refused: " + reason, "rejected");
    return { state: "rejected", message: reason, ambiguous: false };
  }
  const closingSide = pos.side === "long" ? "sell" : "buy";
  const shown = +price.toPrecision(6);
  const item = addPending({
    venue: pos.venue, marketId: pos.marketId, symbol: pos.symbol, kind, side: closingSide, price, size: pos.size,
    label: kind + " " + pos.symbol + " at " + shown, text: (existing ? "moving " : "placing ") + kind + " on " + pos.symbol + " at " + shown, orderKey: existing?.key ?? null, posKey,
    want: { kind: "exit", exit: kind, side: closingSide, price, fromPrice: existing ? existing.price : null, orderKey: existing?.key ?? null, before: orderKeysOn(pos.venue, pos.marketId) },
  });
  return run(item, (step) => clients[pos.venue].setExit(pos, kind, price, existing, mark, step));
}

export async function cancelExit(posKey: string, kind: "tp" | "sl"): Promise<WriteOutcome> {
  const pos = positionByKey(posKey);
  if (!pos) return { state: "rejected", message: "no such position", ambiguous: false };
  const existing = exitsFor(pos)[kind];
  if (!existing) return { state: "rejected", message: "no " + kind + " to cancel", ambiguous: false };
  const blocked = gate(pos.venue, pos.marketId, "reduce");
  if (blocked) return blocked;
  const item = addPending({
    venue: pos.venue, marketId: pos.marketId, symbol: pos.symbol, kind: "cancel-exit", side: existing.side, price: existing.price, size: existing.size,
    label: "cancel " + kind + " " + pos.symbol, text: "cancelling " + kind + " on " + pos.symbol, orderKey: existing.key, posKey,
    want: { kind: "cancel", orderKey: existing.key },
  });
  return run(item, () => clients[pos.venue].cancelExit(pos, existing));
}

export async function setLeverage(marketKey: string, leverage: number, isCross: boolean): Promise<WriteOutcome> {
  const m = marketByKey(marketKey);
  if (!m) return { state: "rejected", message: "no such market", ambiguous: false };
  const blocked = gate(m.venue, m.id, "open");
  if (blocked) return blocked;
  const mode = isCross ? "cross" : "isolated";
  const item = addPending({
    venue: m.venue, marketId: m.id, symbol: m.symbol, kind: "leverage", side: null, price: null, size: null,
    label: leverage + "x " + mode + " " + m.symbol, text: "setting " + leverage + "x " + mode + " on " + m.symbol, orderKey: null, posKey: null,
    want: { kind: "leverage", leverage, marginMode: mode },
  });
  return run(item, () => clients[m.venue].setLeverage(m, leverage, isCross));
}

// Does this intent only reduce the position on its market? (the UI's
// one-click rule reads it)
export function intentReduces(intent: OrderIntent, market: Market): boolean {
  const pos = state.positions.find((p) => p.venue === market.venue && p.marketId === market.id) ?? null;
  return reduces(intent, pos ? { side: pos.side, size: pos.size } : null);
}

export async function tradeBlocked(venue: VenueId): Promise<string | null> {
  return clients[venue].tradeBlocked();
}

export function currentSettings() {
  return getSettings();
}
