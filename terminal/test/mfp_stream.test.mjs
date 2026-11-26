// MyFundedPerps' account stream as a CHANGE SIGNAL:
// - src/lib/mfp_stream_core.ts (pure): a frame's envelope, what it asks the
//   app to read, the resume / back-off rules;
// - src/lib/mfp_stream.ts (the real module in a test world): both
//   transports, driven by a scripted stream;
// - src/lib/venue_store.ts over the real adapter and exchange client: what
//   a signal costs in GETs, and that nothing pushed is ever shown or
//   settles a write.
// Frame FIELD NAMES here are from MFP's doc (the envelope names were later
// checked read-only against the sandbox stream). No key, account or venue
// is real.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  closeCodeOf, isLive, LADDER_MS, MAX_FRAME_CHARS, newCore, onAttempt, onClosed, onFrame, onOpen, parseFrame, refusedStatus, RESUME_HOLD_MS, resumeQuery, statusOf, STEADY_MS, touch, WATCHDOG_MS, watchdogDue,
} from "../src/lib/mfp_stream_core.ts";
import { MAX_FRAME_BYTES } from "../server/mfp_stream_relay.mjs";
import { fakeSettings, json, makeWorld } from "./helpers/world.mjs";

const ACCT = "acct_fake";
const T0 = 1_700_000_000_000;
const frame = (o) => parseFrame(JSON.stringify(o));
// Feed frames; returns the core and every signal raised, in order.
function feed(core, frames, now = T0) {
  const signals = [];
  let reconnect = false;
  for (const f of frames) {
    const step = onFrame(core, frame(f), now);
    core = step.core;
    signals.push(...step.signals);
    reconnect = reconnect || step.reconnect;
  }
  return { core, signals, reconnect };
}
const opened = (accountId = ACCT) => onOpen(newCore(accountId), T0);
const OPENING = [
  { type: "hello", stream_id: "strm_1", environment: "sandbox", resumed: false },
  { type: "snapshot", account_id: ACCT, seq: 1, time: T0, orders: [{ id: "o1" }], positions: [] },
  { type: "snapshot_end", seq_through: 1 },
];

// ---- the envelope ----------------------------------------------------------------

test("a frame is reduced to its envelope; its payload is not read", () => {
  const f = frame({ type: "order", event: "filled", account_id: ACCT, seq: 9, time: T0, order: { id: "ord_1", status: "filled", size: 1 }, replay: true });
  assert.deepEqual(f, { type: "order", event: "filled", accountId: ACCT, seq: 9, time: T0, reason: null, streamId: null, resumed: null, upstream: null, replayComplete: null, code: null });
  assert.equal(Object.keys(f).some((k) => k === "order" || k === "size" || k === "status"), false);
  for (const bad of ["", "nope", "[1]", "null", "42", '{"no":"type"}', '{"type":7}', 7, null, undefined]) assert.equal(parseFrame(bad), null, String(bad));
  // a stream id that could reshape the resume query is not kept
  assert.equal(frame({ type: "hello", stream_id: "a&since=0" }).streamId, null);
  assert.equal(frame({ type: "hello", stream_id: "a/../b" }).streamId, null);
  assert.equal(frame({ type: "hello", stream_id: "strm_Ab-9" }).streamId, "strm_Ab-9");
  assert.equal(frame({ type: "order", seq: -1, time: 1.5 }).seq, null);
  assert.equal(frame({ type: "snapshot_end", replay: { complete: false } }).replayComplete, false);
  assert.equal(frame({ type: "heartbeat", upstream_connected: false }).upstream, false);
});

// ---- connecting ---------------------------------------------------------------------

test("the first connection raises nothing: its hello and opening snapshots repeat what the app has just read", () => {
  const { core, signals } = feed(opened(), OPENING);
  assert.deepEqual(signals, []);
  assert.equal(isLive(core), true);
  assert.equal(core.covered, true);
  assert.equal(core.lastSeq, 1);
  assert.equal(statusOf(core, true), "live");
  assert.equal(statusOf(core, false), "down");
  assert.equal(statusOf(null, false), "off");
});

test("a stream that never names this account in a snapshot is never live (the timer keeps its full pace)", () => {
  const others = [OPENING[0], { type: "snapshot", account_id: "acct_other", seq: 1, time: T0 }, { type: "notice", code: "accounts_truncated" }, OPENING[2]];
  const { core, signals } = feed(opened(), others);
  assert.equal(isLive(core), false);
  assert.equal(statusOf(core, true), "connecting");
  assert.deepEqual(signals, []);
  // nor one whose snapshot names no account at all (a field name this app has wrong)
  const nameless = feed(opened(), [OPENING[0], { type: "snapshot", seq: 1, time: T0 }, OPENING[2]]);
  assert.equal(isLive(nameless.core), false);
  // nor one still inside its snapshots
  assert.equal(isLive(feed(opened(), OPENING.slice(0, 2)).core), false);
});

// ---- events --------------------------------------------------------------------------

test("an event for this account asks for a read; what kind of read depends only on its type and event", () => {
  const live = feed(opened(), OPENING).core;
  const one = (f) => feed(live, [{ account_id: ACCT, seq: 2, time: T0 + 1, ...f }]).signals;
  for (const event of ["created", "edited", "triggered", "partially_filled"]) assert.deepEqual(one({ type: "order", event }), ["state"], event);
  for (const event of ["filled", "canceled", "rejected", "expired"]) assert.deepEqual(one({ type: "order", event }), ["state", "history"], event);
  assert.deepEqual(one({ type: "fill" }), ["state", "history"]);
  for (const event of ["opened", "changed", "closed"]) assert.deepEqual(one({ type: "position", event }), ["state"], event);
  for (const event of ["updated", "removed"]) assert.deepEqual(one({ type: "account", event }), ["state"], event);
  // nothing for another account, a price alert, traffic, or a type this app does not know
  assert.deepEqual(one({ type: "order", event: "filled", account_id: "acct_other" }), []);
  assert.deepEqual(one({ type: "price_alert", account_id: undefined }), []);
  assert.deepEqual(one({ type: "something_new" }), []);
  for (const type of ["heartbeat", "pong", "notice", "error"]) assert.deepEqual(feed(live, [{ type }]).signals, [], type);
  // an event that names NO account is taken as possibly ours: one wasted read, never a missed one
  assert.deepEqual(one({ type: "position", event: "changed", account_id: undefined }), ["state"]);
});

