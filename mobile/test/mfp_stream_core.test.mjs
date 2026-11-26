// src/lib/mfp_stream_core.ts: what an account-stream frame means (a change
// signal, never venue state), resume, reconnect policy. Frames follow MFP's
// published field names; ids are fake.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MFP_RESUME_HOLD_MS, MFP_STREAM_SILENT_MS, mfpClosePolicy, mfpForgetResume, mfpResumeQuery, mfpRetryDelayMs, mfpStreamDead,
  mfpUpgradePolicy, newMfpStreamCursor, onMfpFrame,
} from "../src/lib/mfp_stream_core.ts";

const ACCT = "acct_1";
const OTHER = "acct_2";
const at = (lastSeq, lastTime = 1000, streamId = "st_1") => ({ streamId, lastSeq, lastTime, opening: false });

// Feed frames in order; returns the final cursor and every signal raised.
function feed(frames, cursor = newMfpStreamCursor(), account = ACCT) {
  const signals = [];
  let last = null;
  for (const f of frames) {
    last = onMfpFrame(cursor, f, account);
    cursor = last.cursor;
    signals.push(...last.signals);
  }
  return { cursor, signals, last };
}

test("the first stream of a connection asks for nothing: the app has just read, the snapshots repeat it", () => {
  const r = feed([
    { type: "hello", stream_id: "st_1", environment: "sandbox", resumed: false },
    { type: "snapshot", account_id: ACCT, seq: 1, time: 1000, account: { balance: 1 }, positions: [{ id: "p" }] },
    { type: "snapshot", account_id: OTHER, seq: 2, time: 1000 },
    { type: "snapshot_end", seq: 3, time: 1001 },
  ]);
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.cursor, { streamId: "st_1", lastSeq: 3, lastTime: 1001, opening: false });
});

test("a NEW stream after one was held asks for one full read, and its opening snapshots add none", () => {
  const r = feed([
    { type: "hello", stream_id: "st_2", resumed: false },
    { type: "snapshot", account_id: ACCT, seq: 1, time: 9500 },
    { type: "snapshot_end", seq: 2, time: 9501 },
  ], at(40, 9000));
  assert.deepEqual(r.signals, ["resync"]);
  assert.deepEqual(r.cursor, { streamId: "st_2", lastSeq: 2, lastTime: 9501, opening: false });
});

test("after the opening, events ask for a read as they arrive", () => {
  const r = feed([
    { type: "hello", stream_id: "st_1", resumed: false },
    { type: "snapshot", account_id: ACCT, seq: 1, time: 1000 },
    { type: "snapshot_end", seq: 2, time: 1001 },
    { type: "order", event: "created", account_id: ACCT, seq: 3, time: 2000 },
    { type: "snapshot", account_id: ACCT, seq: 4, time: 2001, reason: "added" },
  ]);
  assert.deepEqual(r.signals, ["state", "state"]);
});

test("an opening snapshot marked resync still asks for a full read", () => {
  const r = feed([
    { type: "hello", stream_id: "st_1", resumed: false },
    { type: "snapshot", account_id: ACCT, seq: 1, time: 1000, reason: "resync" },
  ]);
  assert.deepEqual(r.signals, ["resync"]);
});

test("a result never carries venue state: only a cursor, signals and two flags", () => {
  const r = onMfpFrame(newMfpStreamCursor(), { type: "position", event: "opened", account_id: ACCT, seq: 1, time: 5, position: { size: 9 } }, ACCT);
  assert.deepEqual(Object.keys(r).sort(), ["cursor", "reconnect", "signals", "upstream"]);
  assert.deepEqual(Object.keys(r.cursor).sort(), ["lastSeq", "lastTime", "opening", "streamId"]);
});

