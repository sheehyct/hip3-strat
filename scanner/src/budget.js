"use strict";

// Exchange request accounting for the Hyperliquid info endpoint.
//
// Every request loop.js sends (post() and postMids()) is recorded here by
// KIND - candle (candleSnapshot), ctx (metaAndAssetCtxs), mids (allMids),
// other - and by OUTCOME - ok, 429, http (any other non-2xx), net (fetch
// threw: timeout, DNS, reset). The ledger keeps lifetime totals for /health
// and emits ONE log line per clock minute describing that minute, so the
// exchange's refusal threshold can be MEASURED from the deploy log instead
// of inferred from a documented weight table that has never fit the
// observed throughput (measured 2026-09-18: ~275 candle fetches complete in
// ~60 s with 5-8 exhausted while allMids is refused for ~50 s, which a flat
// 1,200-weight, candle-20 model cannot produce).
//
// The minute line carries what discriminates the limiter models:
//   - ok/429 per 10 s bucket across kinds: a fixed clock-aligned window
//     shows successes stop dead after the first 429 until :00; a leaky
//     bucket shows them trickle on at the refill rate.
//   - okBefore429 per kind: in a minute where a sweep saturates the window,
//     this IS the window budget (minus whatever the minute had already
//     spent), in that kind's units.
//   - first429 offset: how far into the minute the budget ran out.
// Timestamps are the ledger's injected clock (Date.now in production) and
// the minute key is floor(t / 60000) - UTC-aligned, as the exchange's
// recovery pattern is (every measured mids gap ended at :01-:03 past a
// clock minute).

const KINDS = ["candle", "ctx", "mids", "other"];
const BUCKET_MS = 10000;
const MINUTE_MS = 60000;

function kindOf(body) {
  const t = body && body.type;
  if (t === "candleSnapshot") return "candle";
  if (t === "metaAndAssetCtxs") return "ctx";
  if (t === "allMids") return "mids";
  return "other";
}