test("seq never makes a frame go unread: a gap, and a seq that does not go up on a frame of ours, each ask for a full re-read", () => {
  const live = feed(opened(), OPENING).core;
  const a = feed(live, [{ type: "order", event: "created", account_id: ACCT, seq: 2, time: T0 + 1 }]);
  assert.deepEqual(a.signals, ["state"]);
  // a true repeat costs one read it did not need; it is never a frame swallowed
  assert.deepEqual(feed(a.core, [{ type: "order", event: "created", account_id: ACCT, seq: 2, time: T0 + 1 }]).signals, ["resync", "state"], "a seq that did not go up");
  // another account's repeat is left alone
  const others = feed(a.core, [{ type: "order", event: "created", account_id: "acct_other", seq: 1, time: T0 + 1 }]);
  assert.deepEqual(others.signals, []);
  assert.equal(others.core.lastSeq, 2);
  const gap = feed(a.core, [{ type: "order", event: "created", account_id: ACCT, seq: 5, time: T0 + 2 }]);
  assert.deepEqual(gap.signals, ["resync", "state"]);
  assert.equal(gap.core.lastSeq, 5);
  // seq counts every account's frames: one for another account moves it on and raises nothing
  const other = feed(a.core, [{ type: "order", event: "created", account_id: "acct_other", seq: 3, time: T0 + 2 }]);
  assert.deepEqual(other.signals, []);
  assert.equal(other.core.lastSeq, 3);
  assert.deepEqual(feed(other.core, [{ type: "fill", account_id: ACCT, seq: 4, time: T0 + 3 }]).signals, ["state", "history"]);
});

// The doc says seq counts the whole stream from 1. None of that is verified, so
// these pin what happens if it is not so (the review of 2026-11-26).
test("if seq is counted PER ACCOUNT (a sandbox key sees several), this account's snapshot and events are still read", () => {
  // the other account's snapshot comes first with the same seq: ours is not a 'repeat'
  const first = feed(opened(), [OPENING[0], { type: "snapshot", account_id: "acct_other", seq: 1, time: T0 }, { type: "snapshot", account_id: ACCT, seq: 1, time: T0 }, { type: "snapshot_end" }]);
  assert.equal(first.core.covered, true);
  assert.equal(isLive(first.core), true, "the stream goes live");
  // another account runs far ahead; our own fill and position still raise their reads
  const live = feed(opened(), [OPENING[0], { type: "snapshot", account_id: ACCT, seq: 1, time: T0 }, { type: "snapshot", account_id: "acct_other", seq: 1, time: T0 }, { type: "snapshot_end" }]).core;
  const later = feed(live, [
    { type: "order", event: "filled", account_id: "acct_other", seq: 40, time: T0 + 1 },
    { type: "fill", account_id: ACCT, seq: 2, time: T0 + 2 },
    { type: "position", event: "opened", account_id: ACCT, seq: 3, time: T0 + 3 },
  ]);
  assert.ok(later.signals.includes("state") && later.signals.includes("history"), "my fill and my position were read: " + later.signals.join(","));
  assert.ok(later.signals.includes("resync"), "and the odd count asked for a full re-read");
  // one frame at a time: neither of mine is swallowed
  const afterOther = feed(live, [{ type: "order", event: "filled", account_id: "acct_other", seq: 40, time: T0 + 1 }]).core;
  assert.deepEqual(feed(afterOther, [{ type: "fill", account_id: ACCT, seq: 2, time: T0 + 2 }]).signals, ["resync", "state", "history"]);
  const afterFill = feed(afterOther, [{ type: "fill", account_id: ACCT, seq: 2, time: T0 + 2 }]).core;
  assert.deepEqual(feed(afterFill, [{ type: "position", event: "opened", account_id: ACCT, seq: 3, time: T0 + 3 }]).signals, ["state"]);
});

test("if the venue starts its count again mid-stream, the resync snapshot and every event after it are still read", () => {
  const live = feed(opened(), [...OPENING, { type: "order", event: "created", account_id: ACCT, seq: 2, time: T0 + 1 }]).core;
  const far = feed(live, [{ type: "order", event: "created", account_id: ACCT, seq: 57, time: T0 + 2 }]);
  assert.deepEqual(far.signals, ["resync", "state"], "a gap");
  const again = feed(far.core, [{ type: "snapshot", account_id: ACCT, reason: "resync", seq: 1, time: T0 + 3 }]);
  assert.deepEqual(again.signals, ["resync"], "the resync snapshot is never dropped as a repeat");
  assert.equal(again.core.lastSeq, 1, "and the new count is followed");
  assert.equal(isLive(again.core), true);
  assert.deepEqual(feed(again.core, [{ type: "fill", account_id: ACCT, seq: 2, time: T0 + 4 }]).signals, ["state", "history"]);
  const closed = feed(again.core, [{ type: "fill", account_id: ACCT, seq: 2, time: T0 + 4 }, { type: "position", event: "closed", account_id: ACCT, seq: 3, time: T0 + 5 }]);
  assert.deepEqual(closed.signals, ["state", "history", "state"], "the fill and the position, each read");
});

test("if seq starts at 0, or frames carry no seq at all, the stream still goes live and its events are read", () => {
  const zero = feed(opened(), [OPENING[0], { type: "snapshot", account_id: ACCT, seq: 0, time: T0 }, { type: "snapshot_end" }]);
  assert.equal(zero.core.covered, true);
  assert.equal(isLive(zero.core), true);
  assert.deepEqual(zero.signals, []);
  assert.deepEqual(feed(zero.core, [{ type: "fill", account_id: ACCT, seq: 1, time: T0 + 1 }]).signals, ["state", "history"]);
  assert.equal(resumeQuery(zero.core), "?resume=strm_1&last_seq=0&since=" + T0);
  const none = feed(opened(), [OPENING[0], { type: "snapshot", account_id: ACCT, time: T0 }, { type: "snapshot_end" }]);
  assert.equal(isLive(none.core), true);
  assert.deepEqual(feed(none.core, [{ type: "fill", account_id: ACCT, time: T0 + 1 }]).signals, ["state", "history"]);
  assert.equal(resumeQuery(none.core), "", "nothing to resume from: the next connection is a fresh one");
  // a first seq far from 1 is taken as it comes (no re-read for a count this app cannot know the start of)
  assert.deepEqual(feed(opened(), [OPENING[0], { type: "snapshot", account_id: ACCT, seq: 9000, time: T0 }]).signals, []);
});

test("the venue's own resync, a snapshot after the opening, and an incomplete replay each ask for a read", () => {
  const live = feed(opened(), OPENING).core;
  assert.deepEqual(feed(live, [{ type: "snapshot", account_id: ACCT, reason: "resync", seq: 2, time: T0 + 1 }]).signals, ["resync"]);
  assert.deepEqual(feed(live, [{ type: "snapshot", account_id: ACCT, reason: "added", seq: 2, time: T0 + 1 }]).signals, ["state"]);
  assert.deepEqual(feed(live, [{ type: "snapshot", account_id: "acct_other", reason: "resync", seq: 2, time: T0 + 1 }]).signals, []);
  // inside the opening only a resync snapshot does
  assert.deepEqual(feed(opened(), [OPENING[0], { type: "snapshot", account_id: ACCT, reason: "resync", seq: 1, time: T0 }]).signals, ["resync"]);
  assert.deepEqual(feed(opened(), [OPENING[0], OPENING[1], { type: "snapshot_end", replay: { complete: false } }]).signals, ["resync"]);
});

test("a heartbeat that says the venue's own feed is down takes the stream out of 'live'; its return asks for a full re-read", () => {
  const live = feed(opened(), OPENING).core;
  const down = feed(live, [{ type: "heartbeat", upstream_connected: false }]);
  assert.equal(isLive(down.core), false);
  assert.deepEqual(down.signals, []);
  const back = feed(down.core, [{ type: "heartbeat" }]);
  assert.equal(isLive(back.core), true);
  assert.deepEqual(back.signals, ["resync"]);
  assert.equal(feed(live, [{ type: "reconnect" }]).reconnect, true);
});