test("order, fill, account and position events for the watched account ask for a read", () => {
  for (const [frame, want] of [
    [{ type: "order", event: "created", account_id: ACCT, seq: 3, time: 2000 }, ["state"]],
    [{ type: "order", event: "filled", account_id: ACCT, seq: 3, time: 2000 }, ["state"]],
    [{ type: "fill", account_id: ACCT, seq: 3, time: 2000, price: 1, size: 1 }, ["state"]],
    [{ type: "account", event: "updated", account_id: ACCT, seq: 3, time: 2000, changes: ["balance"] }, ["state"]],
    [{ type: "position", event: "opened", account_id: ACCT, seq: 3, time: 2000 }, ["state"]],
    [{ type: "position", event: "changed", account_id: ACCT, seq: 3, time: 2000 }, ["state"]],
    [{ type: "position", event: "closed", account_id: ACCT, seq: 3, time: 2000 }, ["state", "history"]],
  ]) {
    const r = onMfpFrame(at(2, 1001), frame, ACCT);
    assert.deepEqual(r.signals, want, JSON.stringify(frame));
    assert.equal(r.cursor.lastSeq, 3);
    assert.equal(r.cursor.lastTime, 2000);
  }
});

test("another account's frames raise nothing, but still advance the numbering", () => {
  const r = feed([
    { type: "position", event: "closed", account_id: OTHER, seq: 3, time: 2000 },
    { type: "snapshot", account_id: OTHER, seq: 4, time: 2001, reason: "resync" },
    { type: "order", event: "filled", account_id: OTHER, seq: 5, time: 2002 },
  ], at(2, 1001));
  assert.deepEqual(r.signals, []);
  assert.equal(r.cursor.lastSeq, 5);
});

test("frames that are not this app's business raise nothing", () => {
  for (const frame of [
    { type: "price_alert", event: "triggered", seq: 3, time: 2000, alert: { market_id: "m" } },
    { type: "pong", id: 1, time: 2000 },
    { type: "notice", code: "accounts_truncated" },
    { type: "error", code: "x" },
    { type: "something_new", account_id: ACCT, seq: 3, time: 2000 },
    { type: "order", event: "filled", seq: 3, time: 2000 },   // no account: not attributable
    { type: "snapshot", seq: 3, time: 2000 },
    null, 7, "hello", [], {}, { type: 5 },
  ]) {
    assert.deepEqual(onMfpFrame(at(2, 1001), frame, ACCT).signals, [], JSON.stringify(frame));
  }
});

test("a lost frame (a gap in seq) asks for a full read; a repeat or an old frame does not", () => {
  const start = at(5);
  const gap = onMfpFrame(start, { type: "order", event: "created", account_id: ACCT, seq: 8, time: 2000 }, ACCT);
  assert.deepEqual(gap.signals, ["resync", "state"]);
  assert.equal(gap.cursor.lastSeq, 8);
  const next = onMfpFrame(start, { type: "order", event: "created", account_id: ACCT, seq: 6, time: 2000 }, ACCT);
  assert.deepEqual(next.signals, ["state"]);
  const old = onMfpFrame(start, { type: "order", event: "created", account_id: ACCT, seq: 4, time: 500 }, ACCT);
  assert.equal(old.cursor.lastSeq, 5);
  assert.equal(old.cursor.lastTime, 1000);
  // a gap seen on another account's frame still means frames were lost
  const otherGap = onMfpFrame(start, { type: "fill", account_id: OTHER, seq: 9, time: 2000 }, ACCT);
  assert.deepEqual(otherGap.signals, ["resync"]);
});

test("a snapshot marked resync, and a replay that could not cover the gap, ask for a full read", () => {
  const start = at(5);
  assert.deepEqual(onMfpFrame(start, { type: "snapshot", account_id: ACCT, reason: "resync", seq: 6, time: 1 }, ACCT).signals, ["resync"]);
  assert.deepEqual(onMfpFrame(start, { type: "snapshot", account_id: ACCT, reason: "added", seq: 6, time: 1 }, ACCT).signals, ["state"]);
  assert.deepEqual(onMfpFrame(start, { type: "snapshot_end", seq: 6, time: 1, replay: { complete: false } }, ACCT).signals, ["resync"]);
  assert.deepEqual(onMfpFrame(start, { type: "snapshot_end", seq: 6, time: 1, replay: { complete: true } }, ACCT).signals, []);
});

