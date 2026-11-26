// src/lib/mfp_rate.ts: the app's own count of the GETs it sends per
// MyFundedPerps key, the hold a 429 sets, and what each class of read may
// still send. Pure: loaded straight from source. Every key here is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  backgroundAllowed, DEFAULT_HOLD_MS, holdUntil, noteGet, noteLimited, noteWarning, parseRetryAfter, RATE_CAP, RATE_LIMIT, rateBucket, rateLine,
  rateNotice, rateWaitMs, resetRate, subscribeRate, tradeWaitMs, used,
} from "../src/lib/mfp_rate.ts";

const KEY_A = "fp_test_" + "fake".repeat(6);
const KEY_B = "fp_live_" + "fake".repeat(6);
const T0 = 1_700_000_000_000;

test("a bucket is a short hash of the key: stable, different per key, and not the key", () => {
  const a = rateBucket(KEY_A), b = rateBucket(KEY_B);
  assert.match(a, /^[0-9a-f]{14}$/);
  assert.equal(a, rateBucket(KEY_A));
  assert.notEqual(a, b);
  assert.ok(!KEY_A.includes(a) && !a.includes("fp_"));
});

test("the caps leave the trade path room under the venue's limit", () => {
  for (const env of ["live", "sandbox"]) {
    assert.ok(RATE_CAP.background[env] < RATE_CAP.settle[env], env);
    assert.ok(RATE_CAP.settle[env] <= RATE_LIMIT[env] - 4, env + ": a close needs four reads");
  }
  assert.deepEqual([RATE_LIMIT.live, RATE_LIMIT.sandbox], [60, 30]);
  assert.deepEqual([RATE_CAP.background.live, RATE_CAP.background.sandbox], [40, 20]);
});

test("GETs are counted over a rolling 60 s", () => {
  resetRate();
  const b = "bucket-count";
  for (let i = 0; i < 5; i++) noteGet(b, T0 + i * 1000);
  assert.equal(used(b, T0 + 5000), 5);
  assert.equal(used(b, T0 + 60_000), 4, "the first one has left the window");
  assert.equal(used(b, T0 + 64_000), 0);
  assert.equal(used("another-bucket", T0), 0, "keys do not share a count");
});

test("a background read waits for the window to free exactly as many GETs as it needs", () => {
  resetRate();
  const b = "bucket-wait";
  for (let i = 0; i < 20; i++) noteGet(b, T0 + i * 1000);       // sandbox background cap: 20
  const now = T0 + 20_000;
  assert.equal(backgroundAllowed(b, "sandbox", now, 1), false);
  assert.equal(rateWaitMs(b, "sandbox", now, 1), 40_000, "until the oldest GET is 60 s old");
  assert.equal(rateWaitMs(b, "sandbox", now, 2), 41_000, "two have to leave for a read of two");
  assert.equal(rateWaitMs(b, "sandbox", now, 1, "settle"), 0, "the re-read after a write has more room");
  assert.equal(backgroundAllowed(b, "live", now, 1), true, "a live key's cap is 40");
  assert.equal(rateWaitMs(b, "sandbox", now + 40_000, 1), 0);
  assert.equal(rateWaitMs(b, "sandbox", now, 99), 60_000, "a read larger than the cap waits a whole window");
});

test("the settle class stops at its own cap", () => {
  resetRate();
  const b = "bucket-settle";
  for (let i = 0; i < 26; i++) noteGet(b, T0);
  assert.ok(rateWaitMs(b, "sandbox", T0 + 1, 1, "settle") > 0);
  assert.equal(rateWaitMs(b, "live", T0 + 1, 1, "settle"), 0);
});

test("a 429 holds the key for its Retry-After; a hold is only ever extended", () => {
  resetRate();
  const b = "bucket-hold";
  assert.equal(holdUntil(b), 0);
  noteLimited(b, 60_000, T0, "api_key", "30");
  assert.equal(holdUntil(b), T0 + 60_000);
  assert.equal(rateWaitMs(b, "sandbox", T0 + 1000, 1), 59_000, "held: nothing in the background goes");
  assert.equal(rateWaitMs(b, "sandbox", T0 + 1000, 1, "settle"), 59_000, "nor the re-read after a write");
  noteLimited(b, 5_000, T0 + 1000);
  assert.equal(holdUntil(b), T0 + 60_000, "a shorter Retry-After does not shorten the hold");
  noteLimited(b, 90_000, T0 + 1000);
  assert.equal(holdUntil(b), T0 + 91_000);
  assert.equal(rateWaitMs(b, "sandbox", T0 + 91_000, 1), 0, "over when the hold ends");
  assert.equal(holdUntil("bucket-other"), 0, "another key is not held");
  const n = rateNotice();
  assert.equal(n.heldUntil, T0 + 91_000);
});

test("a 429 with no usable Retry-After holds for the documented minute; an absurd one is capped", () => {
  resetRate();
  noteLimited("b1", null, T0);
  assert.equal(holdUntil("b1"), T0 + DEFAULT_HOLD_MS);
  noteLimited("b2", 24 * 3600_000, T0);
  assert.equal(holdUntil("b2"), T0 + 5 * 60_000);
  noteLimited("b3", 0, T0);
  assert.equal(holdUntil("b3"), T0 + 1000, "never shorter than a second");
});