// ---- resume ---------------------------------------------------------------------------

test("a reconnect asks to resume with the stream id, the last seq and the last time - and only when it has all three", () => {
  assert.equal(resumeQuery(newCore(ACCT)), "");
  assert.equal(resumeQuery(feed(opened(), [OPENING[0]]).core), "", "a hello alone: nothing to resume from");
  const live = feed(opened(), [...OPENING, { type: "order", event: "created", account_id: ACCT, seq: 2, time: T0 + 500 }]).core;
  assert.equal(resumeQuery(live), "?resume=strm_1&last_seq=2&since=" + (T0 + 500));
  assert.match(resumeQuery(live), /^\?resume=[A-Za-z0-9_-]+&last_seq=\d+&since=\d+$/);
  assert.equal(resumeQuery({ ...live, streamId: "a&x=1" }), "", "a stream id that could add to the query is never written out");
  assert.equal(resumeQuery({ ...live, stopped: true }), "");
});

test("a resumed stream goes on where it stopped; one that could not be resumed asks for a full re-read", () => {
  const live = feed(opened(), [...OPENING, { type: "order", event: "created", account_id: ACCT, seq: 2, time: T0 + 500 }]).core;
  const dropped = onClosed(live, 1006, T0 + 1000, () => 0.5).core;
  assert.equal(isLive(dropped), false);
  // resumed: no snapshot follows, the missed events are replayed
  const again = feed(onOpen(dropped, T0 + 2000), [{ type: "hello", stream_id: "strm_1", resumed: true }, { type: "position", event: "changed", account_id: ACCT, seq: 3, time: T0 + 900, replay: true }], T0 + 2000);
  assert.deepEqual(again.signals, ["state"]);
  assert.equal(isLive(again.core), true, "it still covers the account");
  assert.equal(again.core.lastSeq, 3);
  // not resumed (the venue held the stream about a minute): everything in between is unknown
  const fresh = feed(onOpen(dropped, T0 + 90_000), [{ type: "hello", stream_id: "strm_2", resumed: false }], T0 + 90_000);
  assert.deepEqual(fresh.signals, ["resync"]);
  assert.equal(fresh.core.lastSeq, null);
  assert.equal(fresh.core.covered, false);
  assert.equal(isLive(fresh.core), false, "until its own snapshot names the account again");
  // "resumed" under another stream id is not a resume
  assert.deepEqual(feed(onOpen(dropped, T0), [{ type: "hello", stream_id: "strm_9", resumed: true }]).signals, ["resync"]);
});

test("a resume is not asked for again once it cannot work: after an attempt that heard nothing, or 60 s of silence", () => {
  const live = feed(opened(), [...OPENING, { type: "order", event: "created", account_id: ACCT, seq: 2, time: T0 + 500 }]).core;
  const dropped = onClosed(live, 1006, T0 + 1000, () => 0.5).core;
  assert.match(resumeQuery(onAttempt(dropped, T0 + 2000)), /^\?resume=strm_1&last_seq=2&since=\d+$/, "a prompt reconnect asks to resume");
  // the venue refuses that resume at the upgrade (an HTTP error, no hello): the attempt hears nothing
  const refused = onClosed(onAttempt(dropped, T0 + 2000), 1006, T0 + 2100, () => 0.5).core;
  assert.equal(resumeQuery(onAttempt(refused, T0 + 4000)), "", "the same query is not repeated for ever");
  // and the fresh stream that follows is one after a stream was held: a full re-read
  const fresh = feed(onOpen(onAttempt(refused, T0 + 4000), T0 + 4000), [{ type: "hello", stream_id: "strm_2", resumed: false }], T0 + 4000);
  assert.deepEqual(fresh.signals, ["resync"]);
  // an attempt that DID hear something keeps its resume point
  const heard = onClosed(feed(onOpen(onAttempt(dropped, T0 + 2000), T0 + 2000), [{ type: "hello", stream_id: "strm_1", resumed: true }], T0 + 2000).core, 1006, T0 + 3000, () => 0.5).core;
  assert.match(resumeQuery(onAttempt(heard, T0 + 4000)), /^\?resume=strm_1&last_seq=2/);
  // nothing heard for longer than the venue holds a stream: not asked for
  assert.equal(RESUME_HOLD_MS, 60_000);
  assert.match(resumeQuery(onAttempt(dropped, T0 + 500 + 59_000)), /^\?resume=strm_1/);
  const stale = onAttempt(dropped, T0 + 500 + 61_000);
  assert.equal(resumeQuery(stale), "");
  assert.deepEqual(feed(onOpen(stale, T0 + 62_000), [{ type: "hello", stream_id: "strm_3", resumed: false }], T0 + 62_000).signals, ["resync"], "still a stream after one was held");
  // the very first attempts, refused, have nothing to forget and raise nothing later
  const never = onClosed(onAttempt(newCore(ACCT), T0), 1006, T0 + 100, () => 0.5).core;
  assert.deepEqual(feed(onOpen(onAttempt(never, T0 + 2000), T0 + 2000), [OPENING[0]], T0 + 2000).signals, []);
});

// ---- the connection's end ---------------------------------------------------------------

test("no frame of any kind for 45 s: the connection is dead", () => {
  const c = touch(opened(), T0);
  assert.equal(watchdogDue(c, T0 + WATCHDOG_MS), false);
  assert.equal(watchdogDue(c, T0 + WATCHDOG_MS + 1), true);
  assert.equal(watchdogDue(feed(c, [{ type: "heartbeat" }], T0 + 30_000).core, T0 + 60_000), false);
});

test("the ladder: 1, 2, 5, 10, 30, 60 s with jitter, and it starts again only after a connection that stayed live", () => {
  let c = newCore(ACCT);
  const waits = [];
  for (let i = 0; i < 8; i++) { const r = onClosed(c, 1006, T0, () => 0.5); c = r.core; waits.push(r.delayMs); }
  assert.deepEqual(waits, [1000, 2000, 5000, 10_000, 30_000, 60_000, 60_000, 60_000]);
  assert.deepEqual(LADDER_MS, [1000, 2000, 5000, 10_000, 30_000, 60_000]);
  // jitter: 80 to 120 percent
  assert.equal(onClosed(newCore(ACCT), 1011, T0, () => 0).delayMs, 800);
  assert.ok(onClosed(newCore(ACCT), 1011, T0, () => 0.999999).delayMs <= 1200);
  // a socket the venue accepts and drops at once keeps climbing: it is never met with a connection a second
  let flap = newCore(ACCT);
  const flapWaits = [];
  for (let i = 0; i < 4; i++) {
    flap = feed(onOpen(flap, T0), [{ type: "hello", stream_id: "strm_" + i, resumed: false }, { type: "snapshot", account_id: ACCT, seq: 1, time: T0 }, { type: "snapshot_end" }]).core;
    assert.equal(isLive(flap), true);
    const r = onClosed(flap, 1011, T0 + 5_000, () => 0.5);   // live for 5 s only
    flap = r.core;
    flapWaits.push(r.delayMs);
  }
  assert.deepEqual(flapWaits, [1000, 2000, 5000, 10_000]);
  // one that stayed live for half a minute starts the ladder again
  const steady = feed(onOpen(flap, T0), OPENING).core;
  assert.equal(onClosed(steady, 1011, T0 + STEADY_MS, () => 0.5).delayMs, 1000);
});

