// The pending ledger's rules: when a write counts as done, when it stays
// unresolved, and what an unresolved write locks. PURE (type imports only)
// so node --test loads it from source; venue_store.ts wires it to the
// clients and the polling.
//
// The rules (docs/CONTRACT.md "Order discipline"):
// - A venue's answer is a claim. A write is shown as done only when a venue
//   read STARTED AFTER the answer shows the effect it was sent for (the
//   position moved, the order rests, the order is gone), or when the venue's
//   own status for that order (asked by the id this app gave it) says it is
//   finished.
// - The effect must be THIS write's. A net position does not say which
//   order moved it, and a look-alike order is not this order. So every
//   expectation carries an identity: the order's own id, the same order at
//   its new price, or an order that did not exist before the write. Where
//   the venue never said what happened to an order (a lost answer), only
//   that order's own status settles it, never the position.
// - A write whose answer was lost stays "unknown" until evidence settles
//   it. Time alone never does: an expiry only lets a later venue read count
//   as proof that the payload did not land. No evidence is never evidence:
//   a read that cannot tell leaves the write where it is.
// - While a write is unresolved, nothing that could open or add exposure
//   is sent on that market. Closing and cancelling stay available: an exit
//   is never locked behind an unknown.
// - The user can dismiss an unresolved write after checking the venue.
import type { OpenOrder, OrderKind, OrderSide, Position, Side, VenueId } from "./types";
import type { LeverageRead, Lookup, WriteOutcome, WriteRef } from "./venue";

export type PendingKind = "order" | "close" | "flat" | "reverse" | "cancel" | "modify" | "tp" | "sl" | "cancel-exit" | "leverage";
// working: the call is in flight. verifying: the venue answered and the
// re-read has not shown it yet. unknown: the answer was lost, or the venue
// answered and still does not show it.
export type PendingState = "working" | "verifying" | "unknown";

// What the venue must show. Each is checked against one venue read.
export type Expect =
  | { type: "moved"; from: number; dir: 1 | -1; min: number }   // the signed position moved at least `min` in `dir` from `from`
  // At most `max` is left on `side` (0 = flat). `by` is the reduction this
  // write asked for: the tolerance is always smaller than it, so a position
  // that did not change can never pass for a small close.
  | { type: "remaining"; side: Side; max: number; by?: number }
  | { type: "side"; side: Side }                                // a position on `side` exists
  | { type: "no-orders" }                                       // nothing rests on the market
  // An order on the market that satisfies every given constraint. `tol` is
  // an absolute price tolerance (default: a tick of venue rounding);
  // `exclude` are orders that rested BEFORE the write and so prove nothing;
  // `resting` = the venue must call it resting / armed (a row the venue is
  // still placing - MFP "pending" - is not yet an order on the book).
  | { type: "order"; key?: string | null; ref?: WriteRef | null; side?: OrderSide; kind?: OrderKind; price?: number | null; size?: number | null; tol?: number; exclude?: string[]; resting?: boolean }
  | { type: "gone"; key: string }                               // that order no longer rests
  | { type: "leverage"; leverage: number; marginMode: "cross" | "isolated" }
  // No position or order list can show it: only the venue's own status for
  // the order (asked by its id) settles the write. Never true against a view.
  | { type: "status" }
  | { type: "any"; of: Expect[] };

// What a write was sent for, captured when it was registered.
export type Want =
  // from: the signed position when it was sent; before: the keys of the
  // orders resting on the market then.
  | { kind: "order"; side: OrderSide; type: "market" | "limit"; size: number; price: number | null; from: number; before: string[] }
  // from / size: the shown position and the size the store computed. The
  // adapter sizes a close on the venue's own position read at that moment
  // and reports it (WriteOutcome.sized); that wins.
  | { kind: "close"; side: Side; from: number; size: number }
  | { kind: "flat"; side: Side }
  | { kind: "reverse"; side: Side }
  | { kind: "cancel"; orderKey: string }
  // orderKey: the order being moved; before: every order resting then.
  | { kind: "modify"; orderKey: string; side: OrderSide; orderKind: OrderKind; price: number; size: number | null; fromPrice: number; before: string[] }
  // fromPrice / orderKey: the exit being moved (null = a new exit).
  | { kind: "exit"; exit: "tp" | "sl"; side: OrderSide; price: number; fromPrice: number | null; orderKey: string | null; before: string[] }
  | { kind: "leverage"; leverage: number; marginMode: "cross" | "isolated" }
  // A sequence's cancel that is still alive: those orders must be gone.
  | { kind: "clear"; orderKeys: string[] };

// An exit attached to an entry the venue has not filled yet.
export type WaitingExit = { kind: "tp" | "sl"; price: number };

