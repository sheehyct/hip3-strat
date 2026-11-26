// src/lib/write_ledger.ts: when a write counts as done, when it stays
// unresolved, and what an unresolved write locks (docs/CONTRACT.md "Order
// discipline": the venue is the truth, the response is a hint; an uncertain
// result is resolved by looking the order up, never by a timer).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  blockedBy, blockText, checkAll, checkExpect, dismissedExits, expectsFor, onAnswer, onRead, onWatch, signedSize, STALE_MS, wantsLeverage, wantsLookup, wantsWatchLookup,
} from "../src/lib/write_ledger.ts";

// ---- fixtures ---------------------------------------------------------------

const pos = (side, size, over = {}) => ({
  key: "hl:BTC", venue: "hl", marketId: "BTC", symbol: "BTC", chartCoin: "BTC", side, size, entry: 80000, mark: 80000, pnl: 0,
  notional: size * 80000, liq: null, leverage: 10, marginMode: "cross", marginUsed: null, ref: { kind: "hl", dex: "", szi: side === "long" ? size : -size }, ...over,
});
const ord = (oid, side, kind, price, size, over = {}) => ({
  key: "hl:" + oid, venue: "hl", marketId: "BTC", symbol: "BTC", side, kind, price, size, reduceOnly: kind === "tp" || kind === "sl", status: "resting",
  createdAt: null, ref: { kind: "hl", dex: "", oid, cloid: null, isTrigger: kind === "tp" || kind === "sl" }, ...over,
});
const view = (positions = [], orders = []) => ({ positions, orders });
const CLOID = "0x0123456789abcdef0123456789abcdef";
const REF = { venue: "hl", cloid: CLOID };

let seq = 0;
const nextId = () => "leg" + ++seq;
const T0 = 1_000_000;   // when the write was registered

// A pending item as the store registers it (in flight, nothing known yet).
const item = (kind, want, over = {}) => ({
  id: "p1", venue: "hl", marketId: "BTC", symbol: "BTC", kind, side: "buy", price: null, size: 0.05, label: "BUY 0.05 BTC", text: "sending", since: T0,
  state: "working", orderKey: null, posKey: null, want, expects: [], ref: null, deadAfter: null, answeredAt: null, claim: null, note: null, exits: [], ...over,
});
const closeWant = (from, size) => ({ kind: "close", side: "long", from, size });
const marketBuy = (over = {}) => item("order", { kind: "order", side: "buy", type: "market", size: 0.05, price: null, from: 0, before: [] }, over);
const yes = (over = {}) => ({ state: "confirmed", message: "filled 0.05 at 80010", ambiguous: false, filled: 0.05, ref: REF, deadAfter: T0 + 20_000, ...over });
const lost = (over = {}) => ({ state: "unknown", message: "transport: network error", ambiguous: true, ref: REF, deadAfter: T0 + 20_000, ...over });
const read = (v, startedAt, lookup = null, now = startedAt) => ({ view: v, startedAt, lookup, now });
const answered = (it, out, at = T0 + 100) => onAnswer(it, out, at, nextId);

// ---- expectations -------------------------------------------------------------

test("signedSize: long is positive, short negative, another market does not count", () => {
  assert.equal(signedSize(view([pos("long", 0.05)]), "hl", "BTC"), 0.05);
  assert.equal(signedSize(view([pos("short", 0.05)]), "hl", "BTC"), -0.05);
  assert.equal(signedSize(view([pos("long", 0.05, { marketId: "ETH" })]), "hl", "BTC"), 0);
  assert.equal(signedSize(view([pos("long", 0.05, { venue: "mfp" })]), "hl", "BTC"), 0);
});

test("a market order expects the position to move by what the answer said filled", () => {
  const want = { kind: "order", side: "sell", type: "market", size: 0.05, price: null, from: 0.05, before: [] };
  assert.deepEqual(expectsFor(want, yes({ filled: 0.03 })), [{ type: "moved", from: 0.05, dir: -1, min: 0.03 }]);
  // a lost answer with an id to ask about: the position cannot say which
  // order moved it, so only that order's own status settles it
  assert.deepEqual(expectsFor(want, lost()), [{ type: "status" }]);
  // a lost answer with no id at all (the mock): the position is all there is
  assert.deepEqual(expectsFor(want, lost({ ref: null })), [{ type: "moved", from: 0.05, dir: -1, min: 0.05 }]);
});

test("a limit order is matched by identity: the venue's key, else this app's id, never by look-alike attributes", () => {
  const want = { kind: "order", side: "buy", type: "limit", size: 0.05, price: 79000, from: 0, before: ["hl:5"] };
  const moved = { type: "moved", from: 0, dir: 1, min: 0.05 };
  // with an identity the order is found by it, and by nothing else: a moved
  // position is not an alternative (another order's fill moves it too)
  assert.deepEqual(expectsFor(want, { state: "confirmed", message: null, ambiguous: false, orderKey: "hl:77", ref: REF }), [{ type: "order", key: "hl:77", resting: true }]);
  assert.deepEqual(expectsFor(want, lost()), [{ type: "order", ref: REF, resting: true }]);
  // a limit the venue itself says filled at once: the position must show that fill
  assert.deepEqual(expectsFor(want, yes({ filled: 0.05 })), [moved]);
  // the mock gives neither: attributes decide, and an order that rested before the write is excluded
  assert.deepEqual(expectsFor(want, { state: "confirmed", message: null, ambiguous: false }), [{ type: "any", of: [{ type: "order", side: "buy", kind: "limit", price: 79000, exclude: ["hl:5"], resting: true }, moved] }]);
  const twin = ord(5, "buy", "limit", 79000, 0.05);
  assert.equal(checkAll(expectsFor(want, { state: "confirmed", message: null, ambiguous: false }), view([], [twin]), "hl", "BTC"), false);
  assert.equal(checkAll(expectsFor(want, { state: "confirmed", message: null, ambiguous: false }), view([], [twin, ord(6, "buy", "limit", 79000, 0.05)]), "hl", "BTC"), true);
});

test("an identical order that already rested does not confirm a new one whose answer was lost", () => {
  const want = { kind: "order", side: "buy", type: "limit", size: 0.05, price: 79000, from: 0, before: ["hl:5"] };
  const twin = ord(5, "buy", "limit", 79000, 0.05);
  assert.equal(checkAll(expectsFor(want, lost()), view([], [twin]), "hl", "BTC"), false);
  const mine = ord(6, "buy", "limit", 79000, 0.05, { ref: { kind: "hl", dex: "", oid: 6, cloid: CLOID.toUpperCase().replace("0X", "0x"), isTrigger: false } });
  assert.equal(checkAll(expectsFor(want, lost()), view([], [twin, mine]), "hl", "BTC"), true);
});

test("close, flat, reverse, cancel, modify, exit, leverage expectations", () => {
  assert.deepEqual(expectsFor(closeWant(0.05, 0.025), yes({ filled: null })), [{ type: "remaining", side: "long", max: 0.025, by: 0.025 }]);
  assert.deepEqual(expectsFor({ kind: "flat", side: "long" }, yes()), [{ type: "remaining", side: "long", max: 0 }, { type: "no-orders" }]);
  assert.deepEqual(expectsFor({ kind: "reverse", side: "short" }, yes()), [{ type: "side", side: "short" }]);
  assert.deepEqual(expectsFor({ kind: "cancel", orderKey: "hl:9" }, yes()), [{ type: "gone", key: "hl:9" }]);
  // a modify uses the WIRE price the adapter reports (the venue's rounding),
  // with a tolerance of a tick but never as much as half the move
  // A moved order, two ways, each tied to that one order: the replacement
  // by this app's id, or the same order at its new price (T3: a NEW order
  // that merely looks like the move is no longer an alternative).
  assert.deepEqual(
    expectsFor({ kind: "modify", orderKey: "hl:9", side: "sell", orderKind: "tp", price: 84123.7, size: null, fromPrice: 84000, before: ["hl:9", "hl:5"] }, { state: "confirmed", message: null, ambiguous: false, ref: REF, price: 84124 }),
    [{ type: "any", of: [
      { type: "order", ref: REF, resting: true },
      { type: "order", key: "hl:9", price: 84124, size: null, tol: 124 * 0.4, resting: true },
    ] }],
  );
  assert.deepEqual(expectsFor({ kind: "exit", exit: "sl", side: "sell", price: 77500, fromPrice: null, orderKey: null, before: [] }, { state: "confirmed", message: null, ambiguous: false, orderKey: "hl:12" }), [{ type: "order", key: "hl:12", resting: true }]);
  // a new exit whose answer was lost is matched by this app's id only
  assert.deepEqual(expectsFor({ kind: "exit", exit: "sl", side: "sell", price: 77500, fromPrice: null, orderKey: null, before: [] }, lost()), [{ type: "order", ref: REF, resting: true }]);
  // a sequence's cancel that is still alive: those orders must be gone
  assert.deepEqual(expectsFor({ kind: "clear", orderKeys: ["hl:1", "hl:2"] }, lost({ ref: null })), [{ type: "gone", key: "hl:1" }, { type: "gone", key: "hl:2" }]);
  assert.deepEqual(expectsFor({ kind: "leverage", leverage: 5, marginMode: "isolated" }, yes()), [{ type: "leverage", leverage: 5, marginMode: "isolated" }]);
});