test("close codes: 4001 never retries the key, 1012 goes back at once, 4013 backs off further", () => {
  const live = feed(opened(), OPENING).core;
  const rejected = onClosed(live, 4001, T0 + 1000, () => 0.5);
  assert.equal(rejected.delayMs, null);
  assert.equal(rejected.core.stopped, true);
  assert.equal(statusOf(rejected.core, false), "rejected");
  assert.equal(resumeQuery(rejected.core), "");
  // restarting, after a steady connection: at once
  assert.equal(onClosed(live, 1012, T0 + STEADY_MS, () => 0.5).delayMs, 250);
  // restarting again and again: the ladder
  assert.equal(onClosed({ ...live, attempts: 3 }, 1012, T0 + 1000, () => 0.5).delayMs, 10_000);
  // at capacity: never under 5 s, wide jitter
  assert.equal(onClosed(newCore(ACCT), 4013, T0, () => 0).delayMs, 5000);
  assert.equal(onClosed(newCore(ACCT), 4013, T0, () => 0.5).delayMs, 10_000);
  assert.equal(onClosed(newCore(ACCT), 4008, T0, () => 0.5).delayMs, 1000, "too slow: reconnect");
  // the relay's closing line carries the code
  assert.equal(closeCodeOf(frame({ type: "tt_stream_closed", code: 4001 })), 4001);
  assert.equal(closeCodeOf(frame({ type: "tt_stream_closed" })), 1006);
  assert.equal(closeCodeOf(frame({ type: "heartbeat", code: 4001 })), null);
});

test("a refused upgrade is read from the close's reason: 401 / 403 stop the key, 429 backs off, anything else is the ladder", () => {
  assert.equal(refusedStatus("Expected HTTP 101 response but was '401 Unauthorized'"), 401);
  assert.equal(refusedStatus("Expected HTTP 101 response but was '503 Service Unavailable'"), 503);
  assert.equal(refusedStatus("HTTP 403"), 403);
  for (const none of [null, undefined, "", "Connection reset", "timeout after 401 ms"]) assert.equal(refusedStatus(none), null, String(none));
  const c = newCore(ACCT);
  const reason = (status, text) => "Expected HTTP 101 response but was '" + status + " " + text + "'";
  assert.equal(onClosed(c, 1006, T0, () => 0.5, reason(401, "Unauthorized")).delayMs, null, "a revoked key is not retried for ever");
  assert.equal(onClosed(c, 1006, T0, () => 0.5, reason(403, "Forbidden")).core.stopped, true);
  assert.equal(onClosed(c, null, T0, () => 0.5, "HTTP 401").delayMs, null, "the relay's own refusal of a key");
  assert.equal(onClosed(c, 1006, T0, () => 0.5, reason(429, "Too Many Requests")).delayMs, 10_000);
  assert.equal(onClosed(c, 1006, T0, () => 0.5, reason(503, "Service Unavailable")).delayMs, 1000);
  assert.equal(onClosed(c, 1006, T0, () => 0.5, null).delayMs, 1000);
  // a reason is only read for a close with no code of its own
  assert.equal(onClosed(c, 1011, T0, () => 0.5, "HTTP 401").delayMs, 1000);
});

// ---- the module, both transports ----------------------------------------------------------

const TEST_KEY = "fp_test_" + "fake".repeat(6);
const LIVE_KEY = "fp_live_" + "fake".repeat(6);

// A scripted relay: each request is a connection the test writes lines into.
function fakeRelay() {
  const r = { asks: [], conns: [], status: 200 };
  r.handle = (url, init) => {
    r.asks.push({ url: String(url), init });
    if (r.status !== 200) return Promise.resolve({ status: r.status, body: null, headers: { get: () => null } });
    const queue = [];
    let waiting = null, closed = false;
    const give = (v) => { if (waiting) { const w = waiting; waiting = null; w(v); } else queue.push(v); };
    const conn = {
      aborted: false,
      write: (text) => give({ done: false, value: new TextEncoder().encode(text) }),
      line: (o) => conn.write(JSON.stringify(o) + "\n"),
      end: () => { if (!closed) { closed = true; give({ done: true, value: undefined }); } },
    };
    if (init.signal) init.signal.addEventListener("abort", () => { conn.aborted = true; conn.end(); });
    r.conns.push(conn);
    return Promise.resolve({ status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((res) => { waiting = res; })) }) } });
  };
  r.last = () => r.conns[r.conns.length - 1];
  return r;
}

function streamWorld({ os = "web", key = TEST_KEY } = {}) {
  const relay = fakeRelay();
  const app = [];
  const w = makeWorld({
    packages: { "react-native": { __esModule: true, Platform: { OS: os }, AppState: { currentState: "active", addEventListener: (_e, fn) => { app.push(fn); return { remove() {} }; } } } },
    fetch: (url, init) => relay.handle(url, init),
  });
  const stream = w.load("mfp_stream");
  const notes = [];
  const start = () => stream.startMfpStream({ key: async () => key, account: async () => ACCT, on: (n) => notes.push(n) });
  return { w, clock: w.clock, relay, stream, notes, start, appState: (s) => { for (const l of app) l(s); } };
}

test("web: one GET to the app's own origin with the key in a header, lines read across chunks, and nothing else ever requested", async () => {
  const a = streamWorld();
  a.start();
  await a.clock.flush();
  assert.equal(a.relay.asks.length, 1);
  const ask = a.relay.asks[0];
  assert.equal(ask.url, "/mfp/sandbox/v1/stream", "a relative path: the app's own origin");
  assert.equal(ask.init.method, "GET");
  assert.equal(ask.init.body, undefined);
  assert.deepEqual(ask.init.headers, { Authorization: "Bearer " + TEST_KEY, Accept: "application/x-ndjson" });
  assert.ok(!ask.url.includes("fp_"), "the key is never in the address");
  assert.equal(a.stream.mfpStreamState().status, "connecting");
  // frames arrive cut anywhere
  const c = a.relay.last();
  const text = OPENING.map((f) => JSON.stringify(f)).join("\n") + "\n";
  c.write(text.slice(0, 37));
  await a.clock.flush();
  c.write(text.slice(37, 90));
  c.write(text.slice(90));
  await a.clock.flush();
  assert.equal(a.stream.mfpStreamState().status, "live");
  assert.equal(a.stream.mfpStreamLive(), true);
  assert.deepEqual(a.notes, ["live"], "the opening raised no read of its own");
  c.line({ type: "fill", account_id: ACCT, seq: 2, time: T0 + 1, fill: { price: 1 } });
  c.line({ type: "order", event: "created", account_id: "acct_other", seq: 3, time: T0 + 2 });
  await a.clock.flush();
  assert.deepEqual(a.notes, ["live", "state", "history"]);
  assert.equal(a.relay.asks.length, 1);
});