test("Retry-After reads whole seconds or an HTTP date, and nothing else", () => {
  assert.equal(parseRetryAfter("60", T0), 60_000);
  assert.equal(parseRetryAfter(" 3 ", T0), 3000);
  assert.equal(parseRetryAfter(new Date(T0 + 30_000).toUTCString(), T0), 30_000);
  assert.equal(parseRetryAfter(new Date(T0 - 30_000).toUTCString(), T0), 0);
  for (const bad of [null, undefined, "", "soon", "-5", "1.5", "9999999"]) assert.equal(parseRetryAfter(bad, T0), null, String(bad));
});

test("the venue's warning is kept for the status bar: cleaned, capped, and never with a key in it", () => {
  resetRate();
  let calls = 0;
  const stop = subscribeRate(() => { calls++; });
  const before = rateNotice();
  assert.equal(rateLine(before, T0), null);
  noteWarning("approaching limit for " + KEY_A + "\u0007 60/min\r\nnext", T0);
  const n = rateNotice();
  assert.notEqual(n, before, "a new object: the subscriber's snapshot changes");
  assert.equal(calls, 1);
  assert.equal(n.warningAt, T0);
  assert.ok(!n.warningText.includes("fp_test_"), n.warningText);
  assert.match(n.warningText, /^approaching limit for \[key\] 60\/min next$/);
  assert.equal(rateLine(n, T0 + 1000), "rate warning");
  assert.equal(rateLine(n, T0 + 6 * 60_000), null, "it leaves the bar after five minutes");
  noteWarning("x".repeat(500), T0);
  assert.equal(rateNotice().warningText.length, 160);
  noteWarning("", T0 + 5);
  noteWarning(null, T0 + 5);
  assert.equal(rateNotice().warningAt, T0, "an empty header is not a warning");
  stop();
});

test("a clock that steps backwards leaves no GET and no hold stuck in the future", () => {
  resetRate();
  const b = "bucket-clock";
  for (let i = 0; i < 20; i++) noteGet(b, T0 + i);
  noteLimited(b, 60_000, T0);
  // the clock goes back an hour
  const then = T0 - 3600_000;
  assert.equal(used(b, then), 0, "GETs stamped after 'now' are dropped, not counted for an hour");
  assert.ok(holdUntil(b, then) <= then + 5 * 60_000, "a hold is never longer than its cap from now");
  assert.ok(rateWaitMs(b, "sandbox", then, 1) <= 5 * 60_000);
  assert.equal(rateWaitMs(b, "sandbox", then + 5 * 60_000 + 1, 1), 0, "background reads are not starved until the old time comes round");
  // and the status line does not count an hour down either
  assert.equal(rateLine({ warningAt: 0, warningText: "", heldUntil: T0 + 60_000, scope: null, limit: null }, then), null);
});

test("a trade-path SEQUENCE is checked against the venue's own limit, and against a hold", () => {
  resetRate();
  const b = "bucket-trade";
  assert.equal(tradeWaitMs(b, "sandbox", T0, 18), 0);
  for (let i = 0; i < 13; i++) noteGet(b, T0 + i * 1000);
  // 13 used: 18 more would make 31 on a sandbox key (limit 30), 31 of 60 on a live one
  assert.equal(tradeWaitMs(b, "sandbox", T0 + 13_000, 18), 47_000, "until one GET has left the window");
  assert.equal(tradeWaitMs(b, "sandbox", T0 + 13_000, 17), 0);
  assert.equal(tradeWaitMs(b, "live", T0 + 13_000, 18), 0);
  noteLimited(b, 60_000, T0 + 13_000);
  assert.equal(tradeWaitMs(b, "live", T0 + 14_000, 1), 59_000, "a held key has room for no sequence");
});

test("the status line counts a hold down and puts it before a warning", () => {
  resetRate();
  noteWarning("over", T0);
  noteLimited("b", 60_000, T0, "api_key", "60");
  const n = rateNotice();
  assert.equal(rateLine(n, T0), "rate limited, next read in 60 s");
  assert.equal(rateLine(n, T0 + 58_500), "rate limited, next read in 2 s");
  assert.equal(rateLine(n, T0 + 60_000), "rate warning");
  assert.equal(n.scope, "api_key");
  assert.equal(n.limit, 60);
});

test("a 429 on a trade-path read does not push a running hold out; with none running it sets one", () => {
  resetRate();
  const b = "bucket-trade-hold";
  noteLimited(b, 60_000, T0);
  assert.equal(holdUntil(b), T0 + 60_000);
  // 40 s in, a trade-path read (sent even inside a hold) is refused with Retry-After: 60
  noteLimited(b, 60_000, T0 + 40_000, "api_key", "30", false);
  assert.equal(holdUntil(b), T0 + 60_000, "the hold still ends when it was going to");
  // a background read's 429 at that moment does extend it, as before
  noteLimited(b, 60_000, T0 + 41_000);
  assert.equal(holdUntil(b), T0 + 101_000);
  // no hold running: a trade-path 429 sets one like any other
  noteLimited("bucket-trade-fresh", 30_000, T0, null, null, false);
  assert.equal(holdUntil("bucket-trade-fresh"), T0 + 30_000);
  // and once a hold has run out, the next trade-path 429 starts a new one
  noteLimited(b, 10_000, T0 + 200_000, null, null, false);
  assert.equal(holdUntil(b), T0 + 210_000);
});
