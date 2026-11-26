// src/lib/mfp_rate.ts: the per-key GET budget (MFP notice 2026-11-25: 60 a
// minute on a live key, 30 on a sandbox key). Fake keys only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  mfpBackgroundAllowed, mfpBackgroundWaitMs, mfpBucket, mfpGetsUsed, mfpHoldMs, mfpLookupDelayMs, mfpLookupHoldPlan,
  mfpRateWarning, mfpRoomFor, mfpSoftCap, mfpVenueLimit, noteMfpGet, noteMfpLimited, noteMfpRateWarning, parseRetryAfterMs,
  resetMfpRate, subscribeMfpRate,
} from "../src/lib/mfp_rate.ts";

const KEY_A = "fp_test_" + "a".repeat(40);
const KEY_B = "fp_test_" + "b".repeat(40);
const T0 = 1_800_000_000_000;

beforeEach(() => resetMfpRate());

test("a bucket id is short, stable, differs by key and never contains the key", () => {
  const a = mfpBucket(KEY_A);
  assert.equal(a, mfpBucket(KEY_A));
  assert.notEqual(a, mfpBucket(KEY_B));
  assert.ok(a.length <= 10);
  assert.ok(!KEY_A.includes(a) && !a.includes("fp_"));
});

test("the soft caps sit under the venue's limits", () => {
  assert.ok(mfpSoftCap("live") < 60);
  assert.ok(mfpSoftCap("sandbox") < 30);
});

test("GETs are counted over the last minute only", () => {
  const b = mfpBucket(KEY_A);
  for (let i = 0; i < 5; i++) noteMfpGet(b, T0 + i * 1000);
  assert.equal(mfpGetsUsed(b, T0 + 5000), 5);
  assert.equal(mfpGetsUsed(b, T0 + 60_000), 4);       // the first is exactly a minute old: gone
  assert.equal(mfpGetsUsed(b, T0 + 64_001), 0);
});

test("each key has its own budget", () => {
  const a = mfpBucket(KEY_A);
  const b = mfpBucket(KEY_B);
  for (let i = 0; i < 20; i++) noteMfpGet(a, T0);
  assert.equal(mfpBackgroundAllowed(a, "sandbox", T0, 1), false);
  assert.equal(mfpBackgroundAllowed(b, "sandbox", T0, 1), true);
});

test("a background cycle is admitted only when the WHOLE cycle fits the soft cap", () => {
  const b = mfpBucket(KEY_A);
  const cap = mfpSoftCap("sandbox");
  for (let i = 0; i < cap - 5; i++) noteMfpGet(b, T0 + i);
  assert.equal(mfpBackgroundAllowed(b, "sandbox", T0 + 100, 5), true);
  assert.equal(mfpBackgroundAllowed(b, "sandbox", T0 + 100, 6), false);
  // the same count is fine on a live key, whose cap is higher
  assert.equal(mfpBackgroundAllowed(b, "live", T0 + 100, 6), true);
});

test("the wait is exactly until enough of the oldest GETs leave the window", () => {
  const b = mfpBucket(KEY_A);
  const cap = mfpSoftCap("sandbox");
  for (let i = 0; i < cap; i++) noteMfpGet(b, T0 + i * 1000); // one a second
  const now = T0 + cap * 1000;
  // 1 more needs the oldest (sent at T0) to leave: at T0 + 60 s
  assert.equal(mfpBackgroundWaitMs(b, "sandbox", now, 1), T0 + 60_000 - now);
  // 3 more need the third oldest (sent at T0 + 2 s) to leave
  assert.equal(mfpBackgroundWaitMs(b, "sandbox", now, 3), T0 + 2000 + 60_000 - now);
  assert.equal(mfpBackgroundWaitMs(b, "sandbox", T0 + 60_000, 1), 0);
});

test("a cycle larger than the whole cap is let through on an empty window, not starved", () => {
  const b = mfpBucket(KEY_A);
  const cap = mfpSoftCap("sandbox");
  assert.equal(mfpBackgroundAllowed(b, "sandbox", T0, cap + 10), true);
  noteMfpGet(b, T0);
  assert.equal(mfpBackgroundWaitMs(b, "sandbox", T0 + 1000, cap + 10), 59_000);
});