test("web: a live key asks for the live path", async () => {
  const a = streamWorld({ key: LIVE_KEY });
  a.start();
  await a.clock.flush();
  assert.equal(a.relay.asks[0].url, "/mfp/live/v1/stream");
});

test("web: a dropped connection is retried up the ladder, asking to resume; stopping hangs up for good", async () => {
  const a = streamWorld();
  const stop = a.start();
  await a.clock.flush();
  for (const f of OPENING) a.relay.last().line(f);
  a.relay.last().line({ type: "position", event: "changed", account_id: ACCT, seq: 2, time: T0 + 5 });
  await a.clock.flush();
  assert.deepEqual(a.notes, ["live", "state"]);
  // the venue closes it (the relay's closing line), and the response ends
  a.relay.last().line({ type: "tt_stream_closed", code: 1011 });
  a.relay.last().end();
  await a.clock.flush();
  assert.equal(a.stream.mfpStreamState().status, "down");
  assert.deepEqual(a.notes, ["live", "state", "down"]);
  assert.equal(a.relay.conns[0].aborted, true, "the old request was let go");
  await a.clock.advance(700);
  assert.equal(a.relay.asks.length, 1, "not before the first rung (0.8 to 1.2 s)");
  await a.clock.advance(600);
  assert.equal(a.relay.asks.length, 2);
  assert.equal(a.relay.asks[1].url, "/mfp/sandbox/v1/stream?resume=strm_1&last_seq=2&since=" + (T0 + 5));
  // refused again and again: the rungs grow
  a.relay.status = 502;
  a.relay.last().end();
  await a.clock.flush();
  const before = a.relay.asks.length;
  await a.clock.advance(60_000);
  const tries = a.relay.asks.length - before;
  assert.ok(tries >= 4 && tries <= 6, "2, 5, 10, 30 s ... not one a second: " + tries);
  stop();
  const stopped = a.relay.asks.length;
  await a.clock.advance(300_000);
  assert.equal(a.relay.asks.length, stopped, "no attempt after stop");
  assert.equal(a.stream.mfpStreamState().status, "off");
});

test("web: 4001 (the venue rejects the key) stops the stream; it is not tried again", async () => {
  const a = streamWorld();
  a.start();
  await a.clock.flush();
  for (const f of OPENING) a.relay.last().line(f);
  await a.clock.flush();
  a.relay.last().line({ type: "tt_stream_closed", code: 4001 });
  await a.clock.flush();
  assert.equal(a.stream.mfpStreamState().status, "rejected");
  assert.deepEqual(a.notes, ["live", "down"]);
  await a.clock.advance(600_000);
  assert.equal(a.relay.asks.length, 1);
  // the relay refusing the key itself (wrong environment, not a key) is the same
  const b = streamWorld();
  b.relay.status = 403;
  b.start();
  await b.clock.flush();
  assert.equal(b.stream.mfpStreamState().status, "rejected");
  await b.clock.advance(600_000);
  assert.equal(b.relay.asks.length, 1);
});

test("web: 45 s of silence ends the connection and the next one is attempted", async () => {
  const a = streamWorld();
  a.start();
  await a.clock.flush();
  for (const f of OPENING) a.relay.last().line(f);
  await a.clock.flush();
  await a.clock.advance(40_000);
  a.relay.last().line({ type: "heartbeat" });
  await a.clock.advance(40_000);
  assert.equal(a.relay.asks.length, 1, "a heartbeat is traffic");
  await a.clock.advance(12_000);
  assert.equal(a.relay.conns[0].aborted, true);
  assert.ok(a.relay.asks.length >= 2, "reconnected after the silence");
  assert.deepEqual(a.notes.slice(0, 2), ["live", "down"]);
});

test("web: no key, no stream - and nothing is requested", async () => {
  const a = streamWorld({ key: null });
  a.start();
  await a.clock.flush();
  await a.clock.advance(120_000);
  assert.equal(a.relay.asks.length, 0);
  assert.equal(a.stream.mfpStreamState().status, "off");
});

// Android: React Native's WebSocket, replaced by a double for the test.
function withFakeWebSocket(run) {
  const made = [];
  class Fake {
    constructor(url, protocols, options) {
      this.url = url; this.protocols = protocols; this.options = options; this.closed = 0; this.calls = [];
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      made.push(this);
    }
    close() { this.closed++; }
  }
  const real = globalThis.WebSocket;
  globalThis.WebSocket = Fake;
  return run(made).finally(() => { globalThis.WebSocket = real; });
}

test("Android: straight to the stream host, the key in the upgrade's Authorization header, and never in the address", () => withFakeWebSocket(async (made) => {
  const a = streamWorld({ os: "android", key: LIVE_KEY });
  a.start();
  await a.clock.flush();
  assert.equal(made.length, 1);
  assert.equal(made[0].url, "wss://account-stream.myfundedperpetuals.com/v1/stream");
  assert.equal(made[0].protocols, null);
  assert.deepEqual(made[0].options, { headers: { Authorization: "Bearer " + LIVE_KEY } });
  assert.equal(a.relay.asks.length, 0, "no HTTP request on this platform");
  made[0].onopen({});
  for (const f of OPENING) made[0].onmessage({ data: JSON.stringify(f) });
  made[0].onmessage({ data: new ArrayBuffer(2) });     // not text: nothing
  assert.equal(a.stream.mfpStreamState().status, "live");
  made[0].onmessage({ data: JSON.stringify({ type: "order", event: "filled", account_id: ACCT, seq: 2, time: T0 + 9 }) });
  assert.deepEqual(a.notes, ["live", "state", "history"]);
  // the error event carries nothing and decides nothing
  made[0].onerror({ message: undefined });
  assert.equal(a.stream.mfpStreamState().status, "live");
  made[0].onclose({ code: 1012, reason: "" });
  await a.clock.advance(1_500);
  assert.equal(made.length, 2);
  assert.equal(made[1].url, "wss://account-stream.myfundedperpetuals.com/v1/stream?resume=strm_1&last_seq=2&since=" + (T0 + 9));
  // a sandbox key goes to the sandbox PATH on the same host
  const b = streamWorld({ os: "android", key: TEST_KEY });
  b.start();
  await b.clock.flush();
  assert.equal(made[2].url, "wss://account-stream.myfundedperpetuals.com/v1/sandbox/stream");
}));

test("Android: a refused upgrade (401 in the close's reason) stops the key; it is not retried for ever", () => withFakeWebSocket(async (made) => {
  const a = streamWorld({ os: "android" });
  a.start();
  await a.clock.flush();
  made[0].onerror({});
  made[0].onclose({ code: 1006, reason: "Expected HTTP 101 response but was '401 Unauthorized'" });
  assert.equal(a.stream.mfpStreamState().status, "rejected");
  await a.clock.advance(600_000);
  assert.equal(made.length, 1);
}));