test("checkExpect: moved needs the full size in the right direction", () => {
  const e = { type: "moved", from: 0, dir: 1, min: 0.05 };
  assert.equal(checkExpect(e, view([]), "hl", "BTC"), false);
  assert.equal(checkExpect(e, view([pos("long", 0.03)]), "hl", "BTC"), false);
  assert.equal(checkExpect(e, view([pos("long", 0.05)]), "hl", "BTC"), true);
  assert.equal(checkExpect(e, view([pos("short", 0.05)]), "hl", "BTC"), false);
  // reducing a long by 0.05 from 0.05 = flat
  assert.equal(checkExpect({ type: "moved", from: 0.05, dir: -1, min: 0.05 }, view([]), "hl", "BTC"), true);
  // a zero-size "moved" can never be satisfied by nothing happening
  assert.equal(checkExpect({ type: "moved", from: 0, dir: 1, min: 0 }, view([]), "hl", "BTC"), false);
});

test("checkExpect: remaining, side, no-orders, gone", () => {
  assert.equal(checkExpect({ type: "remaining", side: "long", max: 0 }, view([pos("long", 0.05)]), "hl", "BTC"), false);
  assert.equal(checkExpect({ type: "remaining", side: "long", max: 0 }, view([]), "hl", "BTC"), true);
  assert.equal(checkExpect({ type: "remaining", side: "long", max: 0.025 }, view([pos("long", 0.025)]), "hl", "BTC"), true);
  assert.equal(checkExpect({ type: "remaining", side: "long", max: 0.025 }, view([pos("long", 0.0375)]), "hl", "BTC"), false);
  assert.equal(checkExpect({ type: "side", side: "short" }, view([pos("long", 0.05)]), "hl", "BTC"), false);
  assert.equal(checkExpect({ type: "side", side: "short" }, view([pos("short", 0.05)]), "hl", "BTC"), true);
  assert.equal(checkExpect({ type: "no-orders" }, view([], [ord(1, "sell", "tp", 84000, 0.05)]), "hl", "BTC"), false);
  assert.equal(checkExpect({ type: "no-orders" }, view([], [ord(1, "sell", "tp", 84000, 0.05, { marketId: "ETH" })]), "hl", "BTC"), true);
  assert.equal(checkExpect({ type: "gone", key: "hl:1" }, view([], [ord(1, "sell", "tp", 84000, 0.05)]), "hl", "BTC"), false);
  assert.equal(checkExpect({ type: "gone", key: "hl:1" }, view([], []), "hl", "BTC"), true);
});

test("checkExpect: an exit is matched on side, kind and price (a tick of rounding allowed, a different level not)", () => {
  const e = { type: "order", side: "sell", kind: "sl", price: 77500 };
  assert.equal(checkExpect(e, view([], [ord(1, "sell", "sl", 77500, 0.05)]), "hl", "BTC"), true);
  assert.equal(checkExpect(e, view([], [ord(1, "sell", "sl", 77500.5, 0.05)]), "hl", "BTC"), true);
  assert.equal(checkExpect(e, view([], [ord(1, "sell", "sl", 77000, 0.05)]), "hl", "BTC"), false);
  assert.equal(checkExpect(e, view([], [ord(1, "sell", "tp", 77500, 0.05)]), "hl", "BTC"), false);
  assert.equal(checkExpect(e, view([], [ord(1, "buy", "sl", 77500, 0.05)]), "hl", "BTC"), false);
});

test("checkExpect: a leverage change with no position cannot be read (null), not assumed", () => {
  const e = { type: "leverage", leverage: 5, marginMode: "isolated" };
  assert.equal(checkExpect(e, view([]), "hl", "BTC"), null);
  assert.equal(checkExpect(e, view([pos("long", 0.05)]), "hl", "BTC"), false);
  assert.equal(checkExpect(e, view([pos("long", 0.05, { leverage: 5, marginMode: "isolated" })]), "hl", "BTC"), true);
});

test("a small move is NOT confirmed by the same order still sitting at its old price (lost answer, either venue)", () => {
  // Hyperliquid: a stop dragged 77500 -> 77540 (0.05 percent); the answer is lost
  const hl = expectsFor({ kind: "exit", exit: "sl", side: "sell", price: 77540, fromPrice: 77500, orderKey: "hl:40", before: ["hl:40"] }, lost({ price: 77540 }));
  const old = ord(40, "sell", "sl", 77500, 0.05);
  assert.equal(checkAll(hl, view([pos("long", 0.05)], [old]), "hl", "BTC"), false);
  // the replacement, by the id this app gave it
  assert.equal(checkAll(hl, view([pos("long", 0.05)], [ord(41, "sell", "sl", 77540, 0.05, { ref: { kind: "hl", dex: "", oid: 41, cloid: CLOID, isTrigger: true } })]), "hl", "BTC"), true);
  // a stop at the new price with no id is not it (T3)
  assert.equal(checkAll(hl, view([pos("long", 0.05)], [ord(41, "sell", "sl", 77540, 0.05)]), "hl", "BTC"), false);
  // MFP: a limit patched 100.00 -> 100.05 (same order id, no id of its own to ask about)
  const mfp = expectsFor({ kind: "modify", orderKey: "mfp:ord_9", side: "buy", orderKind: "limit", price: 100.05, size: null, fromPrice: 100, before: ["mfp:ord_9"] }, { state: "rejected", message: "transport: timed out; the order is unchanged", ambiguous: true, price: 100.05 });
  const o = (px) => ord(9, "buy", "limit", px, 1, { key: "mfp:ord_9", venue: "mfp" });
  assert.equal(checkAll(mfp, view([], [o(100)]), "mfp", "BTC"), false);
  assert.equal(checkAll(mfp, view([], [o(100.05)]), "mfp", "BTC"), true);
  assert.equal(checkAll(mfp, view([], [o(100.049)]), "mfp", "BTC"), true);   // the venue's own rounding of the new price still counts
});

test("an exit that already rested does not confirm a new attached exit near the same price (MFP legs have no id)", () => {
  const entry = item("order", { kind: "order", side: "buy", type: "market", size: 0.05, price: null, from: 0.05, before: ["mfp:ord_1"] }, { venue: "mfp" });
  const legs = [{ kind: "sl", price: 77520, state: "sent", message: null, orderKey: null, ref: null, deadAfter: null }];
  const sl = answered(entry, { state: "confirmed", message: "filled", ambiguous: false, filled: 0.05, legs }).legs[0];
  const oldSl = ord(1, "sell", "sl", 77500, 0.05, { key: "mfp:ord_1", venue: "mfp" });
  const held = pos("long", 0.1, { venue: "mfp", key: "mfp:BTC" });
  assert.equal(onRead(sl, read(view([held], [oldSl]), T0 + 200)).item, sl);
  const newSl = ord(2, "sell", "sl", 77520, 0.05, { key: "mfp:ord_2", venue: "mfp" });
  assert.equal(onRead(sl, read(view([held], [oldSl, newSl]), T0 + 200)).item, null);
});

// ---- the venue's answer -------------------------------------------------------

test("a refusal clears the item with the venue's words; nothing stays pending", () => {
  const a = answered(marketBuy(), { state: "rejected", message: "Order must have minimum value of $10", ambiguous: false });
  assert.equal(a.item, null);
  assert.deepEqual(a.logs, [{ text: "BUY 0.05 BTC: Order must have minimum value of $10", state: "rejected" }]);
});

test("a 'refusal' the adapter only inferred after a lost answer is unknown, not a refusal", () => {
  const a = answered(marketBuy(), { state: "rejected", message: "transport: timed out; the order still rests", ambiguous: true, deadAfter: T0 + 20_000 });
  assert.equal(a.item.state, "unknown");
  assert.equal(a.item.claim, "lost");
  assert.equal(a.logs[0].state, "unknown");
});

test("a yes from the venue is a claim: the item is verifying and the log does NOT say confirmed", () => {
  const a = answered(marketBuy(), yes());
  assert.equal(a.item.state, "verifying");
  assert.equal(a.item.claim, "yes");
  assert.equal(a.item.answeredAt, T0 + 100);
  assert.deepEqual(a.item.ref, REF);
  assert.equal(a.item.deadAfter, T0 + 20_000);
  assert.deepEqual(a.logs.map((l) => l.state), ["step"]);
  assert.match(a.item.text, /waiting for the venue to show it/);
});

test("partial: logged as a warning and cleared (nothing is in flight); nothing-sent: cleared quietly", () => {
  const a = answered(item("close", closeWant(0.05, 0.05)), { state: "partial", message: "partly closed 0.03, 0.02 left (the order is finished)", ambiguous: false });
  assert.equal(a.item, null);
  assert.equal(a.logs[0].state, "partial");
  const b = answered(item("leverage", { kind: "leverage", leverage: 5, marginMode: "cross" }), { state: "confirmed", message: "MFP applies leverage per order", ambiguous: false, nothingSent: true });
  assert.equal(b.item, null);
  assert.equal(b.logs[0].state, "step");
});