// A 30 s timer puts THREE bursts inside one 60 s window (the burst a minute
// ago has not quite left when the next is asked for), so the poll keeps its
// full 30 s pace while three cycles fit the soft cap: up to 10 markets on a
// live key, 3 on a sandbox key. Above that it skips ticks (the next test).
test("the steady Portfolio poll is never held back: 3 GETs + one quote per market, every 30 s", () => {
  for (const [env, markets] of [["live", 10], ["sandbox", 3]]) {
    resetMfpRate();
    const b = mfpBucket(KEY_A);
    let refused = 0;
    for (let tick = 0; tick < 20; tick++) {
      const now = T0 + tick * 30_000;
      const cost = 3 + markets;
      if (!mfpBackgroundAllowed(b, env, now, cost)) { refused++; continue; }
      for (let i = 0; i < cost; i++) noteMfpGet(b, now + i * 10);
    }
    assert.equal(refused, 0, env + " with " + markets + " markets");
  }
});

test("a poll too heavy for the cap slows itself down instead of passing the limit", () => {
  const b = mfpBucket(KEY_A);
  const cost = 3 + 12; // 12 markets on a sandbox key: 30 a minute at a 30 s poll
  let most = 0;
  for (let tick = 0; tick < 40; tick++) {
    const now = T0 + tick * 30_000;
    if (mfpBackgroundAllowed(b, "sandbox", now, cost)) for (let i = 0; i < cost; i++) noteMfpGet(b, now + i * 10);
    most = Math.max(most, mfpGetsUsed(b, now + 1000));
  }
  assert.ok(most <= mfpSoftCap("sandbox"), "never above the soft cap, saw " + most);
  assert.ok(most > 0);
});

test("Retry-After: whole seconds, clamped, and the documented 60 s when missing", () => {
  assert.equal(parseRetryAfterMs("60"), 60_000);
  assert.equal(parseRetryAfterMs(" 5 "), 5000);
  assert.equal(parseRetryAfterMs("0"), 1000);
  assert.equal(parseRetryAfterMs("99999"), 300_000);
  assert.equal(parseRetryAfterMs(null), 60_000);
  assert.equal(parseRetryAfterMs(undefined), 60_000);
  assert.equal(parseRetryAfterMs("soon"), 60_000);
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"), 60_000);
  assert.equal(parseRetryAfterMs("-3"), 60_000);
});

test("a 429 holds every background read on that key until the wait is over", () => {
  const b = mfpBucket(KEY_A);
  noteMfpLimited(b, 60_000, T0);
  assert.equal(mfpHoldMs(b, T0 + 1000), 59_000);
  assert.equal(mfpBackgroundAllowed(b, "live", T0 + 59_999, 1), false);
  assert.equal(mfpBackgroundWaitMs(b, "live", T0 + 20_000, 1), 40_000);
  assert.equal(mfpBackgroundAllowed(b, "live", T0 + 60_000, 1), true);
  // another key is not held
  assert.equal(mfpBackgroundAllowed(mfpBucket(KEY_B), "live", T0 + 1000, 1), true);
});

test("a later, shorter answer never shortens a hold; a bad value becomes the default", () => {
  const b = mfpBucket(KEY_A);
  noteMfpLimited(b, 60_000, T0);
  noteMfpLimited(b, 2000, T0 + 1000);
  assert.equal(mfpHoldMs(b, T0 + 1000), 59_000);
  const c = mfpBucket(KEY_B);
  noteMfpLimited(c, Number.NaN, T0);
  assert.equal(mfpHoldMs(c, T0), 60_000);
});

test("the wait counts whichever is longer, the hold or the cap", () => {
  const b = mfpBucket(KEY_A);
  const cap = mfpSoftCap("sandbox");
  for (let i = 0; i < cap; i++) noteMfpGet(b, T0 + 50_000);
  noteMfpLimited(b, 5000, T0 + 50_000);
  // hold ends at T0 + 55 s, the cap frees at T0 + 110 s
  assert.equal(mfpBackgroundWaitMs(b, "sandbox", T0 + 51_000, 1), 59_000);
});