test("Android: an error with no close is ended by the silence watchdog; the background drops the socket and the return resumes it", () => withFakeWebSocket(async (made) => {
  const a = streamWorld({ os: "android" });
  a.start();
  await a.clock.flush();
  made[0].onerror({});
  await a.clock.advance(40_000);
  assert.equal(made.length, 1, "the error alone does nothing");
  await a.clock.advance(12_000);
  assert.equal(made[0].closed, 1, "45 s of nothing: given up");
  assert.ok(made.length >= 2);
  const live = made[made.length - 1];
  live.onopen({});
  for (const f of OPENING) live.onmessage({ data: JSON.stringify(f) });
  assert.equal(a.stream.mfpStreamLive(), true);
  const count = made.length;
  a.appState("background");
  assert.equal(live.closed, 1);
  assert.equal(a.stream.mfpStreamLive(), false);
  await a.clock.advance(30_000);
  assert.equal(made.length, count, "nothing is attempted in the background");
  a.appState("active");
  await a.clock.flush();
  assert.equal(made.length, count + 1);
  assert.match(made[count].url, /\?resume=strm_1&last_seq=1&since=\d+$/, "back within the minute the venue holds a stream: it is resumed");
  // away for five minutes: the venue no longer holds it, so it is not asked for
  const back = made[count];
  back.onopen({});
  back.onmessage({ data: JSON.stringify({ type: "hello", stream_id: "strm_1", resumed: true }) });
  a.appState("background");
  await a.clock.advance(300_000);
  a.appState("active");
  await a.clock.flush();
  assert.equal(made.length, count + 2);
  assert.equal(made[count + 1].url, "wss://account-stream.myfundedperpetuals.com/v1/sandbox/stream", "a fresh connection, no resume");
  a.notes.length = 0;
  made[count + 1].onopen({});
  made[count + 1].onmessage({ data: JSON.stringify({ type: "hello", stream_id: "strm_7", resumed: false }) });
  assert.deepEqual(a.notes, ["resync"], "and what happened meanwhile is read in full");
}));

test("the app reads lines at least twice as long as the longest frame the relay hands down", () => {
  assert.ok(MAX_FRAME_CHARS >= 2 * MAX_FRAME_BYTES, MAX_FRAME_CHARS + " vs " + MAX_FRAME_BYTES);
  // a frame at the relay's limit is one the app still reads
  const big = JSON.stringify({ type: "snapshot", account_id: ACCT, seq: 1, time: T0, pad: "x".repeat(MAX_FRAME_BYTES - 200) });
  assert.ok(big.length <= MAX_FRAME_BYTES);
  assert.equal(parseFrame(big).type, "snapshot");
});

// ---- the store: what a signal costs, and what it can never do ---------------------------------

const MARKET = "binance|BTCUSDT";
const mpos = (side = "long", size = 1) => ({ id: "pos_fake", account_id: ACCT, market_id: MARKET, provider: "binance", symbol: "BTC", coin: "BTCUSDT", side, size, entry_price: 100, mark_price: 100, leverage: 5, margin_mode: "cross", size_decimals: 3 });
const mord = (id, status, over = {}) => ({ id, status, market_id: MARKET, side: "buy", type: "market", size: 1, limit_price: 90, reduce_only: false, ...over });
const policy = { manual_trading_blocked: false, opening_exposure_restricted: false, restriction: null, trading_halt: { platform: false }, limits: { order_cooldown_ms: 0, execution_delay_max_ms: 0 } };
const inert = { id: "hl", ready: async () => false, markets: async () => [], history: async () => [], lookup: async () => ({ status: "unreadable", full: false, filled: 0, message: null }) };
const intent = (over = {}) => ({ venue: "mfp", marketId: MARKET, side: "buy", type: "limit", size: 1, price: 90, reduceOnly: false, postOnly: false, slippage: 0.01, tp: null, sl: null, leverage: 5, marginMode: "cross", ...over });

