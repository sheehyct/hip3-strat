// Worker continuity-ledger client (the pure half in src/lib/trades.ts):
// which trades are asked about, how a /api/continuity_at body is validated,
// how an answer becomes a stamp, and how worker stamps compete with device
// stamps in joinTfc. Answer fixtures copy the live route's shapes (probed
// 2026-09-26). Fixture wallets are fake - never a real address.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AT_ENTRY_MS, chunks, classifyTfc, joinTfc, LEDGER_MAX_GAP_MS, LEDGER_MAX_ITEMS, LEDGER_RETRY_MS, ledgerKey,
  parseLedgerAnswers, pickLedgerLookups, providerFromStamps, retryAfterMs,
} from "../src/lib/trades.ts";

const W1 = "0x0000000000000000000000000000000000000001";
const NOW = Date.UTC(2026, 8, 26, 15, 0, 0);
const M = 60e3, D = 86400e3;
const SINCE = NOW - 2 * D;
const RETENTION = 35 * D;
const served = (c) => !c.includes(":") || c.startsWith("xyz:");
const opts = { now: NOW, since: SINCE, retentionMs: RETENTION, served };

function trade(o) {
  return {
    wallet: W1, coin: o.coin ?? "xyz:AAPL", side: o.side ?? "long", truncated: o.truncated ?? false,
    openTime: o.openTime === undefined ? NOW - 3 * 3600e3 : o.openTime, tfc: o.tfc ?? null,
  };
}
function deviceStamp(openTime, lagMs, ftfc = "up") {
  return {
    wallet: W1, coin: "xyz:AAPL", openTime, observedAt: openTime + lagMs, stateTs: openTime + lagMs,
    ftfc, dots: ["up", "up", "up", "up"], dwm: null, source: "device", lagMs,
  };
}
function covered(coin, t, at, extra = {}) {
  return {
    coin, t, covered: true, at, ftfc: "up", dots: ["up", "up", "down", "up"],
    dwmContinuity: { complete: true, dir: null, dots: { "1d": "down", "1w": "up", "1M": "up" } },
    ready: true, ...extra,
  };
}
const notCovered = (coin, t) => ({ coin, t, covered: false, at: null, ftfc: null, dots: null, dwmContinuity: null, ready: null });

// ---- selection ------------------------------------------------------------

test("pick: asks only for trades the ledger can answer and the device did not stamp at entry", () => {
  const t0 = NOW - 3 * 3600e3;
  const trades = [
    trade({ openTime: t0 }),                                              // asked
    trade({ openTime: t0 + 1, tfc: deviceStamp(t0 + 1, 7 * M) }),         // late device stamp -> asked
    trade({ openTime: t0 + 2, tfc: deviceStamp(t0 + 2, 40e3) }),          // stamped at entry -> skipped
    trade({ openTime: null, truncated: true }),                           // no opening fill
    trade({ openTime: t0 + 3, truncated: true }),                         // partial history
    trade({ openTime: NOW + M }),                                         // future (clock skew)
    trade({ openTime: SINCE - 1 }),                                       // before the ledger
    trade({ openTime: t0 + 4, coin: "flx:GOLD" }),                        // unserved builder dex
    trade({ openTime: t0 + 5, coin: "BTC" }),                             // main dex -> asked
    trade({ openTime: t0 }),                                              // duplicate key -> once
  ];
  const got = pickLedgerLookups(trades, new Set(), opts);
  assert.deepEqual(got, [
    { coin: "xyz:AAPL", t: t0 }, { coin: "xyz:AAPL", t: t0 + 1 }, { coin: "BTC", t: t0 + 5 },
  ]);
});

test("pick: a known answer (stamp or final miss) is never asked again", () => {
  const t0 = NOW - 3 * 3600e3;
  const known = new Set([ledgerKey("xyz:AAPL", t0)]);
  assert.deepEqual(pickLedgerLookups([trade({ openTime: t0 })], known, opts), []);
});