test("a resumed stream keeps its place and asks for nothing", () => {
  const held = at(40, 9000);
  const resumed = onMfpFrame(held, { type: "hello", stream_id: "st_1", resumed: true }, ACCT);
  assert.deepEqual(resumed.signals, []);
  assert.deepEqual(resumed.cursor, held);
  // the frames after last_seq follow, and are not a gap
  assert.deepEqual(onMfpFrame(resumed.cursor, { type: "fill", account_id: ACCT, seq: 41, time: 9100 }, ACCT).signals, ["state"]);
  // "resumed" with nothing to resume is a first stream: nothing asked
  assert.deepEqual(onMfpFrame(newMfpStreamCursor(), { type: "hello", stream_id: "st_9", resumed: true }, ACCT).signals, []);
  // a hello without the flag, after a stream was held, is a new stream
  assert.deepEqual(onMfpFrame(held, { type: "hello", stream_id: "st_1" }, ACCT).signals, ["resync"]);
});

test("heartbeats report the venue's own upstream and keep the resume time fresh", () => {
  const start = at(5);
  const ok = onMfpFrame(start, { type: "heartbeat", time: 3000 }, ACCT);
  assert.equal(ok.upstream, true);
  assert.deepEqual(ok.signals, []);
  assert.deepEqual(ok.cursor, at(5, 3000));
  assert.equal(onMfpFrame(start, { type: "heartbeat", upstream_connected: false }, ACCT).upstream, false);
  assert.equal(onMfpFrame(start, { type: "order", event: "created", account_id: ACCT, seq: 6, time: 1 }, ACCT).upstream, null);
});

test("the venue's reconnect frame asks for a reconnect and nothing else", () => {
  const r = onMfpFrame(at(5), { type: "reconnect" }, ACCT);
  assert.equal(r.reconnect, true);
  assert.deepEqual(r.signals, []);
});

test("the input cursor is never changed in place", () => {
  const start = Object.freeze(at(5));
  const r = onMfpFrame(start, { type: "order", event: "created", account_id: ACCT, seq: 6, time: 2000 }, ACCT);
  assert.equal(start.lastSeq, 5);
  assert.notEqual(r.cursor, start);
});

test("the resume query: only with a stream to resume, only clean ids, never anything secret", () => {
  assert.equal(mfpResumeQuery(newMfpStreamCursor()), "");
  assert.equal(mfpResumeQuery(at(0, 5)), "");
  assert.equal(mfpResumeQuery(at(12, 0)), "?resume=st_1&last_seq=12");
  assert.equal(mfpResumeQuery(at(12, 1700000000123.7, "a-b_c.d:9")), "?resume=a-b_c.d:9&last_seq=12&since=1700000000123");
  for (const bad of ["a b", "a&x=1", "a/b", "a?b", "a#b", "", "x".repeat(129)]) {
    assert.equal(mfpResumeQuery(at(12, 5, bad)), "", JSON.stringify(bad));
  }
});

test("a resume is not asked for once the venue's hold has passed, or after an attempt that heard nothing", () => {
  const held = at(12, 5000);
  assert.equal(mfpResumeQuery(held, 0), "?resume=st_1&last_seq=12&since=5000");      // unknown quiet time: ask
  assert.equal(mfpResumeQuery(held, MFP_RESUME_HOLD_MS), "?resume=st_1&last_seq=12&since=5000");
  assert.equal(mfpResumeQuery(held, MFP_RESUME_HOLD_MS + 1), "");                     // the venue has dropped it
  // an attempt that ended without a frame: connect fresh next time...
  const forgot = mfpForgetResume({ ...held, opening: true });
  assert.equal(mfpResumeQuery(forgot, 0), "");
  assert.deepEqual(forgot, { streamId: "st_1", lastSeq: 0, lastTime: 5000, opening: false });
  assert.equal(held.lastSeq, 12, "the input is not changed");
  // ...and the hello that follows still counts as a new stream after one was held
  const hello = onMfpFrame(forgot, { type: "hello", stream_id: "st_7", resumed: false }, ACCT);
  assert.deepEqual(hello.signals, ["resync"]);
  // its first frames are not a gap
  assert.deepEqual(onMfpFrame(hello.cursor, { type: "snapshot_end", seq: 2, time: 6000 }, ACCT).signals, []);
});