test("flat and an answered reverse carry no order to look up (they are sequences); a single order does", () => {
  assert.equal(answered(item("flat", { kind: "flat", side: "long" }), yes()).item.ref, null);
  assert.equal(answered(item("flat", { kind: "flat", side: "long" }), lost()).item.ref, null);
  assert.equal(answered(item("reverse", { kind: "reverse", side: "short" }), yes()).item.ref, null);
  // a reverse is asked about only when its OPENING order's answer was lost
  assert.deepEqual(answered(item("reverse", { kind: "reverse", side: "short" }), lost()).item.ref, REF);
  assert.deepEqual(answered(item("close", closeWant(0.05, 0.05)), yes()).item.ref, REF);
});

test("attached exits: each leg is its own pending item; a refused stop is its own red line, logged last", () => {
  const legs = [
    { kind: "sl", price: 77500, state: "rejected", message: "Invalid TP/SL price", orderKey: null, ref: null, deadAfter: null },
    { kind: "tp", price: 84000, state: "sent", message: null, orderKey: "hl:31", ref: REF, deadAfter: T0 + 20_000 },
  ];
  const a = answered(marketBuy(), yes({ legs }));
  assert.equal(a.item.state, "verifying");
  assert.equal(a.legs.length, 1);
  const tp = a.legs[0];
  assert.equal(tp.kind, "tp");
  assert.equal(tp.state, "verifying");
  assert.equal(tp.side, "sell");                 // the closing side of a buy
  assert.equal(tp.price, 84000);
  assert.equal(tp.posKey, "hl:BTC");             // so the chart draws it dashed until the venue shows it
  assert.deepEqual(tp.expects, [{ type: "order", key: "hl:31", resting: true }]);
  assert.deepEqual(a.logs.map((l) => l.state), ["step", "rejected"]);
  assert.match(a.logs[1].text, /sl BTC at 77500 NOT placed: Invalid TP\/SL price/);
});

test("exits that were never sent (the entry's answer was lost) are each logged in red beside the unknown entry", () => {
  const legs = [
    { kind: "sl", price: 77500, state: "rejected", message: "not sent: the entry's answer was lost", orderKey: null, ref: null, deadAfter: null },
    { kind: "tp", price: 84000, state: "rejected", message: "not sent: the entry's answer was lost", orderKey: null, ref: null, deadAfter: null },
  ];
  const a = answered(marketBuy(), lost({ legs }));
  assert.equal(a.item.state, "unknown");
  assert.equal(a.legs.length, 0);
  assert.deepEqual(a.logs.map((l) => l.state), ["unknown", "rejected", "rejected"]);
  assert.match(a.logs[1].text, /sl BTC at 77500 NOT placed: not sent/);
});

test("an exit leg whose answer was lost is unknown, with its own id and expiry", () => {
  const legs = [{ kind: "sl", price: 77500, state: "unknown", message: "transport: timed out", orderKey: null, ref: REF, deadAfter: T0 + 40_000 }];
  const a = answered(marketBuy(), yes({ legs }));
  assert.equal(a.legs[0].state, "unknown");
  assert.equal(a.legs[0].claim, "lost");
  assert.equal(a.legs[0].deadAfter, T0 + 40_000);
  assert.deepEqual(a.legs[0].ref, REF);
});

// ---- venue reads (the audit's F4: a successful re-read is not confirmation) -----

test("F4: the venue answered 'filled' but the re-read still shows the old position - not confirmed, still pending", () => {
  const it = answered(marketBuy(), yes()).item;
  const r = onRead(it, read(view([]), T0 + 200));
  assert.equal(r.item, it);       // unchanged, still verifying
  assert.equal(r.log, null);      // no success line
});

test("the item is confirmed only when a read begun AFTER the answer shows the fill", () => {
  const it = answered(marketBuy(), yes()).item;   // answered at T0 + 100
  const shows = view([pos("long", 0.05)]);
  // a read that started before the answer proves nothing about it, even if it happens to show the position
  assert.equal(onRead(it, read(shows, T0 + 50)).item, it);
  const r = onRead(it, read(shows, T0 + 200));
  assert.equal(r.item, null);
  assert.deepEqual(r.log, { text: "BUY 0.05 BTC: filled 0.05 at 80010", state: "confirmed" });
});

test("a close that answered yes while the position is unchanged stays pending; flat is not confirmed while orders rest", () => {
  const c = answered(item("close", closeWant(0.05, 0.025)), yes({ ref: null, filled: null })).item;
  assert.equal(onRead(c, read(view([pos("long", 0.05)]), T0 + 200)).item, c);
  assert.equal(onRead(c, read(view([pos("long", 0.025)]), T0 + 200)).item, null);

  const f = answered(item("flat", { kind: "flat", side: "long" }), yes()).item;
  const flatButOrders = view([], [ord(1, "buy", "limit", 70000, 0.05)]);
  assert.equal(onRead(f, read(flatButOrders, T0 + 200)).item, f);
});

test("flat confirms when the position is gone AND the market has no orders", () => {
  const f = answered(item("flat", { kind: "flat", side: "long" }), yes()).item;
  assert.equal(onRead(f, read(view([], []), T0 + 200)).item, null);
});

test("the venue said yes but still does not show it after STALE_MS: flagged unknown with the reason, never cleared", () => {
  const f = answered(item("flat", { kind: "flat", side: "long" }), yes({ deadAfter: null })).item;
  const flatButOrders = view([], [ord(1, "buy", "limit", 70000, 0.05)]);
  const at = T0 + 100 + STALE_MS + 1;
  const r = onRead(f, read(flatButOrders, at, null, at));
  assert.equal(r.item.state, "unknown");
  assert.match(r.item.text, /orders still rest on the market/);
  assert.equal(r.log.state, "unknown");
  // an hour later, same reads: still there, and not logged again
  const later = onRead(r.item, read(flatButOrders, at + 3_600_000, null, at + 3_600_000));
  assert.equal(later.item, r.item);
  assert.equal(later.log, null);
  // the moment the venue shows it, it settles
  assert.equal(onRead(r.item, read(view([], []), at + 3_600_000)).item, null);
});

// ---- lost answers (the audit's F5: unknown must not expire) ---------------------

test("F5: an unknown write does not expire by time - an hour of reads that do not show it changes nothing", () => {
  // MFP: no payload expiry, the venue does not know the id
  const want = { kind: "order", side: "buy", type: "market", size: 0.05, price: null, from: 0, before: [] };
  const it = answered(item("order", want, { venue: "mfp" }), { state: "unknown", message: "answer lost (timed out)", ambiguous: true, ref: { venue: "mfp", clientOrderId: "tt-open-1" } }).item;
  assert.equal(it.state, "unknown");
  const unseen = { status: "unseen", full: false, filled: 0, message: null };
  for (const dt of [61_000, 600_000, 3_600_000]) {
    const r = onRead(it, read(view([]), T0 + dt, unseen, T0 + dt));
    assert.equal(r.item, it, "still unknown after " + dt + " ms");
    assert.equal(r.log, null);
  }
});

test("a lost answer: 'the venue has no such order' settles it only AFTER the payload's expiry", () => {
  const it = answered(marketBuy(), lost()).item;           // deadAfter = T0 + 20_000
  const unseen = { status: "unseen", full: false, filled: 0, message: null };
  assert.equal(onRead(it, read(view([]), T0 + 5_000, unseen)).item, it);      // could still land
  const r = onRead(it, read(view([]), T0 + 21_000, unseen));
  assert.equal(r.item, null);
  assert.equal(r.log.state, "rejected");
  assert.match(r.log.text, /did not reach the venue/);
});

test("a lost answer: an unreadable lookup never settles it, however late", () => {
  const it = answered(marketBuy(), lost()).item;
  const unreadable = { status: "unreadable", full: false, filled: 0, message: null };
  assert.equal(onRead(it, read(view([]), T0 + 3_600_000, unreadable, T0 + 3_600_000)).item, it);
  assert.equal(onRead(it, read(view([]), T0 + 3_600_000, null, T0 + 3_600_000)).item, it);
});

test("a lost answer settled by the venue's own order status: filled, finished with a part executed, nothing executed", () => {
  const it = answered(marketBuy(), lost()).item;
  const at = T0 + 21_000;
  const full = onRead(it, read(view([]), at, { status: "done", full: true, filled: 0.05, message: "filled" }));
  assert.equal(full.item, null);
  assert.equal(full.log.state, "confirmed");
  // Only a "filled" STATUS is a success. An executed size on a canceled
  // order is reported as a warning (the venue's size fields on a canceled
  // order are not pinned by a live payload yet), never as a green fill.
  for (const filled of [0.02, 0.05]) {
    const part = onRead(it, read(view([]), at, { status: "done", full: false, filled, message: "canceled" }));
    assert.equal(part.item, null);
    assert.equal(part.log.state, "partial");
    assert.match(part.log.text, /about 0\.0[25] of 0\.05 executed - check the position/);
  }
  const none = onRead(it, read(view([]), at, { status: "done", full: false, filled: 0, message: "canceled" }));
  assert.equal(none.item, null);
  assert.equal(none.log.state, "rejected");
  // a filled status with no size on the record (MFP) is still a fill, not "did not execute"
  assert.equal(onRead(it, read(view([]), at, { status: "done", full: true, filled: 0, message: "filled" })).log.state, "confirmed");
  // "open" means it can still change: keep waiting
  assert.equal(onRead(it, read(view([]), at, { status: "open", full: false, filled: 0, message: "open" })).item, it);
});