export type Pending = {
  id: string;
  venue: VenueId;
  marketId: string;
  symbol: string;
  kind: PendingKind;
  side: OrderSide | null;
  price: number | null;
  size: number | null;
  label: string;           // what was asked ("BUY 0.05 BTC"), fixed
  text: string;            // what is happening now
  since: number;
  state: PendingState;
  orderKey: string | null; // the order this write replaces / cancels
  posKey: string | null;
  want: Want;
  // Set when the venue's answer arrives:
  expects: Expect[];
  ref: WriteRef | null;         // the order to ask the venue about (single-order writes)
  deadAfter: number | null;     // the payload cannot land after this (Hyperliquid)
  answeredAt: number | null;
  claim: "yes" | "lost" | null; // the venue said yes / the answer was lost
  note: string | null;          // the venue's own words
  // Exits attached to this entry that the venue holds until it fills (MFP):
  // each becomes its own pending item the moment the entry is shown filled,
  // and is reported by itself if the entry rests or is dismissed.
  exits: WaitingExit[];
  // true = `ref` is an order that EXISTED before the write (WriteOutcome
  // .watch: MFP keeps a moved order's id), so its being open proves nothing.
  watched?: boolean;
};

export type View = { positions: Position[]; orders: OpenOrder[] };
export type LogState = "confirmed" | "partial" | "rejected" | "unknown" | "step";
export type LogLine = { text: string; state: LogState };

// A venue answer that still does not show after this long is flagged for
// the user. It changes the wording and the lock class, never the outcome.
export const STALE_MS = 20_000;

const PRICE_REL = 1e-3;   // a venue may round a price to its tick
const SIZE_REL = 1e-6;
const near = (a: number, b: number, rel: number): boolean => Math.abs(a - b) <= Math.max(Math.abs(b) * rel, 1e-12);

export function signedSize(view: View, venue: VenueId, marketId: string): number {
  let s = 0;
  for (const p of view.positions) if (p.venue === venue && p.marketId === marketId) s += p.side === "long" ? p.size : -p.size;
  return s;
}

function refMatches(o: OpenOrder, ref: WriteRef): boolean {
  if (ref.venue === "hl") return o.ref.kind === "hl" && o.ref.cloid !== null && o.ref.cloid.toLowerCase() === ref.cloid.toLowerCase();
  return o.ref.kind === "mfp" && o.ref.clientOrderId !== null && o.ref.clientOrderId === ref.clientOrderId;
}

function orderMatches(o: OpenOrder, e: Extract<Expect, { type: "order" }>): boolean {
  if (e.key && o.key !== e.key) return false;
  if (e.ref && !refMatches(o, e.ref)) return false;
  if (e.side && o.side !== e.side) return false;
  if (e.kind && o.kind !== e.kind) return false;
  if (e.exclude && e.exclude.includes(o.key)) return false;
  if (e.resting && o.status !== "resting") return false;
  if (e.price !== null && e.price !== undefined) {
    if (e.tol !== undefined ? Math.abs(o.price - e.price) > e.tol : !near(o.price, e.price, PRICE_REL)) return false;
  }
  if (e.size !== null && e.size !== undefined && !near(o.size, e.size, SIZE_REL)) return false;
  return true;
}

// true = the read shows it; false = the read shows it is not so; null = this
// read cannot tell (a leverage change on a market with no position).
export function checkExpect(e: Expect, view: View, venue: VenueId, marketId: string): boolean | null {
  const signed = signedSize(view, venue, marketId);
  const orders = view.orders.filter((o) => o.venue === venue && o.marketId === marketId);
  switch (e.type) {
    case "moved":
      return e.min > 0 && (signed - e.from) * e.dir >= e.min - Math.max(e.min * SIZE_REL, 1e-12);
    case "remaining": {
      const left = e.side === "long" ? signed : -signed;
      const round = Math.max(e.max * SIZE_REL, 1e-9);
      // Rounding room, but never as much as half of what the write asked for.
      const tol = e.by !== undefined ? Math.min(round, Math.max(0, e.by) * 0.4) : round;
      return left <= e.max + tol;
    }
    case "side":
      return e.side === "long" ? signed > 0 : signed < 0;
    case "no-orders":
      return orders.length === 0;
    case "order":
      return orders.some((o) => orderMatches(o, e));
    case "gone":
      return !view.orders.some((o) => o.venue === venue && o.key === e.key);
    case "leverage": {
      const pos = view.positions.filter((p) => p.venue === venue && p.marketId === marketId);
      if (!pos.length) return null;
      return pos.every((p) => p.leverage === e.leverage && p.marginMode === e.marginMode);
    }
    case "status":
      return false;
    case "any": {
      let unknown = false;
      for (const x of e.of) {
        const r = checkExpect(x, view, venue, marketId);
        if (r === true) return true;
        if (r === null) unknown = true;
      }
      return unknown ? null : false;
    }
  }
}