// latency: how long the scripted venue takes to answer a GET (a real one is
// never instant: the review of 2026-11-26 found reads doubled in that gap).
async function storeWorld(key = LIVE_KEY, latency = 0) {
  const box = { key };
  const relay = fakeRelay();
  const app = [];
  const f = { positions: [], working: [], gets: [], sends: [], onWrite: async () => { throw new Error("unscripted write"); }, look: () => [] };
  const w = makeWorld({
    mocks: {
      settings_store: fakeSettings(),
      ticker_store: { midOf: () => null, resetTicker() {}, tickerMarketsChanged() {} },
      mode: { isMock: () => false, mockScenario: () => "" },
      keys: { mfpReadKey: async () => box.key, mfpTradeKey: async () => box.key, mfpAccountId: async () => ACCT },
      agent_store: { getMfpMeta: async () => ({ accountId: ACCT }) },
      hl_venue: { hlVenue: inert, hlCoinSet: async () => new Set() },
      mfp_market_list: { refreshMfpList: async () => {}, mfpListSnapshot: () => ({ rows: [{ id: MARKET, symbol: "BTC", coin: "BTCUSDT", provider: "binance" }] }) },
    },
    packages: { "react-native": { __esModule: true, Platform: { OS: "web" }, AppState: { currentState: "active", addEventListener: (_e, fn) => { app.push(fn); return { remove() {} }; } } } },
  });
  w.fetch = async (url, init) => {
    if (String(url).includes("/v1/stream")) return relay.handle(url, init);
    const u = new URL(String(url).replace(/^\/mfp\/(live|sandbox)(?=\/v1\/)/, ""), "https://mfp.test");
    if (init.method !== "GET") { const b = init.body ? JSON.parse(init.body) : null; f.sends.push({ path: u.pathname, body: b }); return f.onWrite(u.pathname, b); }
    let kind, data;
    if (u.pathname.endsWith("/trading-policy")) { kind = "policy"; data = policy; }
    else if (u.pathname.endsWith("/quote")) { kind = "quote"; data = { bid: 99, ask: 101, mid: 100 }; }
    else if (u.pathname === "/v1/positions") { kind = "positions"; data = f.positions; }
    else if (u.pathname === "/v1/fills") { kind = "fills"; data = []; }
    else if (u.pathname === "/v1/orders") {
      if (u.searchParams.has("client_order_id")) { kind = "lookup"; data = await f.look(u.searchParams.get("client_order_id")); }
      else if (u.searchParams.get("status") === "working") { kind = "working"; data = f.working; }
      else { kind = "orders"; data = []; }
    } else if (u.pathname === "/v1/accounts/" + ACCT) { kind = "account"; data = { id: ACCT, balance: 10000 }; }
    else throw new Error("unscripted read: " + u.pathname);
    f.gets.push({ kind, at: w.clock.now() });
    if (latency) await new Promise((r) => w.clock.setTimeout(r, latency));
    return json({ data });
  };
  const store = w.load("venue_store");
  const kinds = (from) => f.gets.filter((g) => g.at > from).map((g) => g.kind);
  const tally = (from) => kinds(from).reduce((m, k) => { m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const live = async () => { for (const fr of OPENING) relay.last().line(fr); await w.clock.flush(); };
  // Time passing on a live stream: the venue's heartbeat every 15 s keeps it alive.
  const quiet = async (ms) => { for (let t = 0; t < ms; t += 15_000) { relay.last().line({ type: "heartbeat" }); await w.clock.advance(Math.min(15_000, ms - t)); } };
  return { w, clock: w.clock, store, f, relay, box, kinds, tally, live, quiet, appState: (s) => { for (const l of app) l(s); }, market: () => store.marketByKey("mfp:" + MARKET), start: async () => { await store.startVenues(); await w.clock.flush(); } };
}

test("with the stream live an idle minute costs about 7 GETs (17 without it); the stream going down puts the full pace back", async () => {
  const a = await storeWorld();
  await a.start();
  assert.equal(a.relay.asks.length, 1, "the store started the stream on the read key");
  await a.live();
  await a.clock.advance(2_000);          // the one read as the stream goes live
  let from = a.clock.now();
  await a.quiet(300_000);
  // five minutes: the book once a minute, the account every 15 s, the policy
  // once a minute, the history once
  const t = a.tally(from);
  // (the timer beats every 5 s, so a pace counted from a read that was asked
  // for between beats runs up to 5 s long: four or five book reads here)
  assert.deepEqual({ account: t.account, policy: t.policy, fills: t.fills, orders: t.orders }, { account: 20, policy: 5, fills: 1, orders: 1 }, JSON.stringify(t));
  assert.ok(t.positions >= 4 && t.positions <= 5 && t.working === t.positions, JSON.stringify(t));
  const perMinute = a.kinds(from).length / 5;
  assert.ok(perMinute >= 6.5 && perMinute <= 7.5, "GETs a minute, watched and flat: " + perMinute);
  assert.equal(a.store.venueState().status.mfp.heldUntil, null);
  // the stream drops: the next beat is back at the full pace
  a.relay.status = 502;
  a.relay.last().line({ type: "tt_stream_closed", code: 1011 });
  a.relay.last().end();
  await a.clock.flush();
  await a.clock.advance(10_000);
  from = a.clock.now();
  await a.clock.advance(60_000);
  const down = a.tally(from);
  assert.equal(down.positions, 6, JSON.stringify(down));
  assert.equal(a.kinds(from).length, 17);
});

test("a change signal is answered by ONE read of the book, however many frames arrive together", async () => {
  const a = await storeWorld();
  await a.start();
  await a.live();
  await a.clock.advance(5_000);
  const from = a.clock.now() - 1;
  // the venue reports a position opening: a burst of frames inside one second
  a.f.positions = [mpos()];
  let seq = 1;
  for (const fr of [{ type: "order", event: "created" }, { type: "order", event: "filled" }, { type: "fill" }, { type: "position", event: "opened" }, { type: "account", event: "updated" }]) {
    a.relay.last().line({ ...fr, account_id: ACCT, seq: ++seq, time: T0 + seq, order: { status: "filled" }, position: { size: 99 } });
  }
  await a.clock.flush();
  await a.clock.advance(1_500);
  const t = a.tally(from);
  assert.equal(t.positions, 1, "five frames, one read: " + JSON.stringify(t));
  assert.equal(t.working, 1);
  assert.equal(a.store.venueState().positions.length, 1);
  assert.equal(a.store.venueState().positions[0].size, 1, "what is shown is what the REST read returned, not the frame's payload");
  // the fill also asked for the history, once
  await a.clock.advance(5_000);
  assert.equal(a.tally(from).fills, 1);
  // signals 600 ms apart for five seconds: reads never closer than a second, and never overlapping
  const burst = a.clock.now() - 1;
  for (let i = 0; i < 9; i++) {
    a.relay.last().line({ type: "position", event: "changed", account_id: ACCT, seq: ++seq, time: T0 + seq });
    await a.clock.advance(600);
  }
  await a.clock.advance(1_500);
  const reads = a.f.gets.filter((g) => g.at > burst && g.kind === "positions").map((g) => g.at);
  assert.ok(reads.length >= 3 && reads.length <= 7, "reads for nine signals: " + reads.length);
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i] - reads[i - 1] >= 1000, "two reads " + (reads[i] - reads[i - 1]) + " ms apart");
});

test("nothing pushed settles a write: only a REST read begun after the answer does", async () => {
  const a = await storeWorld();
  await a.start();
  await a.live();
  await a.clock.advance(5_000);
  // the venue answers "pending" and its book does not show the order yet
  a.f.onWrite = async (_p, b) => json({ data: mord("ord_fake", "pending", { client_order_id: b.client_order_id, type: "limit" }) });
  a.f.look = (id) => [mord("ord_fake", "pending", { client_order_id: id, type: "limit" })];
  const out = await a.clock.settle(a.store.placeOrder(intent(), a.market()));
  assert.equal(a.store.venueState().pending.length, 1, JSON.stringify(out) + " " + a.store.venueState().log.map((l) => l.state + ": " + l.text).join(" | "));
  // the stream says, with a payload, that the order filled and a position opened
  let seq = 1;
  a.relay.last().line({ type: "order", event: "filled", account_id: ACCT, seq: ++seq, time: T0 + seq, order: { id: "ord_fake", status: "filled", filled_size: 1 } });
  a.relay.last().line({ type: "position", event: "opened", account_id: ACCT, seq: ++seq, time: T0 + seq, position: { market_id: MARKET, side: "long", size: 1 } });
  await a.clock.flush();
  await a.clock.advance(3_000);
  // the REST reads it triggered still show nothing: so nothing is shown and nothing is settled
  assert.equal(a.store.venueState().positions.length, 0, "a pushed position is never shown");
  assert.equal(a.store.venueState().pending.length, 1, "a pushed 'filled' never settles the write");
  assert.ok(!a.store.venueState().log.some((l) => l.state === "confirmed"));
  // the venue's own book and status say so: now it settles
  a.f.positions = [mpos()];
  a.f.look = (id) => [mord("ord_fake", "filled", { client_order_id: id, type: "limit" })];
  a.relay.last().line({ type: "account", event: "updated", account_id: ACCT, seq: ++seq, time: T0 + seq });
  await a.clock.flush();
  await a.clock.advance(3_000);
  assert.equal(a.store.venueState().pending.length, 0);
  assert.equal(a.store.venueState().positions.length, 1);
});

test("with a position open the watched book is read every 15 s (the stream carries no mark or PnL)", async () => {
  const a = await storeWorld();
  a.f.positions = [mpos()];
  await a.start();
  await a.live();
  await a.clock.advance(2_000);
  const from = a.clock.now();
  await a.quiet(300_000);
  const t = a.tally(from);
  assert.ok(t.positions >= 15 && t.positions <= 20, JSON.stringify(t));
  assert.equal(t.account, 20, JSON.stringify(t));
  const n = a.kinds(from).length / 5;
  assert.ok(n >= 11 && n <= 13.5, "GETs a minute, watched, one position: " + n + " " + JSON.stringify(t));
});

test("signals raise no read while the app is hidden; the read on return covers them", async () => {
  const a = await storeWorld();
  await a.start();
  await a.live();
  await a.clock.advance(5_000);
  a.appState("background");
  const from = a.clock.now() - 1;
  for (let i = 2; i < 8; i++) a.relay.last().line({ type: "position", event: "changed", account_id: ACCT, seq: i, time: T0 + i });
  await a.clock.flush();
  await a.clock.advance(30_000);
  assert.equal(a.kinds(from).length, 0, a.kinds(from).join(","));
  a.appState("active");
  await a.clock.flush();
  assert.equal(a.tally(from).positions, 1);
});