test("order lookups slow down: a lookup run to a 60 s deadline stays near 20 GETs", () => {
  assert.equal(mfpLookupDelayMs(0), 700);
  assert.equal(mfpLookupDelayMs(4), 3000);
  assert.equal(mfpLookupDelayMs(400), 3000);
  assert.equal(mfpLookupDelayMs(-1), 700);
  let t = 0;
  let lookups = 0;
  for (let attempt = 0; t < 60_000; attempt++) { lookups++; t += 250 + mfpLookupDelayMs(attempt); } // 250 ms a round trip
  assert.ok(lookups <= 22, "saw " + lookups);
  // the first 20 s (the usual deadline) costs about 9
  t = 0; lookups = 0;
  for (let attempt = 0; t < 20_000; attempt++) { lookups++; t += 250 + mfpLookupDelayMs(attempt); }
  assert.ok(lookups <= 10, "saw " + lookups);
});

test("the grace-period warning is kept (time, environment, clipped text) and announced", () => {
  assert.equal(mfpRateWarning(), null);
  let told = 0;
  const off = subscribeMfpRate(() => { told++; });
  noteMfpRateWarning("live", "x".repeat(500), T0);
  assert.equal(told, 1);
  const w = mfpRateWarning();
  assert.equal(w.at, T0);
  assert.equal(w.env, "live");
  assert.equal(w.text.length, 200);
  off();
  noteMfpRateWarning("sandbox", "again", T0 + 1);
  assert.equal(told, 1);
  assert.equal(mfpRateWarning().env, "sandbox");
});

test("room for a whole sequence is judged against the VENUE's limit, and never during a hold", () => {
  const b = mfpBucket(KEY_A);
  assert.equal(mfpVenueLimit("live"), 60);
  assert.equal(mfpVenueLimit("sandbox"), 30);
  for (let i = 0; i < 12; i++) noteMfpGet(b, T0 + i);
  assert.equal(mfpRoomFor(b, "sandbox", T0 + 100, 18), true);    // 12 + 18 = 30
  noteMfpGet(b, T0 + 50);
  assert.equal(mfpRoomFor(b, "sandbox", T0 + 100, 18), false);   // 31
  assert.equal(mfpRoomFor(b, "live", T0 + 100, 18), true);
  assert.equal(mfpRoomFor(b, "sandbox", T0 + 60_100, 18), true); // the window moved on
  noteMfpLimited(b, 60_000, T0 + 60_100);
  assert.equal(mfpRoomFor(b, "live", T0 + 60_200, 1), false);
  assert.equal(mfpRoomFor(b, "live", T0 + 120_100, 1), true);
});

test("a rate-limited lookup waits the named time, then gets exactly one more look", () => {
  const until = T0 + 20_000;
  const hardStop = until + 65_000;
  // limited 5 s in, told to wait 60 s: sleep 60 s, and the deadline moves to just past it
  assert.deepEqual(mfpLookupHoldPlan(T0 + 5000, 60_000, until, hardStop), { waitMs: 60_000, until: T0 + 67_000 });
  // a short wait inside the deadline leaves the deadline alone
  assert.deepEqual(mfpLookupHoldPlan(T0 + 5000, 2000, until, hardStop), { waitMs: 2000, until });
  // limited again after that wait: no time for another look before the hard stop - stop now, do not sleep
  assert.equal(mfpLookupHoldPlan(T0 + 65_400, 60_000, T0 + 67_000, hardStop), null);
  // a wait longer than the whole allowance is never slept through
  assert.equal(mfpLookupHoldPlan(T0 + 5000, 300_000, until, hardStop), null);
  // the deadline never passes the hard stop
  const p = mfpLookupHoldPlan(T0 + 20_000, 63_000, until, hardStop);
  assert.ok(p && p.until <= hardStop && p.until >= T0 + 20_000 + 63_000);
  // a nonsense wait becomes the documented 60 s; a tiny one is at least a second (never a spin)
  assert.equal(mfpLookupHoldPlan(T0, Number.NaN, until, hardStop).waitMs, 60_000);
  assert.equal(mfpLookupHoldPlan(T0, 0, until, hardStop).waitMs, 1000);
});

test("a clock that steps backwards does not starve the key", () => {
  const b = mfpBucket(KEY_A);
  const cap = mfpSoftCap("sandbox");
  for (let i = 0; i < cap; i++) noteMfpGet(b, T0 + 3_600_000 + i);   // sent "an hour from now"
  noteMfpLimited(b, 60_000, T0 + 3_600_000);
  // the clock is set back an hour
  assert.equal(mfpGetsUsed(b, T0), 0);
  assert.ok(mfpHoldMs(b, T0) <= 300_000);
  assert.equal(mfpBackgroundAllowed(b, "sandbox", T0 + 300_001, 3), true);
});