test("pick: since unknown still bounds by retention", () => {
  const o = { ...opts, since: null };
  const got = pickLedgerLookups([trade({ openTime: NOW - 40 * D }), trade({ openTime: NOW - 30 * D })], new Set(), o);
  assert.deepEqual(got, [{ coin: "xyz:AAPL", t: NOW - 30 * D }]);
});

test("chunks: batches at the route cap", () => {
  const xs = Array.from({ length: 450 }, (_, i) => i);
  assert.deepEqual(chunks(xs, LEDGER_MAX_ITEMS).map((c) => c.length), [200, 200, 50]);
  assert.deepEqual(chunks([], 200), []);
});

// ---- answers --------------------------------------------------------------

test("answers: a covered item becomes a worker stamp with lag = t - at", () => {
  const t = NOW - 3600e3, at = t - 18e3;
  const [a] = parseLedgerAnswers([covered("xyz:AAPL", t, at)], [{ coin: "xyz:AAPL", t }], W1, NOW);
  assert.equal(a.kind, "stamp");
  assert.deepEqual(a.stamp, {
    wallet: W1, coin: "xyz:AAPL", openTime: t, observedAt: at, stateTs: at, ftfc: "up",
    dots: ["up", "up", "down", "up"], dwm: { complete: true, dir: null, dots: { "1d": "down", "1w": "up", "1M": "up" } },
    source: "worker", lagMs: 18e3,
  });
});

test("answers: covered:false is final once old, retried while recent", () => {
  const old = NOW - LEDGER_RETRY_MS - 1, fresh = NOW - 30e3;
  const asked = [{ coin: "BTC", t: old }, { coin: "BTC", t: fresh }];
  const got = parseLedgerAnswers([notCovered("BTC", old), notCovered("BTC", fresh)], asked, W1, NOW);
  assert.deepEqual(got.map((a) => a.kind), ["miss", "retry"]);
});

test("answers: an unready coin is covered with ftfc null (classifies unknown)", () => {
  const t = NOW - 3600e3;
  const [a] = parseLedgerAnswers([covered("BTC", t, t - 5e3, { ready: false, ftfc: null })], [{ coin: "BTC", t }], W1, NOW);
  assert.equal(a.kind, "stamp");
  assert.equal(a.stamp.ftfc, null);
  assert.equal(classifyTfc(trade({ coin: "BTC", openTime: t }), a.stamp), "unknown");
});

test("answers: ready false never keeps a stray ftfc", () => {
  const t = NOW - 3600e3;
  const [a] = parseLedgerAnswers([covered("BTC", t, t - 5e3, { ready: false, ftfc: "up" })], [{ coin: "BTC", t }], W1, NOW);
  assert.equal(a.stamp.ftfc, null);
});

test("answers: a misaligned body is dropped whole", () => {
  const t = NOW - 3600e3;
  const asked = [{ coin: "BTC", t }, { coin: "ETH", t }];
  assert.equal(parseLedgerAnswers([covered("BTC", t, t - 1)], asked, W1, NOW), null, "short body");
  assert.equal(parseLedgerAnswers([covered("ETH", t, t - 1), covered("BTC", t, t - 1)], asked, W1, NOW), null, "swapped order");
  assert.equal(parseLedgerAnswers([covered("BTC", t, t - 1), covered("ETH", t + 1, t - 1)], asked, W1, NOW), null, "t mismatch");
  assert.equal(parseLedgerAnswers({ error: "busy" }, asked, W1, NOW), null, "not an array");
  assert.equal(parseLedgerAnswers([null, null], asked, W1, NOW), null, "null items");
});