test("a read the budget holds back is retried when the budget says, not a whole pace later", async () => {
  const a = await storeWorld();
  await a.start();
  await a.live();
  await a.clock.advance(5_000);
  // the venue rate limits the next book read for 20 s
  let refuse = true;
  const real = a.w.fetch;
  a.w.fetch = async (url, init) => {
    if (refuse && init.method === "GET" && String(url).includes("/v1/positions")) {
      refuse = false;
      a.f.gets.push({ kind: "positions", at: a.clock.now() });
      return { ok: false, status: 429, json: async () => ({ error: { code: "rate_limited" } }), headers: { get: (n) => (n === "retry-after" ? "20" : null) } };
    }
    return real(url, init);
  };
  const from = a.clock.now() - 1;
  a.relay.last().line({ type: "position", event: "changed", account_id: ACCT, seq: 2, time: T0 + 2 });
  await a.clock.flush();
  await a.clock.advance(2_000);
  assert.ok(a.store.venueState().status.mfp.heldUntil > a.clock.now());
  await a.clock.advance(17_000);
  assert.equal(a.f.gets.filter((g) => g.at > from && g.kind === "positions").length, 1, "nothing during the hold");
  await a.clock.advance(2_500);
  assert.equal(a.f.gets.filter((g) => g.at > from && g.kind === "positions").length, 2, "read again as the hold ended - the watched pace alone would have waited a minute");
  assert.equal(a.store.venueState().status.mfp.heldUntil, null);
});

// ---- the review of 2026-11-26 ---------------------------------------------------------------

test("settlement never waits on the stream: with it live and SILENT, a pending write keeps the full pace until it settles", async () => {
  const a = await storeWorld();
  await a.start();
  await a.live();
  await a.clock.advance(5_000);
  // the venue answers "pending"; the stream says nothing at all about it
  let resting = false;
  a.f.onWrite = async (_p, b) => json({ data: mord("ord_fake", "pending", { client_order_id: b.client_order_id, type: "limit" }) });
  a.f.look = (id) => [mord("ord_fake", resting ? "resting" : "pending", { client_order_id: id, type: "limit" })];
  await a.clock.settle(a.store.placeOrder(intent(), a.market()));
  assert.equal(a.store.venueState().pending.length, 1);
  const from = a.clock.now();
  await a.quiet(60_000);
  const reads = a.f.gets.filter((g) => g.at > from && g.kind === "positions").map((g) => g.at - from);
  assert.ok(reads.length >= 5 && reads.length <= 7, "book reads in the minute after the tap: " + reads.join(", "));
  // the stream-down pace: 10 s, counted on the timer's 5 s beat (so at most 15 s after a read made between beats)
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i] - reads[i - 1] <= 15_500, "a gap of " + (reads[i] - reads[i - 1]) + " ms");
  assert.ok(reads[0] <= 15_500, "the first within 15 s, not 22 and then 60: " + reads[0]);
  assert.equal(a.store.venueState().pending.length, 1, "still pending, and still being looked at");
  // the venue shows it resting: the next timed read settles it, with no help from the stream
  resting = true;
  a.f.working = [mord("ord_fake", "resting", { client_order_id: a.f.sends[0].body.client_order_id, type: "limit" })];
  await a.quiet(15_000);
  assert.equal(a.store.venueState().pending.length, 0);
  // settled, nothing watched: the safety pace is back
  await a.clock.advance(1_000);
  const calm = a.clock.now();
  await a.quiet(120_000);
  assert.ok(a.f.gets.filter((g) => g.at > calm && g.kind === "positions").length <= 3, "the safety pace again");
});

test("a resting entry whose exits are watched keeps the full pace too (its fill must not wait on the stream)", async () => {
  const a = await storeWorld();
  await a.start();
  await a.live();
  await a.clock.advance(5_000);
  a.f.onWrite = async (_p, b) => {
    const o = mord("rest_fake", "resting", { client_order_id: b.client_order_id, type: "limit" });
    a.f.working = [o];
    return json({ data: o });
  };
  const out = await a.clock.settle(a.store.placeOrder(intent({ sl: 80 }), a.market()));
  assert.equal(out.state, "confirmed");
  assert.equal(a.store.venueState().pending.length, 0, "the entry itself is settled");
  await a.clock.advance(2_000);
  const from = a.clock.now();
  await a.quiet(60_000);
  const n = a.f.gets.filter((g) => g.at > from && g.kind === "positions").length;
  assert.ok(n >= 5 && n <= 7, "book reads a minute while its exits are watched: " + n);
});

for (const [name, positions, lo, hi] of [["flat", [], 7, 7.6], ["one position open", [mpos()], 12.6, 13.6]]) {
  test("GETs a minute with the stream live, " + name + ", against a venue that takes 150 ms to answer", async () => {
    const a = await storeWorld(LIVE_KEY, 150);
    a.f.positions = positions;
    await a.start();
    await a.clock.advance(1_000);
    await a.live();
    await a.clock.advance(3_000);
    const from = a.clock.now();
    await a.quiet(600_000);
    const t = a.tally(from);
    const perMinute = a.kinds(from).length / 10;
    // the account is read every 15 s and never twice for one beat; the policy once a minute
    assert.equal(t.account, 40, JSON.stringify(t));
    assert.equal(t.policy, 10, JSON.stringify(t));
    assert.ok(perMinute >= lo && perMinute <= hi, perMinute + " a minute: " + JSON.stringify(t));
  });
}

test("saving settings restarts the stream only when the MFP read key changed; a rejected key gets no second try from a wallet save", async () => {
  const a = await storeWorld();
  await a.start();
  await a.live();
  assert.equal(a.relay.asks.length, 1);
  // a save of something else (the wallet, the Hyperliquid key) calls venuesChanged()
  a.store.venuesChanged();
  await a.clock.flush();
  await a.clock.advance(2_000);
  assert.equal(a.relay.asks.length, 1, "the live stream was left alone");
  assert.equal(a.w.load("mfp_stream").mfpStreamState().status, "live");
  // the venue rejects the key
  a.relay.last().line({ type: "tt_stream_closed", code: 4001 });
  await a.clock.flush();
  assert.equal(a.w.load("mfp_stream").mfpStreamState().status, "rejected");
  a.store.venuesChanged();
  await a.clock.flush();
  await a.clock.advance(120_000);
  assert.equal(a.relay.asks.length, 1, "no retry of a rejected key because some other setting was saved");
  assert.equal(a.w.load("mfp_stream").mfpStreamState().status, "rejected");
  // another key is stored: now it starts over
  a.box.key = "fp_live_" + "fakeb".repeat(5);
  a.store.venuesChanged();
  await a.clock.flush();
  await a.clock.advance(500);
  assert.equal(a.relay.asks.length, 2);
  assert.equal(a.relay.asks[1].init.headers.Authorization, "Bearer " + a.box.key);
});