// Nothing to check is not "all of it shows": an empty list proves nothing.
export function checkAll(expects: Expect[], view: View, venue: VenueId, marketId: string): boolean | null {
  if (!expects.length) return false;
  let unknown = false;
  for (const e of expects) {
    const r = checkExpect(e, view, venue, marketId);
    if (r === false) return false;
    if (r === null) unknown = true;
  }
  return unknown ? null : true;
}

// Why a read does not show it yet, in the user's words.
export function unmetText(expects: Expect[], view: View, venue: VenueId, marketId: string): string {
  for (const e of expects) {
    if (checkExpect(e, view, venue, marketId) !== false) continue;
    const x = e.type === "any" ? e.of[0] : e;
    switch (x.type) {
      case "moved": return "the position has not changed";
      case "remaining": return "the position is still open";
      case "side": return "no " + x.side + " position";
      case "no-orders": return "orders still rest on the market";
      case "order": return "the order is not on the venue";
      case "gone": return "the order still rests";
      case "leverage": return "the venue still shows the old leverage";
      case "status": return "the venue has not said what happened to the order";
      default: return "not shown";
    }
  }
  return "not shown";
}

// A moved order must be told apart from the same order still at its old
// price: the tolerance is a tick of rounding, but never as much as half
// the move.
// A size-only move (same price) is told apart by its size, so its price gets
// the plain tick of rounding.
const moveTol = (price: number, fromPrice: number): number =>
  price === fromPrice ? Math.abs(price) * PRICE_REL : Math.min(Math.abs(price) * PRICE_REL, Math.abs(price - fromPrice) * 0.4);

// A NEW order this app placed is matched by identity: the venue's order
// key, else the id this app gave it. Only where neither exists (MFP's
// attached exits, the mock) do attributes decide, and then an order that
// already rested before the write never counts. In every case the venue
// must call the order resting: one it is still placing proves nothing yet.
function placed(key: string | null, ref: WriteRef | null, attrs: { side: OrderSide; kind: OrderKind; price: number | null }, before: string[]): Expect {
  if (key) return { type: "order", key, resting: true };
  if (ref) return { type: "order", ref, resting: true };
  return { type: "order", ...attrs, exclude: before, resting: true };
}

// A MOVED order, two ways, each tied to that one order: the replacement by
// the id this app gave it (Hyperliquid replaces the order), or the same
// order at its new price and size (MFP keeps the id; the mock too). A NEW
// order that merely looks like the move is neither: it can have been placed
// by anyone. Where the replacement is not on the book by its id, its own
// status (asked by that id) settles the move, never a look-alike.
function movedTo(ref: WriteRef | null, orderKey: string | null, attrs: { price: number; size?: number | null; tol: number }): Expect {
  const of: Expect[] = [];
  if (ref) of.push({ type: "order", ref, resting: true });
  if (orderKey) of.push({ type: "order", key: orderKey, price: attrs.price, size: attrs.size, tol: attrs.tol, resting: true });
  return { type: "any", of };
}

const answerLost = (out: WriteOutcome): boolean => out.state === "unknown" || (out.state === "rejected" && out.ambiguous);

// The expectations for one answered write.
export function expectsFor(want: Want, out: WriteOutcome): Expect[] {
  const key = out.orderKey ?? null;
  const ref = out.ref ?? null;
  const lost = answerLost(out);
  // The venue has not said what the order did: its answer was lost, or it is
  // still placing the order ("pending"). Until it does, no position can be
  // credited to this order.
  const unsaid = lost || out.state === "pending";
  const said = typeof out.filled === "number" && out.filled > 0 ? out.filled : null;
  switch (want.kind) {
    case "order": {
      const moved: Expect = { type: "moved", from: want.from, dir: want.side === "buy" ? 1 : -1, min: said ?? want.size };
      // The venue never said what this order did: the position cannot say it
      // either (another order's fill moves it just the same).
      if (unsaid && ref && want.type === "market") return [{ type: "status" }];
      // The venue said this order filled: the position must show that fill.
      if (!lost && said !== null) return [moved];
      if (want.type === "market") return [moved];
      // A limit that should rest: found by its own identity. If it filled
      // instead, the order's status says so (the position alone does not).
      if (key || ref) return [placed(key, ref, { side: want.side, kind: "limit", price: want.price }, want.before)];
      return [{ type: "any", of: [placed(null, null, { side: want.side, kind: "limit", price: want.price }, want.before), moved] }];
    }
    case "close": {
      if (unsaid && ref) return [{ type: "status" }];
      const from = out.sized ? out.sized.from : want.from;
      const size = said ?? (out.sized ? out.sized.size : want.size);
      return [{ type: "remaining", side: want.side, max: Math.max(0, from - size), by: size }];
    }
    case "flat":
      return [{ type: "remaining", side: want.side, max: 0 }, { type: "no-orders" }];
    case "reverse":
      // Closed, and the opening order's answer was lost: a position on the
      // new side does not say that order opened it. Its own status does.
      if (unsaid && ref) return [{ type: "status" }];
      return [{ type: "side", side: want.side }];
    case "cancel":
      return [{ type: "gone", key: want.orderKey }];
    case "modify": {
      const price = out.price ?? want.price;
      // The size the venue took the order to (MFP floors it to the step);
      // checked exactly, so an order left at its old size never passes.
      const size = want.size === null ? null : out.size ?? want.size;
      return [movedTo(ref, want.orderKey, { price, size, tol: moveTol(price, want.fromPrice) })];
    }
    case "exit": {
      const price = out.price ?? want.price;
      if (want.fromPrice === null) return [placed(key, ref, { side: want.side, kind: want.exit, price }, want.before)];
      return [movedTo(ref, want.orderKey, { price, tol: moveTol(price, want.fromPrice) })];
    }
    case "leverage":
      return [{ type: "leverage", leverage: want.leverage, marginMode: want.marginMode }];
    case "clear":
      return want.orderKeys.length ? want.orderKeys.map((k): Expect => ({ type: "gone", key: k })) : [{ type: "no-orders" }];
  }
}