test("a lost answer with NO id to ask about (the mock) is confirmed when the venue then shows it", () => {
  const it = answered(marketBuy(), lost({ ref: null })).item;
  const r = onRead(it, read(view([pos("long", 0.05)]), T0 + 500));
  assert.equal(r.item, null);
  assert.equal(r.log.state, "confirmed");
  assert.match(r.log.text, /the answer had been lost/);
});

test("a lost cancel (no order id to ask about): a fresh read after the expiry decides, before it nothing does", () => {
  const want = { kind: "cancel", orderKey: "hl:9" };
  const it = answered(item("cancel", want, { label: "cancel limit BTC" }), { state: "rejected", message: "transport: timed out; the order still rests", ambiguous: true, deadAfter: T0 + 20_000 }).item;
  const rests = view([], [ord(9, "buy", "limit", 70000, 0.05)]);
  assert.equal(onRead(it, read(rests, T0 + 5_000)).item, it);              // the cancel could still land
  const dead = onRead(it, read(rests, T0 + 21_000));
  assert.equal(dead.item, null);
  assert.equal(dead.log.state, "rejected");
  assert.match(dead.log.text, /did not apply: the order still rests/);
  const gone = onRead(it, read(view([], []), T0 + 5_000));
  assert.equal(gone.item, null);
  assert.equal(gone.log.state, "confirmed");
});

test("a lost answer with no expiry (MFP) and no order id stays until the venue shows it", () => {
  const want = { kind: "cancel", orderKey: "mfp:ord_9" };
  const it = answered(item("cancel", want, { venue: "mfp" }), { state: "rejected", message: "transport: timed out; the order still works", ambiguous: true }).item;
  const rests = view([], [ord(9, "buy", "limit", 70000, 0.05, { key: "mfp:ord_9", venue: "mfp" })]);
  assert.equal(onRead(it, read(rests, T0 + 3_600_000, null, T0 + 3_600_000)).item, it);
});

// ---- R8: no evidence is never evidence (leverage with no position) -------------

const LEV = { kind: "leverage", leverage: 5, marginMode: "cross" };
const levRead = (v, startedAt, leverage, now = startedAt) => ({ view: v, startedAt, lookup: null, leverage, now });

test("R8: leverage on a market with no position is NOT confirmed on the venue's yes alone", () => {
  const ok = answered(item("leverage", LEV), { state: "confirmed", message: "5x cross", ambiguous: false, deadAfter: T0 + 20_000 }).item;
  // the position list cannot tell, and no leverage reading came back
  assert.equal(onRead(ok, read(view([]), T0 + 200)).item, ok);
  assert.equal(onRead(ok, levRead(view([]), T0 + 200, null)).item, ok);
  assert.equal(wantsLeverage(ok, view([])), true);
  assert.equal(wantsLeverage(ok, view([pos("long", 0.05)])), false);   // a position shows it: no extra read
  // the venue's own setting for the market shows it: confirmed
  const shown = onRead(ok, levRead(view([]), T0 + 200, { leverage: 5, marginMode: "cross" }));
  assert.equal(shown.item, null);
  assert.equal(shown.log.state, "confirmed");
  // the venue's own setting says otherwise: not confirmed, still held
  assert.equal(onRead(ok, levRead(view([]), T0 + 200, { leverage: 10, marginMode: "cross" })).item, ok);
  assert.equal(onRead(ok, levRead(view([]), T0 + 200, { leverage: 5, marginMode: "isolated" })).item, ok);
});

test("R8: a leverage yes that can never be read back is flagged for the user, never cleared", () => {
  const ok = answered(item("leverage", LEV), { state: "confirmed", message: "5x cross", ambiguous: false, deadAfter: T0 + 20_000 }).item;
  const at = T0 + 100 + STALE_MS + 1;
  const r = onRead(ok, levRead(view([]), at, null));
  assert.equal(r.item.state, "unknown");
  assert.match(r.item.text, /could not be read back/);
  assert.equal(blockedBy([r.item], "hl", "BTC", "open").id, "p1");   // new exposure still waits for it
  assert.equal(onRead(r.item, levRead(view([]), at + 3_600_000, null)).item, r.item);
});

test("R8: a lost leverage answer does not clear at the payload's expiry without a reading", () => {
  const un = answered(item("leverage", LEV), { state: "unknown", message: "transport: timed out", ambiguous: true, deadAfter: T0 + 20_000 }).item;
  assert.equal(onRead(un, read(view([]), T0 + 5_000)).item, un);
  // expired, and still nothing was read: it stays (the old rule cleared it here)
  assert.equal(onRead(un, read(view([]), T0 + 21_000)).item, un);
  assert.equal(onRead(un, levRead(view([]), T0 + 3_600_000, null)).item, un);
  // expired and the venue shows the OLD setting: the change did not apply
  const dead = onRead(un, levRead(view([]), T0 + 21_000, { leverage: 10, marginMode: "cross" }));
  assert.equal(dead.item, null);
  assert.equal(dead.log.state, "rejected");
  assert.match(dead.log.text, /did not apply: the venue still shows the old leverage/);
  // before the expiry the old setting proves nothing: the payload can still land
  assert.equal(onRead(un, levRead(view([]), T0 + 5_000, { leverage: 10, marginMode: "cross" })).item, un);
  // the venue shows the new setting: it landed
  const landed = onRead(un, levRead(view([]), T0 + 5_000, { leverage: 5, marginMode: "cross" }));
  assert.equal(landed.item, null);
  assert.equal(landed.log.state, "confirmed");
});

test("an exit leg: confirmed when the venue shows the trigger; a finished trigger is reported, not confirmed", () => {
  const legs = [{ kind: "sl", price: 77500, state: "sent", message: null, orderKey: null, ref: REF, deadAfter: T0 + 20_000 }];
  const sl = answered(marketBuy(), yes({ legs })).legs[0];
  // matched by the id this app gave it: a look-alike stop without that id proves nothing
  const lookAlike = view([pos("long", 0.05)], [ord(39, "sell", "sl", 77500, 0.05)]);
  assert.equal(onRead(sl, read(lookAlike, T0 + 200)).item, sl);
  const withSl = view([pos("long", 0.05)], [ord(40, "sell", "sl", 77500, 0.05, { ref: { kind: "hl", dex: "", oid: 40, cloid: CLOID, isTrigger: true } })]);
  assert.equal(onRead(sl, read(view([pos("long", 0.05)]), T0 + 200)).item, sl);
  assert.equal(onRead(sl, read(withSl, T0 + 200)).item, null);
  const gone = onRead(sl, read(view([pos("long", 0.05)]), T0 + 200, { status: "done", full: false, filled: 0, message: "canceled" }));
  assert.equal(gone.item, null);
  assert.equal(gone.log.state, "rejected");
});

test("wantsLookup: only a single order the read does not already show", () => {
  const it = answered(marketBuy(), yes()).item;
  assert.equal(wantsLookup(it, view([]), T0 + 200), true);
  assert.equal(wantsLookup(it, view([pos("long", 0.05)]), T0 + 200), false);
  assert.equal(wantsLookup(marketBuy(), view([]), T0 + 200), false);                                   // still in flight
  assert.equal(wantsLookup(answered(item("flat", { kind: "flat", side: "long" }), yes()).item, view([pos("long", 0.05)]), T0 + 200), false);
});

test("an item still in flight is never judged by a read", () => {
  const it = marketBuy();
  assert.equal(onRead(it, read(view([pos("long", 0.05)]), T0 + 200)).item, it);
});

// ---- the lock -----------------------------------------------------------------

test("a write in flight blocks everything on its market, and nothing on another market", () => {
  const working = [marketBuy()];
  assert.equal(blockedBy(working, "hl", "BTC", "open").id, "p1");
  assert.equal(blockedBy(working, "hl", "BTC", "reduce").id, "p1");
  assert.equal(blockedBy(working, "hl", "ETH", "open"), null);
  assert.equal(blockedBy(working, "mfp", "BTC", "open"), null);
  assert.match(blockText(working[0]), /already in flight/);
});

test("F5: an unresolved write (verifying or unknown) blocks new exposure, and never blocks a close or a cancel", () => {
  for (const out of [yes(), lost()]) {
    const it = answered(marketBuy(), out).item;
    assert.equal(blockedBy([it], "hl", "BTC", "open").id, "p1");
    assert.equal(blockedBy([it], "hl", "BTC", "reduce"), null);
    assert.match(blockText(it), /not settled .*BUY 0.05 BTC/);
  }
});

test("a write in flight wins over an unresolved one when both sit on the market", () => {
  const unknown = { ...answered(marketBuy(), lost()).item, id: "p0" };
  const working = { ...marketBuy(), id: "p2" };
  assert.equal(blockedBy([unknown, working], "hl", "BTC", "reduce").id, "p2");
  assert.equal(blockedBy([unknown, working], "hl", "BTC", "open").id, "p2");
});

// ---- R2: the effect must be THIS write's -----------------------------------------

const limitBuy = (over = {}) => item("order", { kind: "order", side: "buy", type: "limit", size: 1, price: 90, from: 0, before: ["hl:5"] }, { size: 1, price: 90, label: "BUY 1 BTC limit 90", ...over });
const open = (resting) => ({ status: "open", full: false, filled: 0, message: "open", resting });