test("answers: a covered item that fails validation is retried, never cached", () => {
  const t = NOW - 3600e3, q = [{ coin: "BTC", t }];
  const kind = (item) => parseLedgerAnswers([item], q, W1, NOW)[0].kind;
  assert.equal(kind(covered("BTC", t, t + 1)), "retry", "at after t");
  assert.equal(kind(covered("BTC", t, t - LEDGER_MAX_GAP_MS - 1)), "retry", "at past the 60 s coverage window");
  assert.equal(kind(covered("BTC", t, t - 4 * M)), "retry", "at minutes early");
  assert.equal(kind(covered("BTC", t, t - LEDGER_MAX_GAP_MS)), "stamp", "exactly 60 s is still covered");
  assert.equal(kind(covered("BTC", t, t)), "stamp", "t on the tick");
  assert.equal(kind(covered("BTC", t, null)), "retry", "at missing");
  assert.equal(kind(covered("BTC", t, t - 1, { ftfc: "sideways" })), "retry", "unknown ftfc");
  assert.equal(kind(covered("BTC", t, t - 1, { dots: null })), "retry", "dots missing");
  assert.equal(kind(covered("BTC", t, t - 1, { dots: [1, 2] })), "retry", "dots not strings");
  assert.equal(kind(covered("BTC", t, t - 1, { ready: "yes" })), "retry", "ready not boolean");
  assert.equal(kind({ ...covered("BTC", t, t - 1), covered: "true" }), "retry", "covered not boolean");
});

test("answers: a malformed dwm block is dropped, the stamp kept", () => {
  const t = NOW - 3600e3;
  const [a] = parseLedgerAnswers([covered("BTC", t, t - 1, { dwmContinuity: { complete: "y" } })], [{ coin: "BTC", t }], W1, NOW);
  assert.equal(a.kind, "stamp");
  assert.equal(a.stamp.dwm, null);
});

// ---- join with the device provider ----------------------------------------

test("join: a ledger answer outranks a late device stamp and classifies the trade", () => {
  const t = NOW - 3600e3;
  const tr = trade({ openTime: t, side: "short" });
  const device = providerFromStamps([deviceStamp(t, 7 * M, "up")]);
  const [a] = parseLedgerAnswers([covered("xyz:AAPL", t, t - 20e3, { ftfc: "down" })], [{ coin: "xyz:AAPL", t }], W1, NOW);
  const [joined] = joinTfc([tr], [device, providerFromStamps([a.stamp])]);
  assert.equal(joined.tfc.source, "worker");
  assert.equal(classifyTfc(joined, joined.tfc), "with");
});

test("join: a closer device stamp still wins over the ledger", () => {
  const t = NOW - 3600e3;
  const device = providerFromStamps([deviceStamp(t, 10e3, "up")]);
  const [a] = parseLedgerAnswers([covered("xyz:AAPL", t, t - 25e3, { ftfc: "down" })], [{ coin: "xyz:AAPL", t }], W1, NOW);
  const [joined] = joinTfc([trade({ openTime: t })], [device, providerFromStamps([a.stamp])]);
  assert.equal(joined.tfc.source, "device");
  assert.equal(classifyTfc(joined, joined.tfc), "with");
});

test("provider: position-observed stamps (openTime null) still match after the move", () => {
  const t = NOW - 3600e3;
  const obs = { ...deviceStamp(t, 0), openTime: null, observedAt: t + 90e3, lagMs: null };
  const got = providerFromStamps([obs]).get(W1, "xyz:AAPL", t);
  assert.equal(got.lagMs, 90e3);
  assert.ok(got.lagMs <= AT_ENTRY_MS);
});

// ---- 503 pause -------------------------------------------------------------

test("retryAfterMs: honours Retry-After within [5 s, 10 min]; absent means a long pause", () => {
  assert.equal(retryAfterMs("5"), 5e3);
  assert.equal(retryAfterMs("0"), 5e3);
  assert.equal(retryAfterMs("30"), 30e3);
  assert.equal(retryAfterMs("99999"), 600e3);
  assert.equal(retryAfterMs(null), 600e3);
  assert.equal(retryAfterMs(""), 600e3);
  assert.equal(retryAfterMs("soon"), 600e3);
});