// Writes that are ONE order: the venue's status for that order can settle
// them. Flat and reverse are sequences; only the venue read settles those.
// A reverse carries an order only when its OPENING order's answer was lost.
const LOOKUP_KINDS: ReadonlySet<PendingKind> = new Set<PendingKind>(["order", "close", "modify", "tp", "sl", "reverse"]);

const fmtPx = (x: number): string => String(+x.toPrecision(8));

export type Answer = { item: Pending | null; legs: Pending[]; logs: LogLine[] };

const lostText = (msg: string | null): string => (msg ?? "answer lost") + " - not resent; checking the venue";

// The venue (or the adapter's own lookup) answered. Decide what stays
// pending and what the log says. Nothing is "confirmed" here.
export function onAnswer(item: Pending, out: WriteOutcome, now: number, nextId: () => string): Answer {
  // A refusal the adapter only inferred after a lost answer is not a refusal.
  const state = out.state === "rejected" && out.ambiguous ? "unknown" : out.state;
  const msg = out.message;
  const logs: LogLine[] = [];
  const legs: Pending[] = [];
  let next: Pending | null = null;

  if (out.nothingSent) {
    logs.push({ text: msg ?? "nothing was sent", state: "step" });
  } else if (state === "rejected") {
    logs.push({ text: item.label + ": " + (msg ?? "refused"), state: "rejected" });
  } else if (state === "partial") {
    logs.push({ text: item.label + ": " + (msg ?? "partly done"), state: "partial" });
  } else {
    const lost = state === "unknown";
    next = {
      ...item,
      state: lost ? "unknown" : "verifying",
      claim: lost ? "lost" : "yes",
      expects: expectsFor(item.want, out),
      // `watch` is an existing order whose fate settles this write (a moved
      // order on a venue that keeps its id): asked about, never matched on.
      // (a reverse is asked about only while the venue has not said what its
      // opening order did: the answer was lost, or MFP is still working on it)
      ref: LOOKUP_KINDS.has(item.kind) && (item.kind !== "reverse" || lost || state === "pending") ? out.ref ?? out.watch ?? null : null,
      watched: !out.ref && !!out.watch,
      deadAfter: out.deadAfter ?? null,
      answeredAt: now,
      note: msg,
      text: lost ? lostText(msg) : (msg ?? "sent") + " - waiting for the venue to show it",
      exits: [],
    };
    logs.push(lost
      ? { text: item.label + ": " + (msg ?? "answer lost") + " (not resent; checking the venue)", state: "unknown" }
      : { text: item.label + ": " + (msg ?? "sent") + " (verifying)", state: "step" });
  }

  // Attached exits: each one is its own pending item, or its own red line.
  const closing: OrderSide = item.side === "buy" ? "sell" : "buy";
  const before = item.want.kind === "order" ? item.want.before : [];
  for (const leg of out.legs ?? []) {
    const label = leg.kind + " " + item.symbol + " at " + fmtPx(leg.price);
    if (leg.state === "rejected") {
      logs.push({ text: label + " NOT placed: " + (leg.message ?? "refused"), state: "rejected" });
      continue;
    }
    if (leg.state === "waiting") {
      // The venue holds it on an entry that has not filled yet. It rides on
      // the entry's item; with no entry left to wait for it is not there.
      if (next) next.exits.push({ kind: leg.kind, price: leg.price });
      else logs.push({ text: label + " NOT placed: the entry did not go through", state: "rejected" });
      continue;
    }
    const lost = leg.state === "unknown";
    const want: Want = { kind: "exit", exit: leg.kind, side: closing, price: leg.price, fromPrice: null, orderKey: null, before };
    legs.push({
      id: nextId(), venue: item.venue, marketId: item.marketId, symbol: item.symbol, kind: leg.kind, side: closing, price: leg.price, size: null,
      label, since: now, state: lost ? "unknown" : "verifying", orderKey: null, posKey: item.venue + ":" + item.marketId, want,
      expects: expectsFor(want, { state: lost ? "unknown" : "confirmed", message: null, ambiguous: lost, orderKey: leg.orderKey, ref: leg.ref, price: leg.price }),
      ref: leg.ref, deadAfter: leg.deadAfter, answeredAt: now, claim: lost ? "lost" : "yes", note: leg.message,
      text: lost ? lostText(leg.message) : "sent - waiting for the venue to show it", exits: [],
    });
    if (lost) logs.push({ text: label + ": " + (leg.message ?? "answer lost") + " (not resent; checking the venue)", state: "unknown" });
  }

  // Parts of a sequence that are still alive at the venue (Flat's cancel
  // whose answer was lost, a reverse's close the venue is still working
  // on). Each is its own pending item with its own evidence and expiry: it
  // holds the market's lock until it settles, whatever the sequence's own
  // line said.
  const held: Side = item.side === "sell" ? "long" : "short";
  for (const leg of out.live ?? []) {
    if (leg.kind === "cancel") {
      const want: Want = { kind: "clear", orderKeys: leg.orderKeys };
      const label = "cancel orders on " + item.symbol;
      legs.push({
        id: nextId(), venue: item.venue, marketId: item.marketId, symbol: item.symbol, kind: "cancel", side: null, price: null, size: null,
        label, since: now, state: "unknown", orderKey: null, posKey: null, want,
        expects: expectsFor(want, { state: "unknown", message: null, ambiguous: true }),
        ref: null, deadAfter: leg.deadAfter, answeredAt: now, claim: "lost", note: leg.message, text: lostText(leg.message), exits: [],
      });
      logs.push({ text: label + ": " + (leg.message ?? "answer lost") + " (not resent; checking the venue)", state: "unknown" });
      continue;
    }
    const lost = leg.state === "unknown";
    const label = "close " + item.symbol;
    legs.push({
      id: nextId(), venue: item.venue, marketId: item.marketId, symbol: item.symbol, kind: "close", side: item.side, price: null, size: item.size,
      label, since: now, state: lost ? "unknown" : "verifying", orderKey: null, posKey: item.posKey, want: { kind: "flat", side: held },
      // The venue is still working on it (or its answer was lost): the
      // order's own status settles it; a flat position shows it too.
      expects: leg.ref ? [{ type: "status" }] : [{ type: "remaining", side: held, max: 0 }],
      ref: leg.ref, deadAfter: leg.deadAfter, answeredAt: now, claim: lost ? "lost" : "yes", note: leg.message,
      text: lost ? lostText(leg.message) : (leg.message ?? "the venue is still working on it") + " - waiting for the venue", exits: [],
    });
    logs.push({ text: label + ": " + (leg.message ?? "still working on the venue") + (lost ? " (not resent; checking the venue)" : " (verifying)"), state: lost ? "unknown" : "step" });
  }
  return { item: next, legs, logs };
}