function zeroKind() { return { attempts: 0, ok: 0, r429: 0, http: 0, net: 0 }; }
function zeroAll() {
  const o = {};
  for (let i = 0; i < KINDS.length; i++) o[KINDS[i]] = zeroKind();
  return o;
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function minuteLabel(minuteKey) {
  const d = new Date(minuteKey * MINUTE_MS);
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + "Z";
}

// One minute's record. `okBefore429` counts successes per kind until the
// minute's FIRST 429 of any kind; after that, `okAfter429` counts them.
function newMinute(key) {
  const buckets = [];
  for (let i = 0; i < MINUTE_MS / BUCKET_MS; i++) buckets.push({ ok: 0, r429: 0 });
  return {
    key: key,
    perKind: zeroAll(),
    buckets: buckets,
    first429At: null,       // ms offset into the minute
    okBefore429: zeroAll(), // only .ok is used, kept per kind for the line
    okAfter429: 0
  };
}

function formatMinute(m) {
  const parts = [];
  for (let i = 0; i < KINDS.length; i++) {
    const k = KINDS[i], c = m.perKind[k];
    // A kind appears when it has ANY count: a request that started in the
    // previous minute and completed in this one has an outcome here with
    // no attempt, and /health and the line must agree (audit 2026-09-18 L1).
    if (!c.attempts && !c.ok && !c.r429 && !c.http && !c.net) continue;
    let s = k + " a=" + c.attempts + " ok=" + c.ok;
    if (c.r429) s += " 429=" + c.r429;
    if (c.http) s += " http=" + c.http;
    if (c.net) s += " net=" + c.net;
    parts.push(s);
  }
  const b = m.buckets.map(function (x) { return x.ok + "/" + x.r429; }).join(" ");
  let tail = "10s ok/429: " + b;
  if (m.first429At !== null) {
    const before = [];
    for (let i = 0; i < KINDS.length; i++) {
      const k = KINDS[i];
      if (m.okBefore429[k].ok) before.push(k + "=" + m.okBefore429[k].ok);
    }
    tail += " | first429=+" + (m.first429At / 1000).toFixed(1) + "s"
      + " okBefore429 " + (before.length ? before.join(" ") : "none")
      + " okAfter429=" + m.okAfter429;
  }
  return "[reqs] " + minuteLabel(m.key) + " " + parts.join(" | ") + " | " + tail;
}

// opts.now: clock (ms). opts.log: line sink. Both injectable for tests.
function createLedger(opts) {
  opts = opts || {};
  const now = opts.now || Date.now;
  const log = opts.log || function () {};
  const lifetime = zeroAll();
  let cur = null;
  let last = null;   // the most recently COMPLETED minute, for /health

  // Roll the minute record forward to the one containing t, emitting every
  // completed minute (a quiet minute between two active ones is emitted
  // too, so the log never has a silent hole a reader could mistake for a
  // gap in the capture).
  function roll(t) {
    const key = Math.floor(t / MINUTE_MS);
    if (cur && cur.key === key) return cur;
    if (cur) {
      log(formatMinute(cur));
      last = cur;
      // A skipped minute (no requests at all) is emitted as an empty line,
      // and `last` is always the minute immediately before the current one.
      for (let k = cur.key + 1; k < key; k++) { last = newMinute(k); log(formatMinute(last)); }
    }
    cur = newMinute(key);
    return cur;
  }

  function attempt(kind, t) {
    t = t === undefined ? now() : t;
    const m = roll(t);
    m.perKind[kind].attempts++;
    lifetime[kind].attempts++;
  }

  // outcome: "ok" | "429" | "http" | "net"
  function outcome(kind, result, t) {
    t = t === undefined ? now() : t;
    const m = roll(t);
    const off = t - m.key * MINUTE_MS;
    const bi = Math.min(m.buckets.length - 1, Math.max(0, Math.floor(off / BUCKET_MS)));
    if (result === "ok") {
      m.perKind[kind].ok++; lifetime[kind].ok++;
      m.buckets[bi].ok++;
      if (m.first429At === null) m.okBefore429[kind].ok++;
      else m.okAfter429++;
    } else if (result === "429") {
      m.perKind[kind].r429++; lifetime[kind].r429++;
      m.buckets[bi].r429++;
      if (m.first429At === null) m.first429At = off;
    } else if (result === "http") {
      m.perKind[kind].http++; lifetime[kind].http++;
    } else {
      m.perKind[kind].net++; lifetime[kind].net++;
    }
  }

  function snapshotMinute(m) {
    if (!m) return null;
    return {
      minute: minuteLabel(m.key),
      perKind: JSON.parse(JSON.stringify(m.perKind)),
      first429AtMs: m.first429At,
      okAfter429: m.okAfter429
    };
  }

  // /health view: lifetime per-kind counters plus the last completed minute
  // and the minute in progress (so a probe during a sweep sees the live
  // picture without waiting for the roll).
  function stats(t) {
    t = t === undefined ? now() : t;
    roll(t);
    return {
      lifetime: JSON.parse(JSON.stringify(lifetime)),
      lastMinute: snapshotMinute(last),
      currentMinute: snapshotMinute(cur)
    };
  }

  return { attempt: attempt, outcome: outcome, stats: stats, formatMinute: formatMinute };
}

// ---------------------------------------------------------------------------
// Client-side request budget.
//
// MEASURED 2026-09-18 (local probes 08:48-09:39Z, one kind per clock
// minute, plus the production ledger on the host's IP): the exchange
// enforces a CLOCK-ALIGNED per-minute window of roughly 150-170 REQUESTS,
// the same for candleSnapshot (160 / 149 / 140 / 150 before the first 429
// in four probes; 142-163 in production), metaAndAssetCtxs (154 / 164) and
// a production-cadence allMids (20 spaced polls cost 22 candle-equivalents
// against a candles-only control; production minutes with ~30 polls
// exhausted at ~120-126 candles where ~4-poll minutes reached 152-163).
// Only hammered IDENTICAL repeats are free (1,034 allMids at 23/s with zero
// 429s - a response cache, not a lighter weight), so the documented "weight
// 2" must not be used for the 4 s poll. After the first 429 nothing
// succeeds on the host's IP until +0.2..+2 s past the next :00 (the
// local IP showed a small trickle; the strict case is what is sized
// for). The documented 1,200 weight/min never fit: at the documented 20 per
// request the window is ~3,000-3,400.
//
// Shape: a token bucket in weight units with a SMALL burst (one candle per
// queue worker) and a smooth refill. That bounds consumption in ANY 60 s
// span to burst + rate, whichever way the exchange's boundary is aligned to
// our clock - a quota that bursts at :00 would only be safe if the two
// clocks agreed to the second. Two lanes wait for tokens, ctx before candle
// (a 60 s ctx refresh must not queue behind a 9-minute candle stack); the
// mids poll NEVER waits: take() deducts what it costs and floors at zero, so
// a due allMids goes out on its 4 s tick regardless of candle work (the
// tape must never go dark; sweeps may take longer). A 429 from any kind
// means the estimate was wrong for this minute: drain, hold both lanes
// until the next :00 plus slack (the measured recovery), and cut the rate
// 15% - restored after an hour without a 429. A wrong estimate therefore
// self-corrects within minutes instead of degrading the tape every window.

// Every request is one BASE unit; kept in the documented weight scale (20
// per request) so BUDGET_PER_MIN reads in the exchange's own units. mids is
// 20, not the documented 2: measured above.
const COST = { candle: 20, ctx: 20, mids: 20, other: 20 };
// candleSnapshot carries a SIZE component on top of the base unit: the
// docs (re-read 2026-09-19) give it "an additional rate limit weight per
// 60 items returned in the response". The returned count is unknown until
// the response lands, so the charge is the count REQUESTED - the upper
// bound (a thin market returns fewer bars, never more): 15m x 40 = 20,
// 1h x 168 = 22, 1d x 220 = 23, 30m/4h x 12 = 20. The 2026-09-18 probes
// are consistent with it (160 successes at 40 bars, 149 at 220 before the
// first 429) but cannot confirm it - the two controls spread 140-150 - so
// this is the documented formula applied conservatively, not a measured
// constant. The rate stays at the measured 2,000; the size component
// costs the 00:00 UTC stack ~5% (286 x 105 units instead of 286 x 100).
const INTERVAL_MS = {
  "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000,
  "2h": 7200000, "4h": 14400000, "8h": 28800000, "12h": 43200000, "1d": 86400000,
  "3d": 259200000, "1w": 604800000, "1M": 2678400000
};
const ITEMS_PER_EXTRA_UNIT = 60;
// The exchange returns at most 5,000 candles per request, so the size
// component is capped there: 83 extra units, 103 in all, always under the
// default burst (120) - a request body with a broken span (a null start,
// a runaway window) can cost at most that, never a debt the pipeline would
// take hours to repay (review 2026-09-19, MED 3). Pinned by a test.
const MAX_BARS_PER_REQUEST = 5000;

// Bars a candleSnapshot request asks for: the span over the interval, whole
// bars up. Unknown interval or span -> 0 (base cost only).
function barsRequested(req) {
  if (!req) return 0;
  const ms = INTERVAL_MS[req.interval];
  const span = Number(req.endTime) - Number(req.startTime);
  if (!ms || !(span > 0)) return 0;
  return Math.min(MAX_BARS_PER_REQUEST, Math.ceil(span / ms));
}

// The cost post() acquires for a request body: the kind's base unit plus,
// for candleSnapshot, one unit per 60 bars requested.
function costOf(body) {
  const kind = kindOf(body);
  let cost = COST[kind];
  if (kind === "candle") cost += Math.floor(barsRequested(body && body.req) / ITEMS_PER_EXTRA_UNIT);
  return cost;
}
// 100 units/min. The window alone would allow 0.8 x 150 = 120, and the
// first deploy ran at 2,400 - but the window is SHARED: the host's egress
// IP also carried a second client of the exchange, whose declared REST
// cap (900 weight/min = ~45 requests at the documented 20) was sized
// against the documented 1,200, not the real ~150-request window. Measured
// 2026-09-18: every minute we ran at 120+ of our own requests while it was
// active closed with a 429 late in the minute (10:16:48, 11:07:57,
// 11:28:55, 11:37:58 - at 96-109 of ours), and 18 minutes at 102 drew
// none. So 100 is the measured safe operating point for this IP; the
// adaptive cut below remains the safety net, and BUDGET_PER_MIN goes back
// up if the co-tenant's share moves. The fixed load inside the 100 is 30
// mids polls + 2 ctx = 32 units/min (deducted from the same bucket), so
// the candle lane gets ~68/min: a 275-coin 15m sweep ~4 min (was ~1 min
// with a dark tape); the :00 three-timeframe stack (~845) ~12 min; the
// 00:00 UTC five-timeframe stack (~1,400) ~21 min (was ~7.5 min with the
// tape dark for 8 of them). Boot has no mids poll, so its 1,430 fetches
// run at the full 100/min (~14 min, was ~9 with 429 storms).
const DEFAULT_RATE_PER_MIN = 2000;
const DEFAULT_BURST = 6 * COST.candle;
const MIN_RATE_PER_MIN = 600;          // floor for the 429 back-off (30 candles/min)
const PENALTY_FACTOR = 0.85;
const RECOVER_AFTER_MS = 60 * MINUTE_MS;
const HOLD_SLACK_MS = 1500;            // measured recovery lands at +0.2..+2 s past :00
const LANES = ["ctx", "candle"];

// opts: ratePerMin, burst, now, setTimeout, clearTimeout, log - all
// injectable; production passes only what env overrides.
function createLimiter(opts) {
  opts = opts || {};
  const now = opts.now || Date.now;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const log = opts.log || function () {};
  const configured = Math.max(MIN_RATE_PER_MIN, Number(opts.ratePerMin) || DEFAULT_RATE_PER_MIN);
  const burst = Math.max(COST.candle, Number(opts.burst) || DEFAULT_BURST);
  let rate = configured;              // weight per minute, current
  let tokens = burst;
  let lastRefill = now();
  let holdUntil = 0;
  let lastPenaltyAt = 0;
  let timer = null;
  const waiting = { ctx: [], candle: [] };
  const stats = { holds: 0, heldRefusals: 0, waits: 0, waitMsTotal: 0, maxWaitMs: 0, midsUncovered: 0, restores: 0 };

  function refill(t) {
    if (t > lastRefill) tokens = Math.min(burst, tokens + (t - lastRefill) * rate / MINUTE_MS);
    lastRefill = t;
  }

  // One step back per clean hour, not a jump to the configured rate: a
  // co-tenant on the shared egress IP that bursts about hourly (measured
  // 2026-09-18: ~55 requests at 10:16:48Z and 11:07:57Z) would collide
  // with a full restore every time; stepping lets the rate settle where
  // collisions are rare. The step is the inverse of the cut, so one clean
  // hour undoes one event.
  function maybeRestore(t) {
    if (rate < configured && lastPenaltyAt && t - lastPenaltyAt >= RECOVER_AFTER_MS) {
      const next = Math.min(configured, rate / PENALTY_FACTOR);
      log("[budget] rate restored " + Math.round(rate) + " -> " + Math.round(next) + "/min after "
        + Math.round(RECOVER_AFTER_MS / MINUTE_MS) + " clean minutes"
        + (next < configured ? " (configured " + configured + ")" : ""));
      rate = next;
      lastPenaltyAt = t;   // the next step needs another clean hour
      stats.restores++;
    }
  }

  function schedule(ms) {
    if (timer) clearT(timer);
    timer = setT(function () { timer = null; pump(); }, Math.max(1, Math.ceil(ms)));
    // A pending pump must never hold the process open (shutdown, tests).
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function anyWaiting() {
    for (let li = 0; li < LANES.length; li++) if (waiting[LANES[li]].length) return true;
    return false;
  }

  // Grant waiters in lane order while tokens cover the head of the lane;
  // otherwise schedule the pump for when they will. One timer, re-armed,
  // and none at all when nobody is waiting.
  function pump() {
    const t = now();
    maybeRestore(t);
    refill(t);
    if (!anyWaiting()) { if (timer) { clearT(timer); timer = null; } return; }
    if (t < holdUntil) { schedule(holdUntil - t); return; }
    for (let li = 0; li < LANES.length; li++) {
      const q = waiting[LANES[li]];
      while (q.length) {
        const w = q[0];
        // A cost above the burst (a long candleSnapshot: 220 daily bars is 23
        // against a burst that could be configured at 20) is granted when the
        // bucket is FULL and the excess is taken as debt the refill repays -
        // waiting for more tokens than the bucket can hold would never end.
        const need = Math.min(w.cost, burst);
        if (tokens < need) { schedule((need - tokens) * MINUTE_MS / rate); return; }
        tokens -= w.cost;
        q.shift();
        const waited = t - w.since;
        stats.waits++; stats.waitMsTotal += waited;
        if (waited > stats.maxWaitMs) stats.maxWaitMs = waited;
        w.resolve();
      }
    }
  }

  // Blocking lane acquire: resolves when `cost` tokens have been deducted
  // for this request. Never rejects - a request that must not wait uses
  // take() instead.
  function acquire(cost, lane) {
    if (!waiting[lane]) throw new Error("unknown budget lane: " + lane);
    return new Promise(function (resolve) {
      waiting[lane].push({ cost: cost, resolve: resolve, since: now() });
      pump();
    });
  }

  // Non-blocking deduction for the mids poll: the request goes out either
  // way (its 4 s cadence is its retry; it must never sit in a queue). The
  // cost is ALWAYS deducted - the bucket goes negative when it cannot
  // cover it, a debt the refill repays before any lane is granted again.
  // Flooring at zero would let a saturated candle lane keep the bucket
  // empty and the polls effectively free, and the total would sit at the
  // exchange's window instead of under it (caught by the two-minute
  // saturation test). The return says whether the bucket covered it;
  // uncovered takes are informative in /health, not an error.
  function take(cost) {
    const t = now();
    refill(t);
    const covered = tokens >= cost;
    tokens -= cost;
    if (!covered) stats.midsUncovered++;
    return covered;
  }

  // A 429 from ANY kind: the window is exhausted for this clock minute.
  // Only a 429 OUTSIDE an active hold is a new exhaustion event that cuts
  // the rate: the mids poll keeps going out during a hold by design (its
  // refusals are expected until :00) and must not compound the penalty
  // fifteen times in one held minute.
  function penalize(kind) {
    const t = now();
    refill(t);
    tokens = 0;
    if (t < holdUntil) { stats.heldRefusals++; return; }
    const before = rate;
    rate = Math.max(MIN_RATE_PER_MIN, rate * PENALTY_FACTOR);
    lastPenaltyAt = t;
    // floor + 1, never ceil: a 429 stamped exactly on the minute must hold
    // through the NEXT window, not release 1.5 s into the exhausted one
    // (audit 2026-09-18 M1).
    holdUntil = (Math.floor(t / MINUTE_MS) + 1) * MINUTE_MS + HOLD_SLACK_MS;
    stats.holds++;
    log("[budget] 429 (" + kind + "): hold until " + new Date(holdUntil).toISOString().slice(11, 23) + "Z"
      + (rate !== before ? ", rate " + Math.round(before) + " -> " + Math.round(rate) + "/min" : ""));
    pump();
  }

  // Read-only view for /health: projects the refill to `t` without moving
  // the bucket's clock (a handler's injectable clock must not distort it).
  function snapshot(t) {
    t = t === undefined ? now() : t;
    const projected = Math.min(burst, tokens + Math.max(0, t - lastRefill) * rate / MINUTE_MS);
    return {
      ratePerMin: Math.round(rate),
      configuredRatePerMin: configured,
      burst: burst,
      tokens: Math.round(projected),
      waiting: { ctx: waiting.ctx.length, candle: waiting.candle.length },
      holdUntil: holdUntil > t ? new Date(holdUntil).toISOString() : null,
      lastPenaltyAt: lastPenaltyAt ? new Date(lastPenaltyAt).toISOString() : null,
      holds: stats.holds,
      heldRefusals: stats.heldRefusals,
      restores: stats.restores,
      waits: stats.waits,
      meanWaitMs: stats.waits ? Math.round(stats.waitMsTotal / stats.waits) : 0,
      maxWaitMs: Math.round(stats.maxWaitMs),
      midsUncovered: stats.midsUncovered
    };
  }

  function stop() { if (timer) { clearT(timer); timer = null; } }

  return { acquire: acquire, take: take, penalize: penalize, stats: snapshot, stop: stop, COST: COST };
}

module.exports = {
  createLedger: createLedger, createLimiter: createLimiter, kindOf: kindOf, costOf: costOf,
  barsRequested: barsRequested, INTERVAL_MS: INTERVAL_MS, ITEMS_PER_EXTRA_UNIT: ITEMS_PER_EXTRA_UNIT,
  MAX_BARS_PER_REQUEST: MAX_BARS_PER_REQUEST,
  KINDS: KINDS, COST: COST, BUCKET_MS: BUCKET_MS, MINUTE_MS: MINUTE_MS,
  DEFAULT_RATE_PER_MIN: DEFAULT_RATE_PER_MIN, DEFAULT_BURST: DEFAULT_BURST,
  MIN_RATE_PER_MIN: MIN_RATE_PER_MIN, HOLD_SLACK_MS: HOLD_SLACK_MS, RECOVER_AFTER_MS: RECOVER_AFTER_MS
};