test("R2: another order's fill does not confirm a limit whose answer was lost", () => {
  const it = answered(limitBuy(), lost()).item;
  // order hl:5 (already resting) filled 1: the position moved by exactly this order's size
  const otherFilled = view([pos("long", 1)], []);
  assert.equal(wantsLookup(it, otherFilled, T0 + 200), true);          // the venue is still asked about THIS order
  assert.equal(onRead(it, read(otherFilled, T0 + 200)).item, it);
  assert.equal(onRead(it, read(otherFilled, T0 + 200, { status: "unreadable", full: false, filled: 0, message: null })).item, it);
  assert.equal(blockedBy([it], "hl", "BTC", "open").id, "p1");          // and the market stays locked for new exposure
});

test("R2: a lost limit settles on its own identity or its own status", () => {
  const it = answered(limitBuy(), lost()).item;
  // it rests under the id this app gave it
  const mine = ord(6, "buy", "limit", 90, 1, { ref: { kind: "hl", dex: "", oid: 6, cloid: CLOID, isTrigger: false } });
  assert.equal(onRead(it, read(view([], [mine]), T0 + 200)).log.state, "confirmed");
  // the open-orders rows carry no id, but the venue's status for the order says it rests
  const r = onRead(it, read(view([], [ord(6, "buy", "limit", 90, 1)]), T0 + 200, open(true)));
  assert.equal(r.item, null);
  assert.equal(r.log.state, "confirmed");
  assert.match(r.log.text, /resting \(the venue's order status\)/);
  // "open" but not on the book yet (still being placed): keep waiting
  assert.equal(onRead(it, read(view([]), T0 + 200, open(false))).item, it);
  // it filled at once: its status says so
  assert.equal(onRead(it, read(view([pos("long", 1)]), T0 + 200, { status: "done", full: true, filled: 1, message: "filled" })).log.state, "confirmed");
});

test("R2: a lost-answer market order is never confirmed by the position, only by its own status", () => {
  const it = answered(marketBuy(), lost()).item;
  const moved = view([pos("long", 0.05)]);
  assert.equal(onRead(it, read(moved, T0 + 500)).item, it);
  assert.equal(wantsLookup(it, moved, T0 + 500), true);
  const r = onRead(it, read(moved, T0 + 500, { status: "done", full: true, filled: 0.05, message: "filled" }));
  assert.equal(r.item, null);
  assert.equal(r.log.state, "confirmed");
  // the venue never saw it and the payload is dead: it did not arrive,
  // whatever moved the position
  const dead = onRead(it, read(moved, T0 + 21_000, { status: "unseen", full: false, filled: 0, message: null }));
  assert.equal(dead.log.state, "rejected");
  assert.match(dead.log.text, /did not reach the venue/);
});

test("R2: a close is judged on the position the adapter sized it on, not on the shown one", () => {
  // shown 1; the venue had already shrunk to 0.5, so Close 50% sent 0.25
  const out = yes({ filled: null, ref: null, sized: { from: 0.5, size: 0.25 } });
  assert.deepEqual(expectsFor(closeWant(1, 0.5), out), [{ type: "remaining", side: "long", max: 0.25, by: 0.25 }]);
  const c = answered(item("close", closeWant(1, 0.5)), out).item;
  assert.equal(onRead(c, read(view([pos("long", 0.5)]), T0 + 200)).item, c);        // unchanged: the old rule confirmed here
  assert.equal(onRead(c, read(view([pos("long", 0.25)]), T0 + 200)).item, null);
});

test("R2: a close whose answer was lost is not confirmed by a smaller position", () => {
  const c = answered(item("close", closeWant(1, 0.5)), lost({ sized: { from: 0.5, size: 0.25 } })).item;
  assert.deepEqual(c.expects, [{ type: "status" }]);
  assert.equal(onRead(c, read(view([pos("long", 0.25)]), T0 + 200)).item, c);
  assert.equal(onRead(c, read(view([]), T0 + 200)).item, c);
  assert.equal(blockedBy([c], "hl", "BTC", "reduce"), null);                        // another close is never locked behind it
  assert.equal(onRead(c, read(view([pos("long", 0.25)]), T0 + 200, { status: "done", full: true, filled: 0.25, message: "filled" })).log.state, "confirmed");
});

test("R2: the tolerance is always smaller than the close - an unchanged position never passes", () => {
  const e = { type: "remaining", side: "long", max: 9999.999, by: 0.001 };
  assert.equal(checkExpect(e, view([pos("long", 10000)]), "hl", "BTC"), false);    // nothing closed
  assert.equal(checkExpect(e, view([pos("long", 9999.999)]), "hl", "BTC"), true);
  assert.equal(checkExpect(e, view([pos("long", 9999.9993)]), "hl", "BTC"), true);  // rounding, under half the close
});

test("nothing to check is not 'all of it shows'", () => {
  assert.equal(checkAll([], view([pos("long", 1)]), "hl", "BTC"), false);
});

// ---- R3: a move keeps its order's identity ----------------------------------------

const moveWant = { kind: "modify", orderKey: "hl:1", side: "buy", orderKind: "limit", price: 95, size: null, fromPrice: 90, before: ["hl:1", "hl:2"] };
const moveItem = () => item("modify", moveWant, { label: "move limit BTC to 95", orderKey: "hl:1", price: 95, size: 1 });
const lostMove = (over = {}) => ({ state: "rejected", message: "transport: timed out; the order is unchanged", ambiguous: true, ref: REF, price: 95, deadAfter: T0 + 20_000, ...over });
const A = (px, over = {}) => ord(1, "buy", "limit", px, 1, over);
const B = ord(2, "buy", "limit", 95, 1);

test("R3: another order already resting at the new price does not confirm a move", () => {
  const it = answered(moveItem(), lostMove()).item;
  assert.equal(it.state, "unknown");
  assert.equal(onRead(it, read(view([], [A(90), B]), T0 + 200)).item, it);          // A unchanged, B is not A
  assert.equal(checkAll(it.expects, view([], [A(90), B]), "hl", "BTC"), false);
});

test("R3: a move is confirmed by the replacement's id or by the same order at its new price", () => {
  const it = answered(moveItem(), lostMove()).item;
  // Hyperliquid: the order was replaced; the new one carries this app's id
  const repl = ord(7, "buy", "limit", 95, 1, { ref: { kind: "hl", dex: "", oid: 7, cloid: CLOID, isTrigger: false } });
  assert.equal(onRead(it, read(view([], [repl, B]), T0 + 200)).log.state, "confirmed");
  // the venue kept the order's id (MFP): the same order now sits at 95
  assert.equal(onRead(it, read(view([], [A(95), B]), T0 + 200)).log.state, "confirmed");
  // an order that did not exist before, at another price, is not it
  assert.equal(onRead(it, read(view([], [ord(7, "buy", "limit", 93, 1), B]), T0 + 200)).item, it);
});

test("T3: a NEW look-alike order at the new price never confirms a move while the original is unchanged", () => {
  const it = answered(moveItem(), lostMove()).item;
  // the audit's probe: order 1 still at 90, an order 2 appears at 95 with another cloid
  const other = ord(8, "buy", "limit", 95, 1, { ref: { kind: "hl", dex: "", oid: 8, cloid: "0x" + "cd".repeat(16), isTrigger: false } });
  assert.equal(onRead(it, read(view([], [A(90), other]), T0 + 200)).item, it);
  // nor one with no id at all (the rows may not carry it)
  assert.equal(onRead(it, read(view([], [A(90), ord(9, "buy", "limit", 95, 1)]), T0 + 200)).item, it);
  // the replacement is not on the book by its id: it is asked about, and its own status settles it
  assert.equal(wantsLookup(it, view([], [A(90), other]), T0 + 200), true);
  const r = onRead(it, read(view([], [A(90), other]), T0 + 200, { status: "open", full: false, filled: 0, message: "open", resting: true }));
  assert.equal(r.log.state, "confirmed");
  assert.match(r.log.text, /the venue's status for the replacement order/);
});

test("R3: a move keeps the replacement's id, so a replacement that FILLED is not read as 'did not apply'", () => {
  const it = answered(moveItem(), lostMove()).item;
  assert.deepEqual(it.ref, REF);
  // after the expiry: the position is there, nothing rests (the replacement filled)
  const after = view([pos("long", 1)], [B]);
  assert.equal(wantsLookup(it, after, T0 + 21_000), true);
  const r = onRead(it, read(after, T0 + 21_000, { status: "done", full: true, filled: 1, message: "filled" }));
  assert.equal(r.item, null);
  assert.equal(r.log.state, "partial");
  assert.match(r.log.text, /it executed/);
  // without the venue's status for it, an order that is simply not there settles nothing
  assert.equal(onRead(it, read(after, T0 + 21_000)).item, it);
  assert.equal(onRead(it, read(after, T0 + 21_000, { status: "unreadable", full: false, filled: 0, message: null })).item, it);
});

test("R3: 'did not apply' needs the venue not knowing the replacement AND the original still resting", () => {
  const it = answered(moveItem(), lostMove()).item;
  const unseen = { status: "unseen", full: false, filled: 0, message: null };
  assert.equal(onRead(it, read(view([], [A(90), B]), T0 + 5_000, unseen)).item, it);    // before the expiry: nothing
  const same = onRead(it, read(view([], [A(90), B]), T0 + 21_000, unseen));
  assert.equal(same.log.state, "rejected");
  assert.match(same.log.text, /did not apply: the order is unchanged/);
  const gone = onRead(it, read(view([], [B]), T0 + 21_000, unseen));
  assert.equal(gone.log.state, "partial");
  assert.match(gone.log.text, /the order is gone and the venue does not know the replacement/);
});

test("R3: an order that existed before the move is watched, never taken as proof (MFP keeps the id)", () => {
  const want = { ...moveWant, orderKey: "mfp:ord_1", before: ["mfp:ord_1"] };
  const watch = { venue: "mfp", clientOrderId: "tt-open-1" };
  const it = answered(item("modify", want, { venue: "mfp", orderKey: "mfp:ord_1" }), { state: "rejected", message: "transport: timed out; the order is unchanged", ambiguous: true, price: 95, watch }).item;
  assert.deepEqual(it.ref, watch);                                                     // asked about ...
  const row = (px) => ord(1, "buy", "limit", px, 1, { key: "mfp:ord_1", venue: "mfp", ref: { kind: "mfp", orderId: "ord_1", clientOrderId: "tt-open-1", positionId: null } });
  assert.equal(onRead(it, read(view([], [row(90)]), T0 + 200)).item, it);              // ... but its presence at the old price proves nothing
  assert.equal(onRead(it, read(view([], [row(90)]), T0 + 200, open(true))).item, it);  // nor does "it rests"
  assert.equal(onRead(it, read(view([], [row(95)]), T0 + 200)).log.state, "confirmed");
  // the order filled before the move could be seen: its own fate settles the move
  const r = onRead(it, read(view([pos("long", 1, { venue: "mfp" })], []), T0 + 200, { status: "done", full: true, filled: 1, message: "filled" }));
  assert.equal(r.log.state, "partial");
});

test("R3: a dragged exit follows the same identity rules", () => {
  const want = { kind: "exit", exit: "sl", side: "sell", price: 77000, fromPrice: 77500, orderKey: "hl:40", before: ["hl:40", "hl:41"] };
  const it = answered(item("sl", want, { orderKey: "hl:40", side: "sell" }), lostMove({ price: 77000 })).item;
  const other = ord(41, "sell", "sl", 77000, 0.05);                                    // another stop already at 77000
  assert.equal(onRead(it, read(view([pos("long", 0.05)], [ord(40, "sell", "sl", 77500, 0.05), other]), T0 + 200)).item, it);
  // a new stop at 77000 with no id is not the replacement (T3) ...
  assert.equal(onRead(it, read(view([pos("long", 0.05)], [ord(42, "sell", "sl", 77000, 0.05), other]), T0 + 200)).item, it);
  // ... the replacement carrying this app's id is
  const repl = ord(42, "sell", "sl", 77000, 0.05, { ref: { kind: "hl", dex: "", oid: 42, cloid: CLOID, isTrigger: true } });
  assert.equal(onRead(it, read(view([pos("long", 0.05)], [repl, other]), T0 + 200)).log.state, "confirmed");
});

// ---- R5: "partial" never erases a write that is still alive ------------------------

test("R5: Flat with a lost cancel - the sequence's line is logged and the cancel stays on the ledger", () => {
  const live = [{ kind: "cancel", orderKeys: ["hl:1", "hl:2"], message: "transport: timed out; the order still rests", deadAfter: T0 + 20_000 }];
  const a = answered(item("flat", { kind: "flat", side: "long" }, { side: "sell", label: "flat BTC" }), { state: "partial", message: "flat, but the cancel's answer was lost", ambiguous: true, live });
  assert.equal(a.item, null);
  assert.equal(a.legs.length, 1);
  const c = a.legs[0];
  assert.equal(c.kind, "cancel");
  assert.equal(c.state, "unknown");
  assert.equal(c.deadAfter, T0 + 20_000);
  assert.deepEqual(a.logs.map((l) => l.state), ["partial", "unknown"]);
  // it holds the market: no move of the still-shown order, no new exposure; exits stay open
  assert.equal(blockedBy([c], "hl", "BTC", "open").id, c.id);
  assert.equal(blockedBy([c], "hl", "BTC", "reduce"), null);
  const rests = view([], [A(90), B]);
  assert.equal(onRead(c, read(rests, T0 + 5_000)).item, c);                              // the cancel can still land
  // one of the two gone is not "the cancel landed"
  assert.equal(onRead(c, read(view([], [B]), T0 + 5_000)).item, c);
  assert.equal(onRead(c, read(view([], []), T0 + 5_000)).log.state, "confirmed");
  const dead = onRead(c, read(rests, T0 + 21_000));
  assert.equal(dead.item, null);
  assert.equal(dead.log.state, "rejected");
  assert.match(dead.log.text, /did not apply: the order still rests/);
});

test("R5: a cancel with no expiry (MFP) stays until the venue shows the order gone", () => {
  const live = [{ kind: "cancel", orderKeys: ["mfp:ord_9"], message: "answer lost", deadAfter: null }];
  const c = answered(item("flat", { kind: "flat", side: "long" }, { venue: "mfp", side: "sell" }), { state: "partial", message: "flat, but a cancel's answer was lost", ambiguous: true, live }).legs[0];
  const rests = view([], [ord(9, "buy", "limit", 70000, 0.05, { key: "mfp:ord_9", venue: "mfp" })]);
  assert.equal(onRead(c, read(rests, T0 + 3_600_000, null, T0 + 3_600_000)).item, c);
  assert.equal(onRead(c, read(view([], []), T0 + 3_600_000)).item, null);
});

test("R5: a reverse stopped on a close the venue is still working on - the close stays on the ledger", () => {
  const ref = { venue: "mfp", clientOrderId: "tt-rev-close-1" };
  const live = [{ kind: "close", state: "sent", ref, message: "close still pending on MFP", deadAfter: null }];
  const rev = item("reverse", { kind: "reverse", side: "short" }, { venue: "mfp", side: "sell", size: 1, posKey: "mfp:BTC", label: "reverse BTC" });
  const a = answered(rev, { state: "partial", message: "the close is still pending; no opening order was sent", ambiguous: false, live });
  assert.equal(a.item, null);
  const c = a.legs[0];
  assert.equal(c.kind, "close");
  assert.equal(c.state, "verifying");
  assert.deepEqual(c.ref, ref);
  assert.deepEqual(c.expects, [{ type: "status" }]);
  // the market is locked for new exposure while the close is alive (the old rule dropped it here)
  assert.equal(blockedBy([c], "mfp", "BTC", "open").id, c.id);
  assert.equal(blockedBy([c], "mfp", "BTC", "reduce"), null);
  const held = view([pos("long", 1, { venue: "mfp" })]);
  assert.equal(onRead(c, read(held, T0 + 200, open(false))).item, c);
  // a flat position does not say THIS close did it (and it may still be working): only its status does
  assert.equal(onRead(c, read(view([]), T0 + 200)).item, c);
  assert.equal(onRead(c, read(view([]), T0 + 200, open(false))).item, c);
  assert.equal(onRead(c, read(held, T0 + 200, { status: "done", full: true, filled: 0, message: "filled" })).log.state, "confirmed");
  const no = onRead(c, read(held, T0 + 200, { status: "done", full: false, filled: 0, message: "rejected: market closed" }));
  assert.equal(no.log.state, "rejected");
  assert.match(no.log.text, /did not execute/);
});

test("R5: a close leg whose answer was lost settles on that order's status only", () => {
  const ref = { venue: "mfp", clientOrderId: "tt-rev-close-2" };
  const live = [{ kind: "close", state: "unknown", ref, message: "no close order found", deadAfter: null }];
  const c = answered(item("reverse", { kind: "reverse", side: "short" }, { venue: "mfp", side: "sell" }), { state: "partial", message: "stopped", ambiguous: true, live }).legs[0];
  assert.equal(c.state, "unknown");
  assert.deepEqual(c.expects, [{ type: "status" }]);
  assert.equal(onRead(c, read(view([]), T0 + 200)).item, c);
});

// ---- R6: exits attached to an entry that has not filled yet -------------------------

const MREF = { venue: "mfp", clientOrderId: "tt-open-7" };
const waiting = [
  { kind: "sl", price: 90, state: "waiting", message: null, orderKey: null, ref: null, deadAfter: null },
  { kind: "tp", price: 110, state: "waiting", message: null, orderKey: null, ref: null, deadAfter: null },
];
const mfpEntry = (type, over = {}) => item("order", { kind: "order", side: "buy", type, size: 1, price: type === "limit" ? 99 : null, from: 0, before: ["mfp:ord_1"] }, { venue: "mfp", size: 1, label: "BUY 1 BTC", ...over });
const mfpPos = (size) => pos("long", size, { venue: "mfp", key: "mfp:BTC" });
const mfpOrd = (n, side, kind, px) => ord(n, side, kind, px, 1, { key: "mfp:ord_" + n, venue: "mfp" });

test("R6: exits asked for with an entry the venue is still placing ride on the entry, then become their own items", () => {
  const a = answered(mfpEntry("market"), { state: "pending", message: "still pending on MFP", ambiguous: false, ref: MREF, legs: waiting });
  assert.equal(a.legs.length, 0);
  assert.deepEqual(a.item.exits, [{ kind: "sl", price: 90 }, { kind: "tp", price: 110 }]);
  // A position on the market does not say this entry filled: the venue is
  // still placing it, and another order's fill moves the position just the
  // same. Only the order's own status settles it.
  assert.deepEqual(a.item.expects, [{ type: "status" }]);
  assert.equal(onRead(a.item, read(view([mfpPos(1)], []), T0 + 200)).item, a.item);
  assert.equal(onRead(a.item, read(view([mfpPos(1)], []), T0 + 200, open(false))).item, a.item);
  // the venue says the entry filled, with NO exits on the venue (the audit's probe)
  let n = 0;
  const r = onRead(a.item, read(view([mfpPos(1)], []), T0 + 200, { status: "done", full: true, filled: 1, message: "filled" }), () => "x" + ++n);
  assert.equal(r.item, null);
  assert.equal(r.log.state, "confirmed");
  assert.deepEqual(r.legs.map((l) => [l.kind, l.price, l.state, l.side]), [["sl", 90, "verifying", "sell"], ["tp", 110, "verifying", "sell"]]);
  assert.deepEqual(r.legs.map((l) => l.id), ["x1", "x2"]);
  assert.equal(r.logs.length, 2);
  const sl = r.legs[0];
  // each leg holds the market and is confirmed only when the venue shows that exit
  assert.equal(blockedBy([sl], "mfp", "BTC", "open").id, "x1");
  const later = T0 + 400;
  assert.equal(onRead(sl, read(view([mfpPos(1)], []), later)).item, sl);
  assert.equal(onRead(sl, read(view([mfpPos(1)], [mfpOrd(1, "sell", "sl", 90)]), later)).item, sl);   // rested BEFORE the entry: not it
  assert.equal(onRead(sl, read(view([mfpPos(1)], [mfpOrd(2, "sell", "sl", 90)]), later)).log.state, "confirmed");
  // never shown: flagged, never dropped
  const at = later + STALE_MS + 1;
  const flagged = onRead(sl, read(view([mfpPos(1)], []), at, null, at));
  assert.equal(flagged.item.state, "unknown");
  assert.match(flagged.log.text, /sl BTC at 90: not shown by the venue/);
});

test("R6: a resting entry reports each attached exit as not yet verifiable, and does not drop it", () => {
  const a = answered(mfpEntry("limit"), { state: "confirmed", message: "resting", ambiguous: false, orderKey: "mfp:ord_5", ref: MREF, legs: waiting });
  assert.equal(a.item.exits.length, 2);
  let n = 0;
  const id = () => "w" + ++n;
  const book = view([], [mfpOrd(5, "buy", "limit", 99)]);
  const r = onRead(a.item, read(book, T0 + 200), id);
  assert.equal(r.item, null);
  assert.equal(r.log.state, "confirmed");
  assert.equal(r.legs.length, 0);
  assert.deepEqual(r.logs.map((l) => l.state), ["unknown", "unknown"]);
  assert.match(r.logs[0].text, /sl BTC at 90: attached to the resting order .* it is checked then/);
  // the entry is settled (it locks nothing), and its exits go on a watch
  const w = r.watch;
  assert.deepEqual(w.entry, { type: "order", key: "mfp:ord_5", resting: true });
  assert.deepEqual(w.ref, MREF);
  assert.deepEqual(w.exits, [{ kind: "sl", price: 90 }, { kind: "tp", price: 110 }]);

  // while the entry rests, nothing happens and the venue is not asked
  assert.equal(wantsWatchLookup(w, book), false);
  assert.equal(onWatch(w, { view: book, lookup: null, now: T0 + 300 }, id).keep, true);
  // it has left the book: the venue is asked, and no answer keeps the watch
  const gone = view([mfpPos(1)], []);
  assert.equal(wantsWatchLookup(w, gone), true);
  assert.equal(onWatch(w, { view: gone, lookup: null, now: T0 + 300 }, id).keep, true);
  assert.equal(onWatch(w, { view: gone, lookup: { status: "unreadable", full: false, filled: 0, message: null }, now: T0 + 300 }, id).keep, true);
  assert.equal(onWatch(w, { view: gone, lookup: open(true), now: T0 + 300 }, id).keep, true);       // being replaced by a move
  // the venue says it filled: each exit becomes its own pending item
  const filled = onWatch(w, { view: gone, lookup: { status: "done", full: true, filled: 1, message: "filled" }, now: T0 + 300 }, id);
  assert.equal(filled.keep, false);
  assert.deepEqual(filled.legs.map((l) => [l.kind, l.price, l.state, l.side, l.venue]), [["sl", 90, "verifying", "sell", "mfp"], ["tp", 110, "verifying", "sell", "mfp"]]);
  assert.equal(blockedBy(filled.legs, "mfp", "BTC", "open").kind, "sl");
  // the venue says it was cancelled unfilled: the exits went with it, and that is said
  const dead = onWatch(w, { view: view([], []), lookup: { status: "done", full: false, filled: 0, message: "canceled" }, now: T0 + 300 }, id);
  assert.equal(dead.keep, false);
  assert.equal(dead.legs.length, 0);
  assert.match(dead.logs[0].text, /sl BTC at 90: its entry ended without filling \(canceled\)/);
  // cancelled after a partial fill: there is a position to protect
  assert.equal(onWatch(w, { view: gone, lookup: { status: "done", full: false, filled: 0.4, message: "canceled" }, now: T0 + 300 }, id).legs.length, 2);
});

test("R6: a watched entry the venue cannot be asked about is reported, never dropped silently", () => {
  const w = { id: "w1", venue: "mfp", marketId: "BTC", symbol: "BTC", side: "buy", label: "BUY 1 BTC limit 99", entry: { type: "order", key: "mfp:ord_5" }, ref: null, exits: [{ kind: "sl", price: 90 }], before: [] };
  const r = onWatch(w, { view: view([], []), lookup: null, now: T0 }, () => "x");
  assert.equal(r.keep, false);
  assert.equal(r.logs[0].state, "rejected");
  assert.match(r.logs[0].text, /NOT verified/);
});

test("an entry or a close the venue is still placing is settled by its own status, not by the position", () => {
  const ref = { venue: "mfp", clientOrderId: "tt-open-9" };
  const want = { kind: "order", side: "buy", type: "market", size: 1, price: null, from: 0, before: [] };
  assert.deepEqual(expectsFor(want, { state: "pending", message: "still pending on MFP", ambiguous: false, ref }), [{ type: "status" }]);
  assert.deepEqual(expectsFor(closeWant(1, 1), { state: "pending", message: "close still pending on MFP", ambiguous: false, ref, sized: { from: 1, size: 1 } }), [{ type: "status" }]);
  // once the venue says it filled, the position must show that fill
  assert.deepEqual(expectsFor(want, { state: "confirmed", message: "filled", ambiguous: false, ref, filled: 1 }), [{ type: "moved", from: 0, dir: 1, min: 1 }]);
});

test("a Flat or Reverse whose answer was lost and that is not complete after the expiry did not 'not apply'", () => {
  const f = answered(item("flat", { kind: "flat", side: "long" }, { label: "flat BTC" }), { state: "unknown", message: "answer lost", ambiguous: true, deadAfter: T0 + 20_000 }).item;
  const r = onRead(f, read(view([pos("long", 0.02)]), T0 + 21_000));     // the IoC closed part of it
  assert.equal(r.log.state, "rejected");
  assert.match(r.log.text, /flat BTC: did not complete: the position is still open .* - check the position/);
});

test("R6: an entry whose answer was lost keeps its exits until its own status says what happened", () => {
  const a = answered(mfpEntry("market"), { state: "unknown", message: "answer lost", ambiguous: true, ref: MREF, legs: waiting });
  assert.equal(a.item.state, "unknown");
  assert.equal(a.item.exits.length, 2);
  const filled = onRead(a.item, read(view([mfpPos(1)]), T0 + 200, { status: "done", full: true, filled: 1, message: "filled" }));
  assert.equal(filled.log.state, "confirmed");
  assert.equal(filled.legs.length, 2);
  // it never executed: there is nothing to protect and nothing to report
  const dead = onRead(a.item, read(view([]), T0 + 200, { status: "done", full: false, filled: 0, message: "rejected" }));
  assert.equal(dead.log.state, "rejected");
  assert.equal(dead.legs.length, 0);
  assert.equal(dead.logs.length, 0);
  // dismissed by the user: each exit is named as never seen
  assert.deepEqual(dismissedExits(a.item).map((l) => l.state), ["rejected", "rejected"]);
  assert.match(dismissedExits(a.item)[0].text, /sl BTC at 90 NOT verified/);
});

test("R6: a refused entry carries no exits to wait for", () => {
  const a = answered(mfpEntry("market"), { state: "rejected", message: "insufficient margin", ambiguous: false, ref: MREF, legs: [] });
  assert.equal(a.item, null);
  assert.equal(a.legs.length, 0);
});

// ---- a reverse whose OPENING order's answer was lost (first review, F7 remainder) -------

test("a reverse's lost opening order is settled by that order's status, not by a position on the new side", () => {
  const rev = item("reverse", { kind: "reverse", side: "short" }, { side: "sell", label: "reverse BTC" });
  const it = answered(rev, { state: "unknown", message: "closed; the opening order's answer was lost", ambiguous: true, ref: REF, deadAfter: T0 + 20_000 }).item;
  assert.deepEqual(it.expects, [{ type: "status" }]);
  assert.deepEqual(it.ref, REF);
  // a short appears (something else opened it): not this order's proof
  const short = view([pos("short", 0.05)]);
  assert.equal(onRead(it, read(short, T0 + 500)).item, it);
  assert.equal(wantsLookup(it, short, T0 + 500), true);
  assert.equal(blockedBy([it], "hl", "BTC", "open").id, "p1");
  const ok = onRead(it, read(short, T0 + 500, { status: "done", full: true, filled: 0.05, message: "filled" }));
  assert.equal(ok.log.state, "confirmed");
  assert.match(ok.log.text, /closed and reopened/);
  const none = onRead(it, read(view([]), T0 + 500, { status: "done", full: false, filled: 0, message: "canceled" }));
  assert.equal(none.log.state, "partial");
  assert.match(none.log.text, /closed; the opening order did not execute/);
  const dead = onRead(it, read(view([]), T0 + 21_000, { status: "unseen", full: false, filled: 0, message: null }));
  assert.equal(dead.log.state, "partial");                 // half done, never "rejected": the close ran
  assert.match(dead.log.text, /closed; the opening order did not reach the venue/);
  // a reverse the venue answered for keeps its plain expectation
  assert.deepEqual(answered(rev, yes({ ref: null })).item.expects, [{ type: "side", side: "short" }]);
});

// ---- the third review ----------------------------

test("T2: a limit the venue is still placing (a 'pending' row) is not proof it rests, by id or by key", () => {
  const it = answered(mfpEntry("limit"), { state: "pending", message: "still pending on MFP", ambiguous: false, ref: MREF, legs: waiting }).item;
  const row = (status) => ord(5, "buy", "limit", 99, 1, { key: "mfp:ord_5", venue: "mfp", status, ref: { kind: "mfp", orderId: "ord_5", clientOrderId: MREF.clientOrderId, positionId: null } });
  assert.equal(onRead(it, read(view([], [row("pending")]), T0 + 200)).item, it);
  assert.equal(onRead(it, read(view([], [row("pending")]), T0 + 200, open(false))).item, it);
  // and it is flagged, not dropped, while the venue keeps calling it pending
  const at = T0 + 200 + STALE_MS + 1;
  const flagged = onRead(it, read(view([], [row("pending")]), at, open(false), at));
  assert.equal(flagged.item.state, "unknown");
  assert.equal(blockedBy([flagged.item], "mfp", "BTC", "open").id, flagged.item.id);
  // once it rests: settled as resting, its exits on a watch
  const r = onRead(it, read(view([], [row("resting")]), T0 + 200));
  assert.equal(r.log.state, "confirmed");
  assert.ok(r.watch);
});

test("T1: a reverse whose opening order MFP is still working on keeps that order's id and settles on its status only", () => {
  const ref = { venue: "mfp", clientOrderId: "tt-rev-open-1" };
  const rev = item("reverse", { kind: "reverse", side: "short" }, { venue: "mfp", side: "sell", size: 1, label: "reverse BTC" });
  const it = answered(rev, { state: "pending", message: "closed; open still pending on MFP", ambiguous: false, ref }).item;
  assert.deepEqual(it.ref, ref);
  assert.deepEqual(it.expects, [{ type: "status" }]);
  // an unrelated short appears: it does not say the opening order opened it
  const short = view([pos("short", 1, { venue: "mfp", key: "mfp:BTC" })]);
  assert.equal(onRead(it, read(short, T0 + 200)).item, it);
  assert.equal(wantsLookup(it, short, T0 + 200), true);
  // the venue says the opening order was rejected: closed, nothing reopened
  const no = onRead(it, read(view([]), T0 + 200, { status: "done", full: false, filled: 0, message: "rejected" }));
  assert.equal(no.log.state, "partial");
  assert.match(no.log.text, /the opening order did not execute/);
});

test("T4: a resting entry that already executed in part hands its exits over at once, not when the rest fills", () => {
  const a = answered(mfpEntry("limit"), { state: "confirmed", message: "resting", ambiguous: false, orderKey: "mfp:ord_5", ref: MREF, legs: waiting });
  const part = ord(5, "buy", "limit", 99, 0.6, { key: "mfp:ord_5", venue: "mfp", filled: 0.4 });
  let n = 0;
  const r = onRead(a.item, read(view([mfpPos(0.4)], [part]), T0 + 200), () => "t" + ++n);
  assert.equal(r.log.state, "confirmed");
  assert.equal(r.watch, null);
  assert.deepEqual(r.legs.map((l) => [l.kind, l.state]), [["sl", "verifying"], ["tp", "verifying"]]);
  assert.match(r.logs[0].text, /part of the entry filled \(it still rests\)/);
});

test("T4: a watched resting entry that fills in part while still on the book releases its exits for checking", () => {
  const a = answered(mfpEntry("limit"), { state: "confirmed", message: "resting", ambiguous: false, orderKey: "mfp:ord_5", ref: MREF, legs: waiting });
  const w = onRead(a.item, read(view([], [mfpOrd(5, "buy", "limit", 99)]), T0 + 200)).watch;
  assert.equal(onWatch(w, { view: view([], [mfpOrd(5, "buy", "limit", 99)]), lookup: null, now: T0 + 300 }, nextId).keep, true);
  const part = ord(5, "buy", "limit", 99, 0.6, { key: "mfp:ord_5", venue: "mfp", filled: 0.4 });
  const r = onWatch(w, { view: view([mfpPos(0.4)], [part]), lookup: null, now: T0 + 400 }, nextId);
  assert.equal(r.keep, false);
  assert.deepEqual(r.legs.map((l) => l.kind), ["sl", "tp"]);
});

test("T4: an entry the venue is still working on that executed in part hands its exits over and stays pending", () => {
  const it = answered(mfpEntry("market"), { state: "pending", message: "still pending on MFP", ambiguous: false, ref: MREF, legs: waiting }).item;
  const r = onRead(it, read(view([mfpPos(0.4)], []), T0 + 200, { status: "open", full: false, filled: 0.4, message: "pending", resting: false }));
  assert.equal(r.item.exits.length, 0);
  assert.deepEqual(r.item.expects, [{ type: "status" }]);
  assert.deepEqual(r.legs.map((l) => l.kind), ["sl", "tp"]);
  // the entry itself still settles on its own status
  assert.equal(onRead(r.item, read(view([mfpPos(1)], []), T0 + 300, { status: "done", full: true, filled: 1, message: "filled" })).log.state, "confirmed");
});

test("T4: an entry that ended in part (a 'partial' answer) still gets its exits checked, each by itself", () => {
  const legs = waiting.map((l) => ({ ...l, state: "sent" }));
  const a = answered(mfpEntry("limit"), { state: "partial", message: "canceled; 0.4 executed before it ended", ambiguous: false, ref: MREF, legs });
  assert.equal(a.item, null);
  assert.equal(a.logs[0].state, "partial");
  assert.deepEqual(a.legs.map((l) => [l.kind, l.state]), [["sl", "verifying"], ["tp", "verifying"]]);
});

test("T7: a size-only move is checked at the size the venue took the order to, exactly", () => {
  const want = { kind: "modify", orderKey: "mfp:ord_1", side: "buy", orderKind: "limit", price: 90, size: 0.12345, fromPrice: 90, before: ["mfp:ord_1"] };
  const it = answered(item("modify", want, { venue: "mfp", orderKey: "mfp:ord_1" }), { state: "confirmed", message: "moved", ambiguous: false, price: 90, size: 0.123, watch: MREF }).item;
  const row = (size) => ord(1, "buy", "limit", 90, size, { key: "mfp:ord_1", venue: "mfp" });
  assert.equal(onRead(it, read(view([], [row(1)]), T0 + 200)).item, it);                     // the old size: not moved
  assert.equal(onRead(it, read(view([], [row(0.123)]), T0 + 200)).log.state, "confirmed");   // the floored size: moved
  // without the venue's size, the asked size is checked
  const raw = answered(item("modify", want, { venue: "mfp", orderKey: "mfp:ord_1" }), { state: "confirmed", message: "moved", ambiguous: false, price: 90, watch: MREF }).item;
  assert.equal(onRead(raw, read(view([], [row(0.123)]), T0 + 200)).item, raw);
});

test("a size-only move allows the venue's price rounding (the size tells it apart)", () => {
  const want = { kind: "modify", orderKey: "mfp:ord_1", side: "buy", orderKind: "limit", price: 90, size: 0.5, fromPrice: 90, before: ["mfp:ord_1"] };
  const it = answered(item("modify", want, { venue: "mfp", orderKey: "mfp:ord_1" }), { state: "confirmed", message: "moved", ambiguous: false, price: 90, watch: MREF }).item;
  const row = (px, size) => ord(1, "buy", "limit", px, size, { key: "mfp:ord_1", venue: "mfp" });
  assert.equal(onRead(it, read(view([], [row(90.00000001, 0.5)]), T0 + 200)).log.state, "confirmed");
  assert.equal(onRead(it, read(view([], [row(90, 1)]), T0 + 200)).item, it);
});