// Should the venue be asked about this item's order on this pass?
export function wantsLookup(item: Pending, view: View, startedAt: number): boolean {
  if (item.state === "working" || !item.ref || item.answeredAt === null) return false;
  if (startedAt >= item.answeredAt && checkAll(item.expects, view, item.venue, item.marketId) === true) return false;
  return true;
}

// Should the venue be asked for this market's leverage on this pass? Only
// for a leverage change the position list cannot show (no position).
export function wantsLeverage(item: Pending, view: View): boolean {
  if (item.kind !== "leverage" || item.state === "working" || item.answeredAt === null) return false;
  return checkAll(item.expects, view, item.venue, item.marketId) === null;
}

// leverage: the venue's own leverage setting for the market, read AFTER the
// answer (null / absent = not read, or unreadable).
export type Read = { view: View; startedAt: number; lookup: Lookup | null; now: number; leverage?: LeverageRead | null };
// watch: the entry settled as RESTING with exits attached to it (see ExitWatch).
export type ReadResult = { item: Pending | null; log: LogLine | null; legs: Pending[]; logs: LogLine[]; watch?: ExitWatch | null };

// An entry that rests with exits attached to it (MFP holds them on the
// order). The entry itself is settled - a watch locks nothing - but its
// exits are still owed their check: when the order leaves the book, the
// venue's status for it says whether it filled, and each exit then becomes
// its own pending item. A watch lives while the app is open (like the
// ledger, it is not saved across a restart).
export type ExitWatch = {
  id: string;
  venue: VenueId;
  marketId: string;
  symbol: string;
  side: OrderSide;          // the entry's side
  label: string;            // the entry's label
  entry: Expect;            // how the resting entry is recognised on the book
  ref: WriteRef | null;     // how the venue is asked about it once it is gone
  exits: WaitingExit[];
  before: string[];
};

