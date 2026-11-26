"use strict";

// Delivery tests: retry with backoff on transient failures (429/5xx/network),
// no retry on config errors / other 4xx, serialized sends with a minimum
// inter-send gap (burst rate limiting), LOG_ONLY short-circuit.
// node builtins only: node --test. fetch is stubbed - no network.

const test = require("node:test");
const assert = require("node:assert");
const { deliver, deliverStats } = require("../src/deliver.js");

const realFetch = global.fetch;
const savedEnv = {};
for (const k of ["ALERT_BACKEND", "ALERT_WEBHOOK_URL", "LOG_ONLY"]) savedEnv[k] = process.env[k];

test.beforeEach(function () {
  process.env.ALERT_BACKEND = "ntfy";
  process.env.ALERT_WEBHOOK_URL = "http://127.0.0.1:1/test-topic";
  delete process.env.LOG_ONLY;
});

test.after(function () {
  global.fetch = realFetch;
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function stubFetch(statuses, calls) {
  let i = 0;
  global.fetch = async function (url, opts) {
    calls.push({ url: url, body: opts.body, t: Date.now() });
    const status = statuses[Math.min(i++, statuses.length - 1)];
    if (status === "network") throw new Error("fetch failed");
    return { ok: status >= 200 && status < 300, status: status };
  };
}

test("transient 429 is retried with backoff until it succeeds", async function () {
  const calls = [];
  stubFetch([429, 200], calls);
  const t0 = Date.now();
  const ok = await deliver("[LIVE] TEST 1H 3-2U up");
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.length, 2);
  assert.ok(Date.now() - t0 >= 900, "expected ~1s backoff before the retry");
});

test("network error then 5xx then success is retried through", async function () {
  const calls = [];
  stubFetch(["network", 503, 200], calls);
  const ok = await deliver("[INVAL] TEST 1H 3-2U went 3");
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.length, 3);
});

test("non-retryable 4xx fails after a single attempt", async function () {
  const calls = [];
  stubFetch([400], calls);
  const ok = await deliver("[SCORE] TEST +62");
  assert.strictEqual(ok, false);
  assert.strictEqual(calls.length, 1);
});

test("config error (unknown backend) is not retried and never fetches", async function () {
  const calls = [];
  stubFetch([200], calls);
  process.env.ALERT_BACKEND = "carrier-pigeon";
  const ok = await deliver("[LIVE] TEST");
  assert.strictEqual(ok, false);
  assert.strictEqual(calls.length, 0);
});

test("burst sends are serialized with a minimum inter-send gap", async function () {
  const calls = [];
  stubFetch([200], calls);
  const results = await Promise.all([
    deliver("msg-1"), deliver("msg-2"), deliver("msg-3")
  ]);
  assert.deepStrictEqual(results, [true, true, true]);
  assert.strictEqual(calls.length, 3);
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].t - calls[i - 1].t >= 400,
      "sends " + i + " spaced " + (calls[i].t - calls[i - 1].t) + "ms apart (< min gap)");
  }
});

test("LOG_ONLY=1 logs and never touches fetch", async function () {
  const calls = [];
  stubFetch([200], calls);
  process.env.LOG_ONLY = "1";
  const ok = await deliver("[RVOL] TEST 15m rvol 3.4x");
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.length, 0);
});

// Delivery observability (P0 item 7). Added after this channel failed 100% in
// production while /health read "ok": alertsFired counts alerts that FIRED,
// so a dead webhook and a healthy one were indistinguishable. Success is also
// completely silent - the only log line deliver.js ever writes is a failure -
// so these counters are the sole positive signal that a send worked.
// Counters are module-level and accumulate across the whole run, so these
// tests assert on DELTAS rather than absolute values.

test("deliverStats counts a successful send", async function () {
  const before = deliverStats();
  stubFetch([200], []);
  await deliver("ok message");
  const after = deliverStats();
  assert.strictEqual(after.sent - before.sent, 1, "sent incremented");
  assert.strictEqual(after.failed - before.failed, 0, "failed untouched");
});

test("deliverStats counts a permanent failure once, not once per retry", async function () {
  const before = deliverStats();
  const calls = [];
  stubFetch(["network"], calls);           // retried to exhaustion
  await deliver("doomed message");
  const after = deliverStats();
  assert.strictEqual(after.failed - before.failed, 1,
    "one failed alert, not one per attempt");
  assert.ok(calls.length > 1, "it really did retry");
  assert.strictEqual(after.sent - before.sent, 0);
  assert.ok(after.lastError && /fetch failed/.test(after.lastError.error),
    "lastError carries the transport message");
  assert.ok(typeof after.lastError.at === "number", "lastError is timestamped");
});

test("deliverStats reports the backend, so a typo'd value is visible", async function () {
  process.env.ALERT_BACKEND = "nfty";      // the real typo this project hit
  assert.strictEqual(deliverStats().backend, "nfty");
  process.env.ALERT_BACKEND = "discord";
  assert.strictEqual(deliverStats().backend, "discord");
});

test("deliverStats flags LOG_ONLY so a soak run is not read as live delivery", async function () {
  process.env.LOG_ONLY = "1";
  const before = deliverStats();
  assert.strictEqual(before.logOnly, true);
  await deliver("soak message");
  assert.strictEqual(deliverStats().sent - before.sent, 1,
    "the alert completed the configured delivery path");
  delete process.env.LOG_ONLY;
  assert.strictEqual(deliverStats().logOnly, false);
});

test("a config error counts as failed without retrying", async function () {
  delete process.env.ALERT_BACKEND;        // -> unknown backend, permanent
  const before = deliverStats();
  const calls = [];
  stubFetch([200], calls);
  await deliver("misconfigured");
  const after = deliverStats();
  assert.strictEqual(after.failed - before.failed, 1);
  assert.strictEqual(calls.length, 0, "no network attempt for a config error");
  assert.ok(/ALERT_BACKEND/.test(after.lastError.error));
});