test("seq is only ever a gap detector: a frame is classified whatever its number", () => {
  const start = at(57);
  // the venue restarts its count mid-stream
  assert.deepEqual(onMfpFrame(start, { type: "snapshot", account_id: ACCT, reason: "resync", seq: 1, time: 1 }, ACCT).signals, ["resync"]);
  assert.deepEqual(onMfpFrame(start, { type: "fill", account_id: ACCT, seq: 2, time: 1 }, ACCT).signals, ["state"]);
  // numbering per account: another account ran ahead, then ours arrives lower
  const ahead = onMfpFrame(at(3), { type: "order", event: "created", account_id: OTHER, seq: 40, time: 1 }, ACCT);
  assert.deepEqual(onMfpFrame(ahead.cursor, { type: "position", event: "closed", account_id: ACCT, seq: 4, time: 2 }, ACCT).signals, ["state", "history"]);
  // numbering from 0
  assert.deepEqual(onMfpFrame(at(0), { type: "order", event: "filled", account_id: ACCT, seq: 0, time: 2 }, ACCT).signals, ["state"]);
  // no seq at all
  assert.deepEqual(onMfpFrame(at(9), { type: "account", event: "updated", account_id: ACCT, time: 2 }, ACCT).signals, ["state"]);
});

test("silence past the venue's heartbeat means the connection is dead", () => {
  assert.equal(mfpStreamDead(1000, 1000 + MFP_STREAM_SILENT_MS), false);
  assert.equal(mfpStreamDead(1000, 1001 + MFP_STREAM_SILENT_MS), true);
  assert.ok(MFP_STREAM_SILENT_MS >= 30_000, "at least two of the venue's 15 s heartbeats");
});

test("close codes: a refused key is never retried; a restart reconnects at once", () => {
  assert.equal(mfpClosePolicy(4001), "stop");
  assert.equal(mfpClosePolicy(1012), "now");
  assert.equal(mfpClosePolicy(4013), "slow");
  for (const code of [1000, 1006, 1011, 4008, null, undefined]) assert.equal(mfpClosePolicy(code), "backoff", String(code));
});

// React Native reports a refused upgrade as close code 1006 with this text
// as the close REASON (its error event carries none); mfp_stream.ts hands
// the reason here.
test("a refused upgrade: 401 / 403 stop, 429 / 503 go slow, anything else backs off", () => {
  assert.equal(mfpUpgradePolicy("Expected HTTP 101 response but was '401 Unauthorized'"), "stop");
  assert.equal(mfpUpgradePolicy("Expected HTTP 101 response but was '403 Forbidden'"), "stop");
  assert.equal(mfpUpgradePolicy("Expected HTTP 101 response but was '429 Too Many Requests'"), "slow");
  assert.equal(mfpUpgradePolicy("Expected HTTP 101 response but was '503 Service Unavailable'"), "slow");
  assert.equal(mfpUpgradePolicy("Unable to resolve host"), "backoff");
  assert.equal(mfpUpgradePolicy("port 4010 closed"), "backoff");
  assert.equal(mfpUpgradePolicy(""), "backoff");
  assert.equal(mfpUpgradePolicy(null), "backoff");
});

test("reconnects back off to a minute, with jitter, and never spin", () => {
  const mid = 0.5; // no jitter
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 60].map((n) => mfpRetryDelayMs(n, "backoff", mid)), [1000, 2000, 5000, 10000, 30000, 60000, 60000, 60000]);
  assert.equal(mfpRetryDelayMs(0, "slow", mid), 60000);
  assert.equal(mfpRetryDelayMs(0, "now", mid), 0);
  assert.equal(mfpRetryDelayMs(1, "now", mid), 1000);  // a second restart in a row waits
  assert.equal(mfpRetryDelayMs(3, "now", mid), 5000);
  assert.equal(mfpRetryDelayMs(0, "backoff", 0), 800);
  assert.equal(mfpRetryDelayMs(0, "backoff", 0.999999), 1200);
  for (let n = 0; n < 10; n++) assert.ok(mfpRetryDelayMs(n, "backoff", 0) >= 800);
});