// How an entry settled, for the exits attached to it.
type Fate = "filled" | "resting" | "dead";

type ExitSource = { venue: VenueId; marketId: string; symbol: string; side: OrderSide | null; exits: WaitingExit[]; before: string[] };

// One pending item per exit of an entry that is now known to have filled:
// each must be shown by a LATER read.
function exitLegs(src: ExitSource, now: number, nextId: () => string, why = "the entry filled"): { legs: Pending[]; logs: LogLine[] } {
  const legs: Pending[] = [];
  const logs: LogLine[] = [];
  const closing: OrderSide = src.side === "buy" ? "sell" : "buy";
  for (const e of src.exits) {
    const label = e.kind + " " + src.symbol + " at " + fmtPx(e.price);
    const want: Want = { kind: "exit", exit: e.kind, side: closing, price: e.price, fromPrice: null, orderKey: null, before: src.before };
    legs.push({
      id: nextId(), venue: src.venue, marketId: src.marketId, symbol: src.symbol, kind: e.kind, side: closing, price: e.price, size: null,
      label, since: now, state: "verifying", orderKey: null, posKey: src.venue + ":" + src.marketId, want,
      expects: expectsFor(want, { state: "confirmed", message: null, ambiguous: false, price: e.price }),
      ref: null, deadAfter: null, answeredAt: now, claim: "yes", note: null,
      text: "attached to the entry - waiting for the venue to show it", exits: [],
    });
    logs.push({ text: label + ": " + why + "; waiting for the venue to show this exit (verifying)", state: "step" });
  }
  return { legs, logs };
}

// The order row an "order" expectation matches in a read, if any.
function rowOf(e: Expect, view: View, venue: VenueId, marketId: string): OpenOrder | null {
  if (e.type !== "order") return null;
  return view.orders.find((o) => o.venue === venue && o.marketId === marketId && orderMatches(o, e)) ?? null;
}

// The alternatives of an item's first expectation.
const altsOf = (item: Pending): Expect[] => {
  const first = item.expects[0];
  return first && first.type === "any" ? first.of : first ? [first] : [];
};

// Does the read show this entry RESTING (as against filled)?
function restsIn(item: Pending, view: View): boolean {
  if (item.want.kind !== "order" || item.want.type !== "limit") return false;
  return altsOf(item).some((e) => e.type === "order" && checkExpect(e, view, item.venue, item.marketId) === true);
}

// The exits an entry carried, once the entry's fate is known. Filled: each
// becomes its own pending item. Resting: the venue holds them on the order;
// they go on a watch and are checked when the order fills. Dead: nothing to
// protect.
function exitsOf(item: Pending, fate: Fate, now: number, nextId: () => string, view: View): { legs: Pending[]; logs: LogLine[]; watch: ExitWatch | null } {
  if (fate === "dead" || !item.exits.length) return { legs: [], logs: [], watch: null };
  const before = item.want.kind === "order" ? item.want.before : [];
  const src: ExitSource = { venue: item.venue, marketId: item.marketId, symbol: item.symbol, side: item.side, exits: item.exits, before };
  if (fate === "filled") return { ...exitLegs(src, now, nextId), watch: null };
  // Resting. The entry is recognised on the book by its own identity: the
  // expectation that just matched it, else the id this app gave it.
  const entry = altsOf(item).find((e) => e.type === "order" && checkExpect(e, view, item.venue, item.marketId) === true) ?? (item.ref ? ({ type: "order", ref: item.ref, resting: true } as Expect) : null);
  // Resting, but part of it already executed: a position exists, and the
  // exits owed for that part are checked now, not when the rest fills.
  const row = entry ? rowOf(entry, view, item.venue, item.marketId) : null;
  if (row && (row.filled ?? 0) > 0) return { ...exitLegs(src, now, nextId, "part of the entry filled (it still rests)"), watch: null };
  const logs: LogLine[] = [];
  for (const e of item.exits) {
    const label = e.kind + " " + item.symbol + " at " + fmtPx(e.price);
    logs.push(entry && item.side
      ? { text: label + ": attached to the resting order - the venue places it when the order fills; it is checked then (while this app stays open)", state: "unknown" }
      : { text: label + ": attached to the resting order - it cannot be followed from here; NOT verified, check it when the order fills", state: "rejected" });
  }
  const watch: ExitWatch | null = entry && item.side
    ? { id: nextId(), venue: item.venue, marketId: item.marketId, symbol: item.symbol, side: item.side, label: item.label, entry, ref: item.ref, exits: item.exits, before }
    : null;
  return { legs: [], logs, watch };
}

// Is the venue to be asked about a watched entry on this pass? Only once it
// has left the book.
export function wantsWatchLookup(w: ExitWatch, view: View): boolean {
  return w.ref !== null && checkExpect(w.entry, view, w.venue, w.marketId) !== true;
}

// A watched entry against one venue read (and, once it is off the book, the
// venue's status for it). keep = still watching.
export function onWatch(w: ExitWatch, read: { view: View; lookup: Lookup | null; now: number }, nextId: () => string): { keep: boolean; legs: Pending[]; logs: LogLine[] } {
  const keep = { keep: true, legs: [], logs: [] };
  const src: ExitSource = { venue: w.venue, marketId: w.marketId, symbol: w.symbol, side: w.side, exits: w.exits, before: w.before };
  const row = rowOf(w.entry, read.view, w.venue, w.marketId);
  if (row) {
    // Still resting. If part of it has executed, a position exists now: the
    // exits are checked from here on, each by itself.
    if ((row.filled ?? 0) > 0) return { keep: false, ...exitLegs(src, read.now, nextId, "part of the entry filled (it still rests)") };
    return keep;
  }
  const named = (text: string, state: LogState): LogLine[] => w.exits.map((e) => ({ text: e.kind + " " + w.symbol + " at " + fmtPx(e.price) + ": " + text, state }));
  // Off the book, and nothing to ask the venue with: say it, never drop it.
  if (!w.ref) return { keep: false, legs: [], logs: named("its entry left the book and the venue cannot be asked what happened - NOT verified, check the venue", "rejected") };
  const look = read.lookup;
  // Not told yet (no answer, unreadable, or the venue still shows it open -
  // a move replaces the order): keep watching.
  if (!look || look.status !== "done") return keep;
  if (look.full || look.filled > 0) return { keep: false, ...exitLegs(src, read.now, nextId) };
  return { keep: false, legs: [], logs: named("its entry ended without filling" + (look.message ? " (" + look.message + ")" : "") + "; the exit went with it", "step") };
}

// What a dismissed item leaves unsaid: its attached exits were never seen.
export function dismissedExits(item: Pending): LogLine[] {
  return item.exits.map((e) => ({ text: e.kind + " " + item.symbol + " at " + fmtPx(e.price) + " NOT verified: its entry was dismissed - check the venue", state: "rejected" as const }));
}

// One complete venue read (and, when the item is a single order, the
// venue's status for it). Returns the item unchanged, re-worded, or settled.
export function onRead(item: Pending, read: Read, nextId: () => string = () => item.id + "x" + Math.round(read.now)): ReadResult {
  const same: ReadResult = { item, log: null, legs: [], logs: [] };
  if (item.state === "working" || item.answeredAt === null) return same;
  const done = (text: string, state: LogState, fate: Fate = "dead"): ReadResult => {
    const x = exitsOf(item, fate, read.now, nextId, read.view);
    return { item: null, log: { text: item.label + ": " + text, state }, legs: x.legs, logs: x.logs, watch: x.watch };
  };
  // Only a read begun after the answer can prove anything about it.
  const fresh = read.startedAt >= item.answeredAt;
  let verdict = fresh ? checkAll(item.expects, read.view, item.venue, item.marketId) : undefined;
  // A leverage change with no position: the position list cannot tell, so
  // the venue's own leverage setting for the market decides. No reading
  // (not asked, unreadable) leaves it undecided - never "fine".
  if (verdict === null && item.want.kind === "leverage" && read.leverage) {
    verdict = read.leverage.leverage === item.want.leverage && read.leverage.marginMode === item.want.marginMode;
  }
  if (verdict === true) {
    return done(item.claim === "lost" ? "the venue shows it (the answer had been lost)" : item.note ?? "done", "confirmed", restsIn(item, read.view) ? "resting" : "filled");
  }

  // Why the venue does not show it, in the user's words. A leverage change
  // judged on the venue's own setting has no position row to point at.
  const unmet = (): string => (item.want.kind === "leverage" ? "the venue still shows the old leverage" : unmetText(item.expects, read.view, item.venue, item.marketId));
  const expired = item.deadAfter !== null && read.startedAt > item.deadAfter;
  const look = item.ref ? read.lookup : null;
  // A move (of a limit or an exit) replaces or re-prices an EXISTING order.
  const move = item.kind === "modify" || (item.want.kind === "exit" && item.want.fromPrice !== null);
  // The entry still works, but part of it executed: the exits riding on it
  // are owed for that part now. Each becomes its own pending item; the entry
  // stays where it is.
  if (look && look.status === "open" && look.filled > 0 && item.exits.length) {
    const src: ExitSource = { venue: item.venue, marketId: item.marketId, symbol: item.symbol, side: item.side, exits: item.exits, before: item.want.kind === "order" ? item.want.before : [] };
    const x = exitLegs(src, read.now, nextId, "part of the entry filled (the rest still works)");
    return { item: { ...item, exits: [] }, log: null, legs: x.legs, logs: x.logs };
  }
  if (look && look.status === "done") {
    const why = look.message ? " (" + look.message + ")" : "";
    if (item.kind === "reverse") {
      // The order asked about is the reverse's OPENING order; the close ran.
      if (look.full) return done("closed and reopened (the venue's status for the opening order)", "confirmed");
      if (look.filled > 0) return done("closed; the opening order is finished" + why + " with about " + look.filled + " executed - check the position", "partial");
      return done("closed; the opening order did not execute" + why, "partial");
    }
    if (item.kind === "tp" || item.kind === "sl" || move) {
      const ran = look.full || look.filled > 0;
      return done(ran ? "the order is finished: it executed" + why + " - check the position" : "the order is no longer on the venue" + why, ran ? "partial" : "rejected");
    }
    if (look.full) return done("filled (the venue's order status)", "confirmed", "filled");
    if (!(look.filled > 0)) return done("did not execute" + why, "rejected");
    // Finished without a "filled" status but with an executed part on the
    // venue's record: a warning, never a success. The position list shows
    // what is actually held.
    const want = item.size ?? 0;
    return done("the order is finished" + why + "; about " + look.filled + (want > 0 ? " of " + want : "") + " executed - check the position", "partial", "filled");
  }
  // The venue says the order this write created rests: that IS its status.
  // For a move only when the order asked about is the REPLACEMENT this write
  // created (Hyperliquid); never when it is the moved order itself (MFP keeps
  // the id: it was open before the move as well).
  if (look && look.status === "open" && look.resting && item.kind !== "close") {
    if (move) {
      if (!item.watched) return done("moved (the venue's status for the replacement order)", "confirmed");
    } else {
      const isLimit = item.want.kind === "order" && item.want.type === "limit";
      const isNewExit = item.want.kind === "exit" && item.want.fromPrice === null;
      if (isLimit || isNewExit) return done("resting (the venue's order status)", "confirmed", "resting");
    }
  }
  if (look && look.status === "unseen" && item.claim === "lost" && expired) {
    if (move && item.orderKey) {
      // The venue does not know the replacement and the payload is dead.
      // "Did not apply" needs one more thing: the original still resting.
      // If it is gone too, something else happened to it.
      if (!fresh) return same;
      const still = read.view.orders.some((o) => o.venue === item.venue && o.key === item.orderKey);
      return still
        ? done("did not apply: the order is unchanged (the payload expired; not resent)", "rejected")
        : done("the order is gone and the venue does not know the replacement - check the venue", "partial");
    }
    if (item.kind === "reverse") return done("closed; the opening order did not reach the venue (the payload expired; not resent)", "partial");
    return done("did not reach the venue (the payload expired; not resent)", "rejected");
  }

  // No order to ask about: after the payload's expiry a fresh read decides.
  if (verdict === false && expired && !item.ref && item.claim === "lost") {
    // A sequence (Flat, Reverse) can have done part of its work: say what is
    // not there, not that nothing happened.
    const seq = item.kind === "flat" || item.kind === "reverse";
    return done((seq ? "did not complete: " : "did not apply: ") + unmet() + " after the payload expired (not resent)" + (seq ? " - check the position" : ""), "rejected");
  }

  // The venue said yes and a fresh read still does not show it (or cannot
  // tell): flag it, keep it. It stays until evidence or Dismiss.
  if ((verdict === false || verdict === null) && item.state === "verifying" && read.now - item.answeredAt > STALE_MS) {
    const why = verdict === null ? "it could not be read back" : unmet();
    return {
      item: { ...item, state: "unknown", text: (item.note ?? "sent") + " - the venue answered but does not show it (" + why + "); check the venue" },
      log: { text: item.label + ": not shown by the venue (" + why + ") - check it", state: "unknown" },
      legs: [], logs: [],
    };
  }
  return same;
}

// ---- the lock ----------------------------------------------------------------

// "open": anything that could open or add exposure, or re-arrange orders
// (an opening order, reverse, modify, set TP / SL, leverage).
// "reduce": close, flat, cancel - never locked behind an unresolved write,
// only behind one that is in flight this instant.
export type WriteClass = "open" | "reduce";

export function blockedBy(pending: Pending[], venue: VenueId, marketId: string, cls: WriteClass): Pending | null {
  const here = pending.filter((p) => p.venue === venue && p.marketId === marketId);
  const working = here.find((p) => p.state === "working");
  if (working) return working;
  return cls === "open" ? here[0] ?? null : null;
}

export function blockText(p: Pending): string {
  if (p.state === "working") return "a write is already in flight on this market - wait for it";
  return "an earlier write on this market is not settled (" + p.label + ") - check the venue, then dismiss it";
}
