"use strict";

// HIP-3 data loop. Mirrors the proven dashboard cadences exactly
// (hip3_strat_screener.html):
//   - allMids poll every 4s (mid tape for the exact 5m/60m momentum,
//     monotonic forming-bar expansion of every FETCHED tf while now <= forming.T)
//   - per-TF refetch when now > forming.T + 4000, keyed off the forming
//     bar's actual end time (calendar-safe - no fixed-width clock math)
//   - forming bars union-merged on refetch (max h / min l when same t)
//   - forming bar synthesized from last close when none is returned
//   - with the candle feed on, the 30m/1h/4h/1d slots of a COVERED coin roll
//     LOCALLY from the 15m slot (stage 2):
//     the per-TF refetch above still runs once per boundary, as the RECONCILE
//     that confirms the period and wins when it lands, but the served bar no
//     longer waits for it
//   - 15m true-up every 5 min (also trues up forming volume for RVOL)
//   - metaAndAssetCtxs every 60s
//   - W/M derived from dailies via aggregateBars; native 1w/1M are
//     epoch-aligned (Thursday weeks / drifting months) and NEVER fetched.

const { analyzeTF, aggregateBars } = require("./strat_core.js");
const { REGISTRY } = require("./universes.js");
// servedScore: the exact readiness-gated score /api/state serializes
// (apistate.js requires no loop-side module, so this stays acyclic).
// The 30s sampler below MUST go through it - a lookalike recomputation
// is the recorder-fork class PR #3 repaired.
const { servedScore } = require("./apistate.js");
const scoreRing = require("./score_ring.js");
const budget = require("./budget.js");
const { createCandleFeed } = require("./candle_feed.js");

const API = "https://api.hyperliquid.xyz/info";

// A tracked universe: {id, dex}. The MAIN dex (perps) has dex === null and its
// info requests carry no dex field; the xyz builder dex carries dex:"xyz".
// Coin-name namespaces do not collide (bare vs "xyz:"-prefixed), so all tracked
// universes share one coin map and one merged mids map.
function infoBody(type, u) { return u.dex ? { type: type, dex: u.dex } : { type: type }; }

const TFS = [
  { id: "15m", ms: 900000,     label: "15m", bars: 40 },
  { id: "30m", ms: 1800000,    label: "30m" },
  // briefingBars is a separate seven-day reference tape. The score/STRAT
  // analysis still receives exactly bars:30 in setCandles.
  { id: "1h",  ms: 3600000,    label: "1H", bars: 30, briefingBars: 168 },
  { id: "4h",  ms: 14400000,   label: "4H" },
  { id: "1d",  ms: 86400000,   label: "D",  bars: 220 },
  { id: "1w",  ms: 604800000,  label: "W",  derived: "week" },
  { id: "1M",  ms: 2678400000, label: "M",  derived: "month" }
];
const BARS_BACK = 12;
// A 1d slot whose oldest closed bar starts less than this many days ago
// started inside its 220-day window: the coin's whole history is loaded
// (target rules v2, dailyCtx). Two days of margin, so a listing about as old
// as the window reads as incomplete (a fallback target) rather than a false
// all-time extreme.
const DAILY_COMPLETE_DAYS = TFS.find(function (t) { return t.id === "1d"; }).bars - 2;
// The feed's timeframe is the base fetched one (stage 1 of the feed
// migration). A test pins TFS[0].
const TF15 = TFS[0];
// The fetched timeframes ABOVE the base: rolled up locally from the 15m slot
// when the feed is on (stage 2). W/M stay derived from the daily.
const HIGHER = TFS.filter(function (t) { return !t.derived && t.id !== TF15.id; });
function zeroHigher() { const o = {}; for (let i = 0; i < HIGHER.length; i++) o[HIGHER[i].id] = 0; return o; }
// One REST 15m pass per coin per hour reconciles the feed-derived bars
// (config.feedReconcileMs / env FEED_RECONCILE_MS overrides).
const FEED_RECONCILE_MS = 3600000;
// The boot repair pass runs this long after the feed starts (the 286
// subscriptions are acknowledged in ~2 s; the delay is slack for acks).
const FEED_BOOT_PASS_MS = 60000;

function splitClosedBars(tf, closed) {
  if (!tf.briefingBars) return { analysis: closed, reference: null };
  return {
    analysis: closed.slice(-(tf.bars || BARS_BACK)),
    reference: closed
  };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Concurrency-limited queue for candle fetches (dashboard-proven width 6),
// ordered by (batch, rank). A BATCH is one enqueue wave - the bar-roll
// timer tick that found several timeframes rolled at once, one true-up,
// the boot load - and batches run first-come-first-served. WITHIN a batch
// jobs dispatch by rank (the fetched-timeframe order 15m, 30m, 1h, 4h,
// 1d), FIFO within a rank, so a stacked roll runs one timeframe after
// another (A2). The batch dimension is the 2026-09-19 correction: with
// rank alone, every later 15m sweep (each quarter hour) and 30m sweep
// jumped ahead of the 00:00 UTC stack's queued daily work, and the daily
// sweep - the layer the D/W/M signals and alert rules run on - was still
// unfinished 52 minutes after the roll (7.5 minutes before A1/A2). Now the
// stack finishes in ~21 minutes and only the one 15m boundary it spans
// waits behind it. A later batch NEVER pre-empts an earlier one. Batch ids
// are opaque and matched by equality: a job naming an id that is still
// queued JOINS that batch at its rank; an id that has drained with later
// batches queued behind it starts a fresh batch at the tail (FIFO by
// dispatch time). The bar-roll timer keys its batches by 15-minute PERIOD,
// not by tick - see rollBatchKey.
function makeQueue(limit) {
  // insertion order: {id, lanes: rank -> [{job,res,rej}], size (queued), inflight (dispatched, unresolved)}
  const batches = [];
  let active = 0, size = 0, seq = 0;
  function next() {
    if (active >= limit || size === 0) return;
    // A batch leaves the array only when it is fully DRAINED (nothing
    // queued, nothing in flight): a small wave whose jobs all dispatched at
    // once must stay joinable until they resolve (review 2026-09-20 MED),
    // so dispatch skips an in-flight-only batch instead of evicting it.
    while (batches.length && batches[0].size === 0 && batches[0].inflight === 0) batches.shift();
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      if (b.size === 0) continue;
      for (let r = 0; r < b.lanes.length; r++) {
        const q = b.lanes[r];
        if (!q || !q.length) continue;
        const item = q.shift();
        b.size--; size--; b.inflight++;
        active++;
        item.job().then(item.res, item.rej).finally(function () { active--; b.inflight--; next(); });
        return;
      }
    }
  }
  function enqueue(job, rank, batch) {
    rank = rank > 0 ? Math.floor(rank) : 0;
    batch = batch === undefined ? 0 : batch;
    return new Promise(function (res, rej) {
      let b = null;
      for (let i = batches.length - 1; i >= 0; i--) {
        if (batches[i].id !== batch) continue;
        // A live batch (queued or in-flight work) is joined at its position;
        // a DRAINED id with later batches queued behind it does not revive
        // its old position ahead of them - it starts again at the tail.
        if (batches[i].size > 0 || batches[i].inflight > 0 || i === batches.length - 1) b = batches[i];
        break;
      }
      if (!b) { b = { id: batch, lanes: [], size: 0, inflight: 0 }; batches.push(b); }
      (b.lanes[rank] = b.lanes[rank] || []).push({ job: job, res: res, rej: rej });
      b.size++; size++;
      next();
    });
  }
  // A fresh batch id for one enqueue wave; callers pass it to every job of
  // the wave so the wave keeps its rank order behind earlier waves.
  enqueue.newBatch = function () { return ++seq; };
  // Jobs queued and not yet dispatched (the true-up yields on this).
  enqueue.pending = function () { return size; };
  return enqueue;
}

// The 5-min volume true-up yields when this many candle fetches are still
// queued: a true-up enqueued behind a 1,400-fetch stack would hold the 15m
// refetching flag for ~20 minutes and delay the next boundary sweep; the
// next true-up is five minutes away and costs nothing to skip.
const TRUEUP_YIELD_PENDING = 200;

// Batch key of a bar-roll sweep: the 15-minute period the timer tick falls
// in (the base fetched timeframe's span; every fetched timeframe rolls on a
// multiple of it). Keying by PERIOD instead of by tick is the 2026-09-20
// correction to batch-FIFO, measured on boot ad38f88f: at every 04/08/12/
// 16/20:00 stack the 4h dispatched alone at the first tick while the 15m,
// 30m and 1h flags were still held by the 5-min true-up (fires ~:59:25,
// done ~:00:29) or a stale-slot mini-sweep, so those sweeps dispatched
// 25-30 s later as LATER batches and ran behind the whole 4h (15m done
// +8.4 min instead of ~4.5, 1h +17 min); at 00:00 the 15m ran behind the
// 1d (+21.7 min). With one batch per period a sweep that dispatches a few
// ticks late joins its stack at its rank, and the A2 order (15m, 30m, 1h,
// 4h, 1d) holds however the flags fell at the tick. A sweep in the NEXT
// period (the 00:15 15m) is still a later batch and still waits.
const ROLL_BATCH_MS = TFS[0].ms;
function rollBatchKey(now) { return "roll:" + Math.floor(now / ROLL_BATCH_MS); }

// Queue rank of a timeframe: its position among the FETCHED timeframes.
function tfRank(tf) {
  let r = 0;
  for (let i = 0; i < TFS.length; i++) {
    if (TFS[i].derived) continue;
    if (TFS[i].id === tf.id) return r;
    r++;
  }
  return r;
}

// Does this coin carry a live (in-force) signal on any timeframe? Sweep
// order puts these first: they are the rows consumers are watching and the
// alerts the rule engine is tracking, so their rolled bar lands first (A2).
function hasLiveSignal(coin) {
  if (!coin || !coin.tf) return false;
  for (const id in coin.tf) {
    const an = coin.tf[id] && coin.tf[id].an;
    if (an && an.live && an.live.length) return true;
  }
  return false;
}

function createLoop(config, hooks) {
  hooks = hooks || {};
  const log = hooks.log || function () {};
  const onTick = hooks.onTick || function () {};
  // Called with the names the roster reconciliation REMOVED, so the rule
  // engine can drop their dedup/baseline state (a re-listed name must
  // baseline fresh, never inherit a months-old verdict - the SPCX
  // ticker-reuse class).
  const onRemove = hooks.onRemove || function () {};
  // Tracked universes (default: xyz only -> pre-multi-universe behavior).
  const universes = (hooks.universes && hooks.universes.length) ? hooks.universes : [REGISTRY.xyz];
  // Universes whose forming 15m volume is TRUED UP intra-period by the 5-min
  // true-up timer (demand cut, design decision 2026-08-17). At 271 coins the
  // ALL-COINS true-up cost ~5,420 rate-limit weight per burst against the
  // venue's 1,200/min per-IP budget - the largest single line item of the
  // measured ~155% over-budget demand behind the mids stalls. Universes
  // outside this list still refetch at every bar roll (analysis correctness
  // is untouched), but their forming volume freezes at the roll-time sample,
  // so apistate serves their rvol as null rather than a pace-adjusted number
  // that decays to zero across the bar (an honest unknown over a
  // misleading value). NOT SUPPLIED (null/undefined) -> ALL tracked
  // universes, the legacy behavior (unit tests, single-universe callers).
  // SUPPLIED EMPTY ([]) -> NO true-up universes: an empty broadcast alert
  // scope must not silently expand into all-tracked true-up demand - with
  // favorites-only perps alerting that expansion re-creates the exact
  // all-perps candle burst the demand cut removed.
  const trueUpUniverses = Array.isArray(hooks.trueUpUniverses)
    ? hooks.trueUpUniverses.slice() : null;

  const state = {
    coins: {},   // name -> {name, sym, uni, ctx, mid, hist[], tf:{tfId:{closed[], forming, an, fetchedAt}}}
    order: [],
    universes: universes.map(function (u) { return u.id; }),  // tracked ids, for /api/state + /health
    // Which universes get the intra-period volume true-up (see above).
    // Resolved to the full tracked list when UNSUPPLIED, so consumers
    // (apistate rvol nulling, rules rvol gating, /health) read ONE shape
    // either way; a supplied [] stays [] (nothing trued up).
    trueUpUniverses: (trueUpUniverses !== null ? trueUpUniverses : universes.map(function (u) { return u.id; })),
    lastMids: 0,
    lastMidsByUni: {},
    lastCandles: 0,     // last SUCCESSFUL candle fetch (never bumped by failures)
    lastCandlesByUni: {},
    lastContexts: 0,    // last successful metaAndAssetCtxs load/refresh
    lastContextsByUni: {},
    // Latest allowed, non-delisted roster advertised by each universe's
    // successful metadata response. Briefing completeness compares its rows
    // against this list without changing the scanner's symbol selection.
    expectedMarketsByUni: {},
    candleFailures: 0,  // cumulative failed candle fetches (surfaces in /health)
    midsFailures: 0,    // cumulative failed allMids fetches (surfaces in /health;
                        // a starving tape must not look identical to a healthy one)
    // Monotonic SNAPSHOT REVISION: bumped on every state mutation (candle
    // write, mids tick, ctx/roster change, score-ring sample). Serves two consumers: the
    // /api/state serialization cache keys on it (rebuild only when the data
    // actually moved), and a hosted renderer can skip re-render work when
    // the revision it last drew is still current. Process-local, resets to
    // 0 on restart - consumers must treat it as an opaque change detector,
    // never as a cross-restart sequence.
    revision: 0,
    // Served-score ring (Deploy 1 item 3): name -> [{t, score, rank}],
    // written by the 30s sampler below, read by apistate's per-coin
    // scoreDelta. Memory only - a restart clears it, and that is the
    // design (null delta windows after a boot are honest, not a gap).
    scoreRing: {},
    // WebSocket candle feed counters (null-served when the flag is off; the
    // object exists so tests and /health read one shape). reconcile is the
    // stage-1 parity gate: bars the FEED closed, compared field by field
    // against the hourly REST pass before REST replaces them.
    feed: {
      pushes: 0, pushRolls: 0, localRolls: 0, synthesized: 0, ignored: 0, late: 0,
      // Stage 2: higher-timeframe periods closed LOCALLY from 15m children,
      // per timeframe; and the comparator that checks every locally rolled
      // closed bar against REST's bar for the same period when the
      // reconcile sweep lands (the stage-2 parity gate, o/h/l/c/v strict).
      rollups: zeroHigher(),
      rollupReconcile: { barsCompared: 0, mismatches: 0, mismatchesOhlc: 0, mismatchesVolume: 0, unverified: 0, reconfirms: 0, lastMismatch: null },
      reconcile: { passes: 0, coins: 0, barsCompared: 0, mismatches: 0, mismatchesOhlc: 0, mismatchesVolume: 0,
                   lastMismatch: null, lastPassAt: null, lastPass: null, inFlight: false }
    },
    loaded: false
  };
  const timers = [];
  let stopped = false;

  const enqueue = makeQueue(6);

  // Request ledger: every attempt and outcome on the exchange endpoint, by
  // kind, with a per-minute log line (budget.js). Injectable so tests can
  // read what the loop recorded; /health serves ledger.stats().
  const ledger = hooks.ledger || budget.createLedger({ log: log });
  // Request budget (A1): every candle/ctx request acquires its weight from
  // the token bucket before it is sent (retries included), in its lane;
  // the mids poll deducts without waiting. Injectable for tests;
  // config.budgetPerMin (env BUDGET_PER_MIN) overrides the measured default.
  const limiter = hooks.limiter || budget.createLimiter({
    ratePerMin: config && config.budgetPerMin, log: log
  });

  // Retry/backoff mirrors the dashboard: network errors and HTTP 5xx
  // 1000ms*2^n up to 3 tries; HTTP 429 800ms*2^n up to 5 tries. Every
  // attempt, retries included, first acquires its budget in its lane: the
  // kind's base unit plus candleSnapshot's size component (budget.costOf).
  // onSend (optional) runs as each attempt goes out, after its budget wait.
  async function post(body, tries, onSend) {
    tries = tries || 0;
    const kind = budget.kindOf(body);
    let r;
    await limiter.acquire(budget.costOf(body), kind === "ctx" ? "ctx" : "candle");
    ledger.attempt(kind);
    if (onSend) onSend();
    try {
      r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
    } catch (e) {
      ledger.outcome(kind, "net");
      if (tries < 3) { await sleep(1000 * Math.pow(2, tries)); return post(body, tries + 1, onSend); }
      throw e;
    }
    ledger.outcome(kind, r.ok ? "ok" : (r.status === 429 ? "429" : "http"));
    if (r.status === 429) limiter.penalize(kind);
    if (r.status === 429 && tries < 5) { await sleep(800 * Math.pow(2, tries)); return post(body, tries + 1, onSend); }
    if (r.status >= 500 && tries < 3) { await sleep(1000 * Math.pow(2, tries)); return post(body, tries + 1, onSend); }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // Mids-tape fetch: EXEMPT from the retry ladder above (P0-6, measured live
  // 2026-08-17). The 4s poll cadence IS the retry mechanism - a ladder inside
  // one poll converts a transient 429 window into a guaranteed staleness
  // window, because midsBusy (correctly) holds the next poll while this one
  // sleeps through backoff. Measured: the 5-min all-coins 15m true-up costs
  // ~271 x 20 = ~5,420 weight against the venue's 1,200/min per-IP budget, so
  // every true-up opens a ~30s 429 window; the ladder stretched that into a
  // 31-52s mids gap, crossing metrics.MID_STALE_MS (30s) and blanking
  // r5/r15/r30 - the momentum "-" flicker - and delaying rule evaluation
  // (onTick rides the successful poll). allMids itself is weight 2, nearly
  // free: fail fast on one attempt with a short timeout, count the failure,
  // and let the next 4s tick take the shot. A delayed retry delivers a STALE
  // tape sample SLOWER than simply waiting for the next poll.
  async function postMids(body) {
    // Deduct, never wait (A1 priority lane): the poll goes out on its tick.
    limiter.take(budget.costOf(body));
    ledger.attempt("mids");
    let r;
    try {
      r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000)
      });
    } catch (e) {
      ledger.outcome("mids", "net");
      throw e;
    }
    ledger.outcome("mids", r.ok ? "ok" : (r.status === 429 ? "429" : "http"));
    // A refused mids poll is the canary: the window is exhausted, so the
    // candle lanes hold until the next :00 instead of feeding the refusal.
    if (r.status === 429) limiter.penalize("mids");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function allowed(name, sym) {
    const coins = (config && config.coins) || {};
    const allow = Array.isArray(coins.allow) ? coins.allow : [];
    const block = Array.isArray(coins.block) ? coins.block : [];
    if (allow.length && allow.indexOf(sym) < 0 && allow.indexOf(name) < 0) return false;
    if (block.indexOf(sym) >= 0 || block.indexOf(name) >= 0) return false;
    return true;
  }

  // Per-asset max leverage off the metaAndAssetCtxs META entry (d[0].universe),
  // NOT the asset context (d[1]) - the two arrays are parallel but carry
  // different things, and every other field we keep comes from the ctx side.
  //
  // NOT `Number.isFinite(Number(v))` alone: Number(null) and Number("") are
  // both 0, so a missing value would arrive as a real, usable-looking leverage
  // of zero and a "max leverage >= 10x" filter would silently exclude the coin
  // on fabricated evidence rather than on an honest unknown. Zero and negative
  // are not real venue values, so both collapse to null = unknown.
  // Global isFinite() is avoided deliberately (it coerces; see the sigInForce
  // fix in DISPLAY-CORE, code review 2026-08-07).
  function maxLev(metaEntry) {
    const v = Number(metaEntry && metaEntry.maxLeverage);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  function expectedMarketNames(universe) {
    const names = [];
    for (let i = 0; i < universe.length; i++) {
      const item = universe[i];
      if (item.isDelisted) continue;
      const name = item.name;
      const sym = name.split(":")[1] || name;
      if (allowed(name, sym)) names.push(name);
    }
    return names;
  }

  // Enumerate every tracked universe into the shared coin map. Each universe's
  // metaAndAssetCtxs is fetched independently: one universe failing to enumerate
  // does not sink the others (the loop still runs on whatever loaded). Throws
  // only if NO coins loaded at all, so start()'s retry logic is preserved for a
  // total boot failure (identical to the single-universe path). A universe
  // that fails here is NOT lost: refreshCtxs registers its coins on the next
  // 60s cycle (see the roster-recovery note there).
  async function loadUniverse() {
    state.order = [];
    for (let ui = 0; ui < universes.length; ui++) {
      const uv = universes[ui];
      let d;
      try {
        d = await post(infoBody("metaAndAssetCtxs", uv));
      } catch (e) {
        log("universe load failed (" + uv.id + "): " + (e && e.message));
        continue;
      }
      const universe = d[0].universe, ctxs = d[1];
      state.expectedMarketsByUni[uv.id] = expectedMarketNames(universe);
      let delisted = 0, added = 0;
      for (let i = 0; i < universe.length; i++) {
        const u = universe[i];
        if (u.isDelisted) { delisted++; continue; }
        const name = u.name;
        const sym = name.split(":")[1] || name;   // bare names (main dex) have no ":" -> sym === name
        if (!allowed(name, sym)) continue;
        if (!state.coins[name]) {
          state.coins[name] = { name: name, sym: sym, uni: uv.id, ctx: null, mid: null, tf: {}, hist: [] };
        }
        state.coins[name].uni = uv.id;
        state.coins[name].ctx = ctxs[i];
        state.coins[name].maxLeverage = maxLev(u);
        state.coins[name].mid = parseFloat(ctxs[i].midPx || ctxs[i].markPx || "0") || null;
        state.order.push(name);
        added++;
      }
      state.lastContextsByUni[uv.id] = Date.now();
      log("universe " + uv.id + ": " + added + " coins (" + delisted + " delisted filtered)");
    }
    if (!state.order.length) throw new Error("no coins loaded from any tracked universe");
    state.lastContexts = Date.now();
  }

  // Overlap guard, mirroring midsBusy on the 4s mids poll and tf.refetching on
  // both refetch paths - the ctx cycle was the only interval without one. A
  // single cycle can outlive its 60s interval: post()'s network-error path is
  // 4 attempts x a 15s AbortSignal timeout plus 1s/2s/4s backoff = 67s per
  // call, and the universes are awaited SEQUENTIALLY. Overlap cannot
  // double-register a coin (the state.coins check and the state.order.push
  // share one synchronous block with no await between them), but the OLDER
  // response completes LAST and therefore WINS: it overwrites ctx with stale
  // prices, rolls expectedMarketsByUni back to a roster the exchange has moved
  // past, registers coins that roster has since dropped - and outside boot
  // state.order is only ever appended to, so such a coin persists until
  // restart - and stamps lastContextsByUni with the later clock time, marking
  // the stale data freshest. Skipping a cycle is the safe failure: the next
  // one is 60s away and the data it would have written was already stale
  // (code review 2026-08-07).
  let ctxBusy = false;
  async function refreshCtxs() {
    if (ctxBusy) { log("ctx refresh skipped (previous cycle still in flight)"); return; }
    ctxBusy = true;
    try { await refreshCtxsOnce(); }
    finally { ctxBusy = false; }
  }

  // The 60s ctx refresh doubles as ROSTER RECOVERY: any allowed, non-delisted
  // coin the roster advertises that is not yet tracked gets REGISTERED here,
  // not just updated. Two failure modes this closes (both seen or measured
  // live): (1) a universe whose boot-time enumeration 429'd was previously
  // lost until a manual restart - with alerting configured for that universe,
  // one rate-limited request at boot silenced every alert (2026-08-07
  // incident); (2) new listings only appeared at the next redeploy. Candles
  // for a just-registered coin arrive via the bar-roll stale-slot recovery
  // timer, which refetches missing tf slots within seconds; mids join on the
  // next 4s poll. Existing coins are untouched except ctx, as before. A
  // just-registered coin is deliberately not FTFC-alertable until every
  // configured timeframe has analysis (rules.js ftfcEvaluable).
  async function refreshCtxsOnce() {
    let anyOk = false;
    for (let ui = 0; ui < universes.length; ui++) {
      const uv = universes[ui];
      try {
        const d = await post(infoBody("metaAndAssetCtxs", uv));
        const universe = d[0].universe, ctxs = d[1];
        state.expectedMarketsByUni[uv.id] = expectedMarketNames(universe);
        let registered = 0;
        for (let i = 0; i < universe.length; i++) {
          const u = universe[i];
          let c = state.coins[u.name];
          if (!c) {
            if (u.isDelisted) continue;
            const sym = u.name.split(":")[1] || u.name;
            if (!allowed(u.name, sym)) continue;
            c = state.coins[u.name] = {
              name: u.name, sym: sym, uni: uv.id, ctx: null,
              mid: parseFloat(ctxs[i].midPx || ctxs[i].markPx || "0") || null,
              tf: {}, hist: []
            };
            state.order.push(u.name);
            registered++;
          }
          c.ctx = ctxs[i];
          // Deliberately OUTSIDE the registration branch above, beside the ctx
          // assignment: maxLeverage is a mutable venue property, not a fixed
          // attribute of the listing. Setting it only at registration would
          // freeze it at whatever the asset carried when the coin was first
          // seen and it would never correct - a stale number that still looks
          // entirely plausible, which is the failure mode this file has
          // already been bitten by twice.
          c.maxLeverage = maxLev(u);
        }
        if (registered) {
          log("universe " + uv.id + ": registered " + registered
            + " coins on ctx refresh (boot-miss recovery or new listing)");
        }
        // ROSTER REMOVAL (code review 2026-08-14):
        // a coin this universe no longer advertises (delisted flag, dropped
        // row, or config-blocked) is REMOVED, not retained. Before this,
        // state.order was append-only outside boot, so the first real
        // delisting would strand a frozen row in /api/state and flip the
        // briefing to data_complete:false PERMANENTLY - expectedMarketsByUni
        // drops the coin on the very next cycle while rows keep serving it
        // (briefing.js expected_row_count_mismatch), until a restart.
        // FAIL-CLOSED GUARD: an EMPTY universe ARRAY for a universe that
        // currently tracks coins reads as an API anomaly, not a mass delist -
        // skip removal this cycle and let the next one decide. The guard is
        // on the RAW response, not the allowed/expected set: a response that
        // still lists a market while flagging isDelisted is affirmative
        // delist evidence and must remove it, even when that empties the
        // allowed set. Removal only ever runs on a SUCCESSFUL response (we
        // are inside the try).
        const advertised = new Set(state.expectedMarketsByUni[uv.id]);
        const removed = [];
        if (universe.length) {
          for (const name of Object.keys(state.coins)) {
            const c = state.coins[name];
            if (c.uni === uv.id && !advertised.has(name)) {
              delete state.coins[name];
              removed.push(name);
            }
          }
        } else if (state.order.some(function (n) {
          return state.coins[n] && state.coins[n].uni === uv.id;
        })) {
          log("universe " + uv.id + ": universe response came back EMPTY - skipping removal this cycle");
        }
        if (removed.length) {
          const gone = new Set(removed);
          state.order = state.order.filter(function (n) { return !gone.has(n); });
          log("universe " + uv.id + ": removed " + removed.length
            + " coins no longer advertised (" + removed.join(",") + ")");
          try { onRemove(removed); }
          catch (e) { log("onRemove hook failed: " + (e && e.message)); }
        }
        anyOk = true;
        state.lastContextsByUni[uv.id] = Date.now();
        state.revision++;
      } catch (e) {
        log("ctx refresh failed (" + uv.id + "): " + (e && e.message));
      }
    }
    if (anyOk) state.lastContexts = Date.now();
    if (feed && anyOk) feed.setCoins(state.order.slice());   // idempotent: subscribes new listings, drops removals
  }

  async function fetchCandles(name, tf) {
    const now = Date.now();
    // Stamped as the request goes OUT (the last attempt's), not as it was
    // queued: the budget wait before it can span a 15m boundary.
    let at = now, f15At = null;
    const raw = await post({
      type: "candleSnapshot",
      req: { coin: name, interval: tf.id,
             startTime: now - (tf.briefingBars || tf.bars || BARS_BACK) * tf.ms, endTime: now }
    }, 0, function () {
      at = Date.now();
      // The live 15m child as the feed has it at the send, for the stage-2
      // seed's volume (audit M2: the install-time value can be later than REST's).
      const coin = state.coins[name];
      const s15 = coin && coin.tf[TF15.id];
      f15At = (s15 && s15.forming) ? { t: s15.forming.t, v: s15.forming.v } : null;
    });
    const cs = (raw || []).map(function (c) {
      return { t: c.t, T: c.T, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v };
    });
    let forming = null;
    if (cs.length && cs[cs.length - 1].T > now) forming = cs.pop();
    // `at`: when the request was SENT. REST's bars reflect trades up to that
    // instant, which is what the stage-2 seed and the repair race are judged
    // by (review 2026-10-25 F2/F3/F5) - not the install time.
    return { closed: cs, forming: forming, at: at, f15At: f15At };
  }

  function setCandles(name, tf, data) {
    const coin = state.coins[name];
    const cur = coin.tf[tf.id];
    const now = Date.now();
    const at = typeof data.at === "number" ? data.at : now;   // request time (fetchCandles); tests may omit it
    // The exchange's own forming bar, BEFORE the mids union below: with the
    // feed on it is the 15m slot's feedBar (the bar that closes the period
    // if no push follows - design section 2).
    const rawForming = (feed && data.forming) ? Object.assign({}, data.forming) : null;
    const higherFeed = !!feed && !tf.derived && tf.id !== TF15.id;
    // Merge mid-expanded forming bar with the authoritative exchange candle
    // (union: max h / min l - stays monotonic even if mids ran ahead of
    // printed trades). c and v are REST's as of its fetch: with the feed on,
    // a push that landed during the round trip can be a few hundred ms
    // newer, so c/v may step back once and the next push restores them
    // (review 2026-09-22 LOW: a known "REST wins" side effect, h/l are
    // monotonic throughout).
    if (data.forming && cur && cur.forming && cur.forming.t === data.forming.t) {
      data.forming.h = Math.max(data.forming.h, cur.forming.h);
      data.forming.l = Math.min(data.forming.l, cur.forming.l);
    }
    // No forming candle returned (no trades yet this period) -> synthesize
    // from the last close.
    if (!data.forming && data.closed.length) {
      const last = data.closed[data.closed.length - 1];
      if (now > last.T) {
        data.forming = { t: last.T + 1, T: last.T + tf.ms, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 };
      }
    }
    // Stage 2 (higher slot of a coin the feed has been rolling): compare what
    // REST brought against the locally rolled closed bars first, then merge.
    // REST wins wherever it HAS a bar. REST can also be BEHIND the local view
    // - a thin market whose trade-less periods the exchange has not
    // materialized yet returns no bar for the current period and the
    // synthesized forming lands one or more periods back (today's
    // "stale-slot retry" class) - and then the local tail and the local
    // forming stay, with restT left on REST's period so the sweep retries
    // in 30 s exactly as it does today for such markets.
    let keepLocal = false, localTail = null;
    if (higherFeed && cur && cur.agg && cur.forming) {
      reconcileRollup(name, tf, cur, data.closed);
      if (!data.forming || data.forming.t < cur.forming.t) {
        // (no forming at all = REST returned nothing: the local slot stays whole, unconfirmed)
        const lastRestT = data.closed.length ? data.closed[data.closed.length - 1].t : -Infinity;
        // The fullest local history: the 1h reference tape outlives its analysis slice (review F7).
        const localHist = cur.referenceClosed || cur.closed;
        localTail = localHist.filter(function (b) { return b.t > lastRestT; });
        data.closed = data.closed.concat(localTail);
        keepLocal = true;
      }
    }
    const retained = splitClosedBars(tf, data.closed);
    // Depth after a merge (review F7): splitClosedBars trims only the briefing
    // timeframe's analysis slice, because REST returns exactly the requested
    // span; a local tail appended above can exceed it.
    const depth = tf.bars || BARS_BACK;
    if (retained.analysis.length > depth) retained.analysis = retained.analysis.slice(-depth);
    if (retained.reference && tf.briefingBars && retained.reference.length > tf.briefingBars) retained.reference = retained.reference.slice(-tf.briefingBars);
    const slot = {
      closed: retained.analysis,
      forming: keepLocal ? cur.forming : data.forming,
      an: null,
      fetchedAt: now
    };
    if (retained.reference) slot.referenceClosed = retained.reference;
    if (feed && tf.id === TF15.id) {
      slot.feedBar = rawForming;   // null when the exchange returned no forming bar (no trades yet)
      slot.feedFrom = null;        // REST just replaced every closed bar: nothing feed-derived to compare
      // The feed still maintains this period: keep the live mark, so a
      // higher reseed landing before the next push is not approximate for
      // nothing (second review, 4).
      if (cur && cur.feedAt !== undefined && cur.forming && data.forming && cur.forming.t === data.forming.t) slot.feedAt = cur.feedAt;
    }
    if (higherFeed) {
      // restT: the period REST confirmed. While the served forming period is
      // newer than it (rolled locally), the bar-roll sweep still runs - as the
      // reconcile. agg: the fold of the current period's 15m children so far,
      // seeded from REST's own aggregate (trades only, before the mids union
      // above); localFrom: where locally rolled closed bars begin (comparator
      // range), null once REST has replaced them all.
      // A response SENT before a repair demanded a fresh confirmation cannot
      // provide it (review F2): restT stays null and the next tick sweeps again.
      const stale = !!(cur && cur.reconfirmAt && at < cur.reconfirmAt);
      slot.restT = (data.forming && !stale) ? data.forming.t : null;
      slot.reconfirmAt = stale ? cur.reconfirmAt : null;
      if (keepLocal) {
        slot.agg = cur.agg;
        const tailT = new Set(localTail.map(function (b) { return b.t; }));
        const firstLocal = slot.closed.find(function (b) { return tailT.has(b.t); });
        const oldest = slot.closed.length ? slot.closed[0].t : Infinity;
        slot.localFrom = firstLocal ? firstLocal.t : null;
        slot.unverified = (cur.unverified || []).filter(function (t) { return tailT.has(t) && t >= oldest; });
      } else {
        slot.agg = data.forming ? aggFromRest(rawForming || data.forming, at, coin.tf[TF15.id], feed.covers(name), data.f15At) : null;
        slot.localFrom = null;
        slot.unverified = [];
      }
    }
    coin.tf[tf.id] = slot;
    state.lastCandles = now; // only reached on a SUCCESSFUL fetch
    if (coin.uni) state.lastCandlesByUni[coin.uni] = now;
    state.revision++;
    reanalyze(name, tf.id);
    if (tf.id === "1d") rebuildDerived(name);
    if (tf.id === "1d" || tf.id === "1h") reanalyzeOthers(name, tf.id);
    // A REST pass that ADVANCED a covered coin's 15m slot into a new period
    // (the hourly reconcile landing seconds before the boundary tick) must
    // roll the higher slots too - the tick then sees a current 15m slot and
    // skips the local roll (review F6); and a higher slot just seeded from a
    // snapshot older than the 15m children already closed must fold them
    // now (review F3). Covered coins only: the REST path of the others is
    // unchanged.
    if (feed && !tf.derived && feed.covers(name)) rollupHigher(name, coin, now);
  }

  // ---- Stage 2: local rollup of the higher timeframes -------------------
  // For a coin the feed covers,
  // each 30m/1h/4h/1d slot keeps an ACCUMULATOR (agg) of the current period's
  // CLOSED 15m children under the rule measured on 2026-09-19
  // (zero mismatches on the full roster): a synthetic child (no trades, v 0)
  // never sets the open or the range; the first TRADED child does; a period
  // whose children are all synthetic closes as REST's synthetic bar. The
  // served forming bar is agg UNION the live 15m forming bar (its trades and
  // its mids expansion) UNION the previous forming of the same period (so the
  // 4 s mids tick's expansion persists) - the union-with-mids rule,
  // unchanged. When the 15m slot moves into a new higher period - at the
  // first trade or at the local roll 4 s past the boundary - the accumulator
  // becomes the closed bar and a new period opens AT ONCE; REST's boundary
  // sweep then confirms it minutes later (restT) and wins.
  //
  // Price (o/h/l/c) is REST's: its aggregate of the period so far is the
  // authority on what traded before the feed's children. VOLUME is the
  // feed's: when the 15m slot is live on the child in progress (C) and its
  // buffer reaches back to the period start, the seed's v is the sum of the
  // period's CLOSED children in the buffer - exactly what the fold would
  // have produced - and C folds at its close (lastT = the child before it).
  // "Live" means the FEED maintains the 15m slot right now: the coin is
  // covered and the slot was touched by a push or a local roll inside the
  // current period (feedAt). The period numbers lining up is not enough:
  // at boot the slots load minutes apart and the feed connects after the
  // load, so a 15m slot can sit on the right period as a minutes-old REST
  // snapshot - its forming v is stale (netting it folded REST's partial
  // child again: 30m volumes 40-75% over, measured 2026-10-25) and the
  // child it closes at the feed's first push is PARTIAL (the stage-1 "boot
  // passes are repairs" class: 253 of 295 first bars after a local boot
  // mismatched REST on price). REST's own v is also used when the period
  // started before the buffer (a slot seeded hours into its period).
  // Then C's VOLUME counts as covered (skipV = C: its price still folds at
  // its close, its v is not added again; the tail of its volume is lost
  // until the next reconcile) and the seed is APPROXIMATE: the bar it
  // closes is recorded as unverified and is NOT a parity sample - REST
  // replaces it at the next reconcile regardless.
  // Volume comparisons: o/h/l/c are copied values and compare strictly; v is
  // a SUM of children and carries float representation error (measured
  // 2026-10-25: 52 of 350 steady-state bars differed only like
  // 346.64599999999996 vs 346.646), so it compares within a parity
  // tolerance (1e-9 relative). A buffer whose
  // sum falls short of REST's closed part by more than ROLLUP_V_GAP_TOL is
  // not trusted (review F4): a child the feed synthesized across a socket
  // gap reads v 0 while REST holds its trades; a push the feed has not
  // coalesced yet, or F8 tail loss, is a small fraction of a period.
  const ROLLUP_V_REL_TOL = 1e-9;
  const ROLLUP_V_GAP_TOL = 0.01;
  function volumeEqual(a, b) { return Math.abs(a - b) <= ROLLUP_V_REL_TOL * Math.max(1, Math.abs(a), Math.abs(b)); }
  // `at` is the REQUEST time: REST's snapshot holds trades up to it, so the
  // 15m child in progress THEN (C) is the one it partially covers (review
  // F3/F5) - a response landing after a boundary does not shift coverage.
  // `snap`: the live 15m child as the feed had it when the request was SENT
  // ({t, v}, fetchCandles), absent for a reseed from the served bar.
  function aggFromRest(rawF, at, s15, covered, snap) {
    const C = Math.floor(at / TF15.ms) * TF15.ms;         // the 15m child in progress when REST took the snapshot
    const P = rawF.t;
    // The 15m slot may sit one child behind the clock for up to the roll
    // grace (a request just after a boundary, before the tick or the first
    // push rolled the slot): the feed is still live on it, and its child L
    // is the one the fold must resume after (second review 2026-10-26, 1).
    // The slot's child is judged AT THE SEND when it rolled during the round
    // trip (sent one child behind, the next child's first push landing before
    // the install): REST's snapshot is the one-behind case, and judging it by
    // the install-time child counted that child's pre-send trades twice
    // (fold review 2026-10-29, LOW-1).
    const fNow = (s15 && s15.forming) ? s15.forming.t : null;
    const f15t = (fNow !== null && snap && snap.t < fNow) ? snap.t : fNow;
    const live15 = !!(covered && f15t !== null && (f15t === C || f15t === C - TF15.ms)
                      && s15.feedAt !== undefined && s15.feedAt !== null && s15.feedAt >= f15t);
    const L = live15 ? f15t : C;
    // L's volume AS OF THE SNAPSHOT: the feed's at the request (audit M2,
    // 2026-10-27). The install-time value can have grown past what REST saw,
    // and netting that clamped REST's closed part to zero, so a buffer
    // missing a whole closed child passed the trust check. Without a
    // request-time view (a reseed), the install-time value, as before.
    const vLive = !live15 ? 0 : (snap && snap.t === L) ? snap.v : s15.forming.v;
    // L's whole feed volume now: the forming bar's, or its closed bar's once
    // the slot moved past it.
    let vLnow = 0;
    if (live15) {
      if (fNow === L) vLnow = s15.forming.v;
      else { const lb = (s15.closed || []).find(function (b) { return b.t === L; }); vLnow = lb ? lb.v : 0; }
    }
    let v = rawF.v, approx = true, skipV = null, cFrom = 0;
    if (live15) {
      const closed15 = s15.closed || [];
      if (P >= L || (closed15.length && closed15[0].t <= P)) {
        let sum = 0;
        for (let i = closed15.length - 1; i >= 0 && closed15[i].t >= P; i--) if (closed15[i].t < L) sum += closed15[i].v;
        // REST's closed part (an upper bound WHILE REST IS CURRENT: the
        // feed's view of the live child at the request trails REST's by the
        // round trip, so the check errs toward approximate. A REST candle
        // lagging the exchange can still clamp it to zero and trust a gap -
        // the pre-existing residual the reconnect repair pass covers). With the
        // slot one child behind the clock the snapshot also holds part of
        // the NEXT child, which the bound cannot separate, so the trust check
        // applies only when L === C.
        const restClosed = Math.max(0, rawF.v - vLive);
        if (P >= L || L < C || sum >= restClosed || restClosed - sum <= ROLLUP_V_GAP_TOL * restClosed) { v = sum; approx = false; }
        else v = restClosed;                     // the buffer under-counts (a gap): REST's volume, approximate
        // With the slot one child behind, REST already holds L whole (it
        // ended before the snapshot). Volume beyond the feed's whole period
        // (the closed children plus L) means REST saw trades AFTER L, so its
        // close is newer than L's: children before C must not replace it,
        // served or folded (audit M3). REST lagging the exchange (thin coins
        // materialize a period 45-70 s late, measured 2026-10-25) shows no
        // excess, and L's close stands.
        const feedV = sum + vLnow;
        if (L < C && P <= L && rawF.v > feedV && !volumeEqual(rawF.v, feedV)) cFrom = C;
      } else {
        v = Math.max(0, v - vLive);   // residue: whatever traded between the last push and REST's snapshot
      }
    } else if (rawF.v > 0) {
      skipV = C;   // REST's v holds part of child C; nothing to cover when REST saw no trade at all (review F3)
    }
    return { t: P, o: rawF.o, h: rawF.h, l: rawF.l, c: rawF.c, v: v, traded: rawF.v > 0, lastT: L - TF15.ms, approx: approx, skipV: skipV, cFrom: cFrom };
  }
  // cFrom: the first child whose close may replace agg.c (0 = any; see aggFromRest).
  function newAgg(t, pc) { return { t: t, o: pc, h: pc, l: pc, c: pc, v: 0, traded: false, lastT: t - TF15.ms, approx: false, skipV: null, cFrom: 0 }; }
  function foldChild(agg, b) {
    if (b.v > 0) {
      const first = !agg.traded;
      if (first) { agg.o = b.o; agg.h = b.h; agg.l = b.l; agg.traded = true; }
      else { if (b.h > agg.h) agg.h = b.h; if (b.l < agg.l) agg.l = b.l; }
      if (first || b.t >= agg.cFrom) agg.c = b.c;
    } else if (!agg.traded) {
      agg.c = b.c;             // still synthetic: carry the latest close
    }
    if (b.t !== agg.skipV) agg.v += b.v;
    agg.lastT = b.t;
  }
  // Close the accumulator's period into the slot's history (and the 1h
  // reference tape), trimmed to depth. Returns the carried close.
  function closeRollup(slot, tf, agg) {
    const bar = agg.traded
      ? { t: agg.t, T: agg.t + tf.ms - 1, o: agg.o, h: agg.h, l: agg.l, c: agg.c, v: agg.v }
      : { t: agg.t, T: agg.t + tf.ms - 1, o: agg.c, h: agg.c, l: agg.c, c: agg.c, v: 0 };
    if (slot.localFrom === null || slot.localFrom === undefined) slot.localFrom = bar.t;
    if (agg.approx) (slot.unverified = slot.unverified || []).push(bar.t);
    slot.closed.push(bar);
    const keep = tf.bars || BARS_BACK;
    if (slot.closed.length > keep) slot.closed.splice(0, slot.closed.length - keep);
    if (slot.unverified) {
      const first = slot.closed[0].t;
      slot.unverified = slot.unverified.filter(function (t) { return t >= first; });
    }
    if (slot.referenceClosed) {
      slot.referenceClosed.push(bar);
      const rk = tf.briefingBars || keep;
      if (slot.referenceClosed.length > rk) slot.referenceClosed.splice(0, slot.referenceClosed.length - rk);
    }
    state.feed.rollups[tf.id]++;
    return bar.c;
  }
  function formingFromAgg(agg, tf, s15, prev) {
    const f15 = s15.forming;
    const traded15 = (s15.feedBar && s15.feedBar.t === f15.t) || f15.v > 0;
    let o, h, l, c;
    if (agg.traded) { o = agg.o; h = agg.h; l = agg.l; c = agg.c; }
    else if (traded15) { o = f15.o; h = f15.h; l = f15.l; c = f15.c; }   // the period's first trade is in the live child
    else { o = agg.c; h = agg.c; l = agg.c; c = agg.c; }                 // nothing traded yet: synthetic from the carried close
    if (f15.h > h) h = f15.h;
    if (f15.l < l) l = f15.l;
    // The close: the live child's when it has traded (and is not older than
    // REST's close - audit M3); else REST's aggregate close (fresher than a
    // synthetic child's carried close). The 4 s mids tick sets c = mid on
    // every forming bar regardless.
    c = (traded15 && f15.t >= agg.cFrom) ? f15.c : (agg.traded ? agg.c : f15.c);
    if (prev && prev.t === agg.t) { if (prev.h > h) h = prev.h; if (prev.l < l) l = prev.l; }
    const v = agg.v + (f15.t > agg.lastT && f15.t !== agg.skipV ? f15.v : 0);
    return { t: agg.t, T: agg.t + tf.ms - 1, o: o, h: h, l: l, c: c, v: v };
  }
  function sameBar(a, b) {
    return !!a && !!b && a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;
  }
  // Bring every higher slot of a covered coin up to date with its 15m slot:
  // fold the children closed since the accumulator's lastT (rolling the
  // higher period when a child belongs to a later one), roll again if the
  // live 15m forming bar itself sits in a later period, then recompute the
  // forming bar. Reanalysis only when the bar moved; the REVISION bumps on a
  // roll (the consumer cadence stays the 4 s tick, as for the 15m).
  function rollupHigher(name, coin, now, justClosed) {
    const s15 = coin.tf[TF15.id];
    if (!s15 || !s15.forming) return;
    const f15 = s15.forming;
    // The children to consider: the buffer, plus bars closeFeedPeriods just
    // closed that its trim already dropped (a push after a gap longer than
    // the buffer - review F8), in time order.
    let closed15 = s15.closed;
    if (justClosed && justClosed.length) {
      const have = new Set(closed15.map(function (b) { return b.t; }));
      const dropped = justClosed.filter(function (b) { return !have.has(b.t); });
      if (dropped.length) closed15 = dropped.concat(closed15).sort(function (a, b) { return a.t - b.t; });
    }
    let dailyChanged = false;
    for (let hi = 0; hi < HIGHER.length; hi++) {
      const tf = HIGHER[hi];
      const slot = coin.tf[tf.id];
      if (!slot || !slot.forming) continue;          // REST has not seeded this slot: nothing to roll from
      let agg = slot.agg;
      if (!agg || agg.t !== slot.forming.t) agg = slot.agg = aggFromRest(slot.forming, slot.fetchedAt || now, s15, feed.covers(name));
      let rolled = false;
      // Children fell out of the buffer before they were folded (the coin
      // lost coverage for longer than the buffer while REST kept its 15m
      // slot): fold what is left, mark the seed approximate and make REST
      // confirm the slot again (second review, 3).
      if (closed15.length && closed15[0].t > agg.lastT + TF15.ms && agg.lastT >= agg.t - TF15.ms) {
        agg.approx = true;
        if (slot.restT !== null) { slot.restT = null; state.feed.rollupReconcile.reconfirms++; }
      }
      let i = closed15.length - 1;
      while (i >= 0 && closed15[i].t > agg.lastT) i--;
      for (i = i + 1; i < closed15.length; i++) {
        const b = closed15[i];
        const pb = Math.floor(b.t / tf.ms) * tf.ms;
        if (pb < agg.t) continue;
        while (pb > agg.t) { const pc = closeRollup(slot, tf, agg); agg = slot.agg = newAgg(agg.t + tf.ms, pc); rolled = true; }
        foldChild(agg, b);
      }
      const p = Math.floor(f15.t / tf.ms) * tf.ms;
      // The 15m slot is BEHIND this slot (a REST pass restored an older
      // period for a moment): its forming bar belongs to a period this slot
      // has already closed - leave the higher bar alone (review F1).
      if (p < agg.t) continue;
      while (agg.t < p) { const pc = closeRollup(slot, tf, agg); agg = slot.agg = newAgg(agg.t + tf.ms, pc); rolled = true; }
      const next = formingFromAgg(agg, tf, s15, slot.forming);
      if (rolled || !sameBar(slot.forming, next)) {
        slot.forming = next;
        reanalyze(name, tf.id);
        if (tf.id === "1d") dailyChanged = true;
      }
      if (rolled) state.revision++;
    }
    if (dailyChanged) rebuildDerived(name);
  }
  // The stage-2 parity gate: REST's closed bars against the locally rolled
  // ones for the same period (from localFrom), before REST replaces them.
  // o/h/l/c is what STRAT-CORE classifies on; v is counted apart (the F8
  // tail-loss class of the children reaches the parent's c/v). A bar built
  // on an approximate seed (slot.unverified) is not a sample: counted, not
  // compared. v compares within ROLLUP_V_REL_TOL (see aggFromRest).
  let rollupLogged = 0;
  function reconcileRollup(name, tf, cur, restClosed) {
    if (cur.localFrom === null || cur.localFrom === undefined) return;
    const r = state.feed.rollupReconcile;
    const byT = new Map();
    for (let i = 0; i < cur.closed.length; i++) if (cur.closed[i].t >= cur.localFrom) byT.set(cur.closed[i].t, cur.closed[i]);
    const unverified = cur.unverified || [];
    for (let i = 0; i < restClosed.length; i++) {
      const rb = restClosed[i], lb = byT.get(rb.t);
      if (!lb) continue;
      if (unverified.indexOf(rb.t) >= 0) { r.unverified++; continue; }
      r.barsCompared++;
      const diff = ["o", "h", "l", "c"].filter(function (k) { return rb[k] !== lb[k]; });
      if (!volumeEqual(rb.v, lb.v)) diff.push("v");
      if (!diff.length) continue;
      r.mismatches++;
      if (diff.some(function (k) { return k !== "v"; })) r.mismatchesOhlc++; else r.mismatchesVolume++;
      r.lastMismatch = { coin: name, tf: tf.id, t: rb.t, fields: diff, local: closedFromBar(lb), rest: closedFromBar(rb) };
      if (rollupLogged < 50) {
        rollupLogged++;
        log("rollup MISMATCH " + name + " " + tf.id + " t=" + new Date(rb.t).toISOString() + " " + diff.map(function (k) {
          return k + " local=" + lb[k] + " rest=" + rb[k];
        }).join(" "));
      }
    }
  }
  // A 15m REST pass REPAIRED one of this coin's closed bars (a partial child
  // of a boot or a reconnect that spanned a boundary, or F8 tail loss): a
  // higher bar may have been folded from the bad child, and a forming daily
  // could carry a missed extreme all day. Drop the confirmation of every
  // higher slot so the next tick sweeps them and REST wins again. Cost in
  // steady state: the repaired coins only (F8 runs ~70 coins/day in
  // production, ~280 requests); after a boot, one stack for the coins whose
  // snapshot was partial.
  // changedT: the NEWEST child the pass changed (audit M1). A timeframe is
  // marked only when that child's period is one still built locally (from
  // localFrom, or the period the accumulator is on): a child whose higher
  // bars REST has already replaced needs nothing (second review 2026-10-26,
  // 2). Without changedT every timeframe is marked.
  function markHigherUnconfirmed(name, changedT) {
    const coin = state.coins[name];
    if (!coin) return 0;
    let n = 0;
    const now = Date.now();
    for (let i = 0; i < HIGHER.length; i++) {
      const tf = HIGHER[i];
      const s = coin.tf[tf.id];
      if (!s || s.restT === undefined) continue;
      if (changedT !== undefined) {
        const from = (s.localFrom !== null && s.localFrom !== undefined) ? s.localFrom : (s.agg ? s.agg.t : null);
        if (from !== null && Math.floor(changedT / tf.ms) * tf.ms < from) continue;
      }
      if (s.restT !== null) n++;
      s.restT = null;
      s.reconfirmAt = now;   // a response SENT before this instant cannot confirm (review F2)
    }
    if (n) state.feed.rollupReconcile.reconfirms++;
    return n;
  }
  // A higher slot of this coin serves a period older than the one its 15m
  // forming bar belongs to.
  function higherBehind(coin, s15) {
    for (let i = 0; i < HIGHER.length; i++) {
      const slot = coin.tf[HIGHER[i].id];
      if (slot && slot.forming && slot.forming.t < Math.floor(s15.forming.t / HIGHER[i].ms) * HIGHER[i].ms) return true;
    }
    return false;
  }
  // Coins per fetched timeframe whose served forming bar is NOT the current
  // period (or whose slot is missing), with the roll's 4 s grace: the
  // production meter for the roll lag this stage removes.
  function formingBehind(now) {
    const covered = {}, uncovered = {};
    for (let i = 0; i < TFS.length; i++) {
      const tf = TFS[i];
      if (tf.derived) continue;
      let nc = 0, nu = 0;
      for (let j = 0; j < state.order.length; j++) {
        const name = state.order[j];
        const c = state.coins[name];
        const s = c && c.tf[tf.id];
        if (!s || !s.forming || now > s.forming.T + 4000) { if (feed && feed.covers(name)) nc++; else nu++; }
      }
      covered[tf.id] = nc;
      uncovered[tf.id] = nu;
    }
    return { covered: covered, uncovered: uncovered };
  }

  // Track which side of the last CLOSED bar's range the forming bar broke
  // FIRST (per coin per TF, keyed by the forming bar's start time). Feeds the
  // core's path-dependent 1-3 Rev Strat. Stateful, so it lives here rather
  // than in the pure STRAT-CORE (the dashboard app has the same tracker).
  // Honest limits: if both sides are already broken at first sight (process
  // start onto an outside bar, or a sub-poll whipsaw) the order is unknown
  // and stays null - the core then emits no 1-3.
  function firstBreakSide(coin, tfId, closed, forming) {
    if (!coin.fb) coin.fb = {};
    if (!forming || !closed.length) { delete coin.fb[tfId]; return null; }
    const Lb = closed[closed.length - 1];
    let st = coin.fb[tfId];
    if (!st || st.t !== forming.t) { st = coin.fb[tfId] = { t: forming.t, side: null }; }
    if (st.side === null) {
      const up = forming.h > Lb.h, dn = forming.l < Lb.l;
      if (up && !dn) st.side = "up";
      else if (dn && !up) st.side = "down";
    }
    return st.side;
  }

  // Target rules v2 context: the coin's finished 1h bars (the bridge - a
  // 15m/30m window starts inside a day whose daily bar is still forming), its
  // CLOSED daily bars, and whether those are its whole history: the oldest
  // daily STARTS inside the 220-day window (a younger listing), judged by
  // time - a short or empty REST answer for an old coin must not read as a
  // whole history (review LOW-1). Complete + no level = a true all-time
  // extreme. No daily slot -> completeness unknown: an empty search falls
  // back, never "none".
  function dailyCtx(coin) {
    const h = coin.tf["1h"], d = coin.tf["1d"];
    const bridge = h ? (h.referenceClosed || h.closed) : undefined;
    if (!d || !d.closed) return bridge ? { bridge: bridge } : undefined;
    const complete = d.closed.length > 0 && d.closed[0].t > Date.now() - DAILY_COMPLETE_DAYS * 86400000;
    return { bridge: bridge, daily: d.closed, complete: complete };
  }
  // The daily or 1h history moved (a REST load or repair, a local roll):
  // every other timeframe's targets read them, so re-run those now rather
  // than on their next push (review LOW-2: a boot-time fallback would
  // otherwise outlive the history that replaces it).
  function reanalyzeOthers(name, tfId) {
    for (let i = 0; i < TFS.length; i++) {
      if (!TFS[i].derived && TFS[i].id !== tfId) reanalyze(name, TFS[i].id);
    }
  }

  function reanalyze(name, tfId) {
    const coin = state.coins[name];
    const slot = coin.tf[tfId];
    if (slot) slot.an = analyzeTF(slot.closed, slot.forming,
                                  firstBreakSide(coin, tfId, slot.closed, slot.forming), dailyCtx(coin));
  }

  // Rebuild calendar W/M bars from the daily slot (closed dailies + forming
  // daily as last element so the forming W/M bar is correct).
  function rebuildDerived(name) {
    const coin = state.coins[name];
    const dslot = coin.tf["1d"];
    if (!dslot || !dslot.closed.length) return;
    const all = dslot.closed.slice();
    if (dslot.forming) all.push(dslot.forming);
    for (let i = 0; i < TFS.length; i++) {
      const tf = TFS[i];
      if (!tf.derived) continue;
      const agg = aggregateBars(all, tf.derived);
      let forming = null;
      if (agg.length && agg[agg.length - 1].T > Date.now()) forming = agg.pop();
      coin.tf[tf.id] = { closed: agg, forming: forming,
                         an: analyzeTF(agg, forming, firstBreakSide(coin, tf.id, agg, forming), dailyCtx(coin)) };
    }
  }

  // Sweep order (A2): coins carrying a live signal first, roster order
  // otherwise - a stable partition, so the rest keeps the roster order the
  // old FIFO had.
  function orderBySignal(names) {
    const live = [], rest = [];
    for (let i = 0; i < names.length; i++) {
      (hasLiveSignal(state.coins[names[i]]) ? live : rest).push(names[i]);
    }
    return live.concat(rest);
  }

  // Refetch candles for a subset of coins (default: all). Returns the number
  // of failed fetches so callers can back off; lastCandles only advances on
  // success (inside setCandles) so /health cannot report fresh candles while
  // every fetch is failing. Jobs are ranked by timeframe within their batch
  // so a stacked roll runs one timeframe after another (A2); `batch` is the
  // enqueue wave (one per timer tick - the timer passes it); a caller that
  // passes none is a wave of its own.
  async function refreshTF(tf, names, batch, onData) {
    names = orderBySignal(names || state.order);
    const rank = tfRank(tf);
    if (batch === undefined) batch = enqueue.newBatch();
    let failed = 0;
    const jobs = names.map(function (name) {
      return enqueue(function () { return fetchCandles(name, tf); }, rank, batch)
        .then(function (d) { if (onData) onData(name, d); setCandles(name, tf, d); })
        .catch(function () { failed++; state.candleFailures++; });
    });
    await Promise.all(jobs);
    if (failed) log("refetch " + tf.id + ": " + failed + "/" + names.length + " fetches failed");
    return failed;
  }

  // ---- WebSocket candle feed (option A, stage 1) ----------------------
  // The feed replaces the 15m
  // REST sweep and the true-up for the coins it COVERS (socket open,
  // subscription acknowledged); everything else keeps the REST path, which
  // is therefore also the fallback when the socket is down. STRAT-CORE
  // sees the same slot shape as before: closed bars plus one forming bar.
  //
  // Two bars per 15m slot: `feedBar` is the LAST RAW PUSH of the current
  // period (exactly what the exchange sent - and, by F3d/F6b, exactly the
  // closed bar REST will serve for it); `forming` is feedBar UNION the mid
  // tape (max h / min l, c = last mid), the rule kept unchanged from the REST path.
  // At a roll the bar that enters `closed` is feedBar, never the
  // mids-expanded forming, so the closed history stays byte-identical to
  // REST; a period with no push closes as the SYNTHETIC bar REST would
  // have served (o = h = l = c = previous close, v = 0).
  function syntheticBar(t, pc) { return { t: t, T: t + TF15.ms - 1, o: pc, h: pc, l: pc, c: pc, v: 0 }; }
  function closedFromBar(b) { return { t: b.t, T: b.T, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; }

  // Close the slot's current period (feedBar or synthetic) and every empty
  // period after it up to, not including, nextT. Trims to the analysis
  // depth. Marks where feed-derived bars begin (the comparator's range).
  function closeFeedPeriods(slot, nextT) {
    const closed = slot.closed;
    const f = slot.forming;
    if (!f) return [];
    let bar;
    if (slot.feedBar && slot.feedBar.t === f.t) bar = closedFromBar(slot.feedBar);
    else {
      const pc = closed.length ? closed[closed.length - 1].c : f.o;
      bar = syntheticBar(f.t, pc);
      state.feed.synthesized++;
    }
    if (slot.feedFrom === null || slot.feedFrom === undefined) slot.feedFrom = bar.t;
    const out = [bar];
    closed.push(bar);
    for (let t = bar.t + TF15.ms; t < nextT; t += TF15.ms) {
      const s = syntheticBar(t, closed[closed.length - 1].c);
      closed.push(s);
      out.push(s);
      state.feed.synthesized++;
    }
    const keep = TF15.bars || BARS_BACK;
    if (closed.length > keep) closed.splice(0, closed.length - keep);
    slot.feedBar = null;
    return out;   // every bar closed, untrimmed, for the higher rollup (review F8)
  }

  // A push from the feed. Same period: update feedBar and the forming bar
  // (union). Later period: roll (close what was open, synthesize skipped
  // periods, the push is the new forming bar). No slot yet (boot not done,
  // a coin registered seconds ago): ignored - REST fills the slot first.
  // Reanalysis is immediate and cheap; the REVISION is bumped only by a
  // roll, so the 4 s mids tick keeps the consumer cadence (design 5).
  function applyFeedBar(name, bar, interval, at) {
    if (!feed) return;                                  // no feed: inert (only the feed calls this)
    if (interval && interval !== TF15.id) return;
    const coin = state.coins[name];
    const slot = coin && coin.tf[TF15.id];
    if (!slot) { state.feed.ignored++; return; }
    at = at || Date.now();
    state.feed.pushes++;
    const f = slot.forming;
    let justClosed = null;
    if (f && bar.t < f.t) { state.feed.late++; return; }
    if (f && bar.t === f.t) {
      slot.feedBar = bar;
      f.o = bar.o; f.c = bar.c; f.v = bar.v;
      if (bar.h > f.h) f.h = bar.h;
      if (bar.l < f.l) f.l = bar.l;
    } else {
      // A later period: roll. (No forming bar at all - a listing with no
      // history yet - is a SEED, not a roll: nothing closes.)
      if (f) { justClosed = closeFeedPeriods(slot, bar.t); state.feed.pushRolls++; }
      slot.feedBar = bar;
      slot.forming = closedFromBar(bar);
      state.revision++;
    }
    slot.feedAt = at;
    state.lastCandles = at;
    if (coin.uni) state.lastCandlesByUni[coin.uni] = at;
    reanalyze(name, TF15.id);
    rollupHigher(name, coin, at, justClosed);
  }

  // The boundary passed with no push yet (the first push of a period is
  // the first TRADE): do locally what a REST fetch would return at this
  // instant - close the period with feedBar-or-synthetic and synthesize
  // the new forming bar from the last close. The real open arrives with
  // the first push. Not the superseded A3: the open is the previous close
  // (REST's own rule), never a mid.
  function localRollFeed(name, slot, now) {
    const coin = state.coins[name];
    const curT = Math.floor(now / TF15.ms) * TF15.ms;
    const justClosed = closeFeedPeriods(slot, curT);
    const closed = slot.closed;
    const pc = closed.length ? closed[closed.length - 1].c : slot.forming.c;
    slot.forming = syntheticBar(curT, pc);
    slot.feedBar = null;
    slot.feedAt = now;
    state.feed.localRolls++;
    state.lastCandles = now;
    if (coin.uni) state.lastCandlesByUni[coin.uni] = now;
    state.revision++;
    reanalyze(name, TF15.id);
    rollupHigher(name, coin, now, justClosed);
  }

  // One REST 15m pass over every coin (hourly, and after a reconnect):
  // the comparator checks each REST closed bar against the FEED-derived
  // bar with the same t (o/h/l/c/v, strict) before REST replaces the
  // slot - the parity gate, counted in state.feed.reconcile and logged
  // per mismatch (capped). REST wins afterwards, so the pass is also the
  // repair for whatever the gap or a dead subscription left behind.
  //
  // A pass is a CHECK only in steady state. The "boot" and "reconnect"
  // passes are REPAIRS: the feed never re-sends a closed bar, so a period
  // that ended between a coin's last REST fetch and the feed's first push
  // (the boot load takes ~15 min; a socket gap can span a boundary) closed
  // with a PARTIAL bar - measured on the first local boot 2026-09-22:
  // 243 local rolls and 43 push rolls closed the boot-time snapshot of the
  // 02:30 bar. Those passes replace the bars and skip the comparator, so
  // the gate counts steady-state parity only.
  async function reconcileFeed(reason) {
    if (!feed) return null;
    const check = reason !== "boot" && reason !== "reconnect";
    const r = state.feed.reconcile;
    if (r.inFlight) { log("feed reconcile skipped (previous pass in flight)"); return null; }
    // Only COVERED coins: they are the ones with feed-derived bars to check,
    // and the ones no other REST path touches. Uncovered coins belong to the
    // bar-roll sweep and the true-up; fetching them here too would race
    // those paths for the same slot (review 2026-09-22 MED). The 15m flag is
    // held for the pass, as the true-up holds it; if a boundary sweep of
    // uncovered coins holds it right now, the pass retries in a minute.
    if (TF15.refetching) {
      log("feed reconcile deferred 60 s (15m sweep in flight)");
      if (!stopped) {
        const retry = setTimeout(function () { if (!stopped) reconcileFeed(reason); }, 60000);
        if (retry.unref) retry.unref();   // never keeps a stopping process alive
      }
      return null;
    }
    r.inFlight = true;
    TF15.refetching = true;
    const names = state.order.filter(function (n) { return feed.covers(n); });
    let compared = 0, mismatches = 0, ohlc = 0, vol = 0, logged = 0, marked = 0;
    function compare(name, data) {
      const slot = state.coins[name] && state.coins[name].tf[TF15.id];
      if (!slot) return;
      const rest = splitClosedBars(TF15, data.closed).analysis;
      // Stage 2: any closed bar REST is about to change (whatever its source)
      // may have been folded into a higher bar - make REST confirm those again
      // (scoped to the timeframes the NEWEST changed child still feeds: the
      // scope test is monotone in t, so the newest child's scope is the union
      // of every changed child's - audit M1 2026-10-27, the oldest missed a
      // later repair inside a local bar).
      const held = new Map();
      for (let i = 0; i < slot.closed.length; i++) held.set(slot.closed[i].t, slot.closed[i]);
      let changedT = null;
      for (let i = 0; i < rest.length; i++) {
        const rb = rest[i], hb = held.get(rb.t);
        if (hb && (rb.o !== hb.o || rb.h !== hb.h || rb.l !== hb.l || rb.c !== hb.c || rb.v !== hb.v)) changedT = rb.t;
      }
      if (changedT !== null && markHigherUnconfirmed(name, changedT)) marked++;
      if (!check) return;
      if (slot.feedFrom === null || slot.feedFrom === undefined) return;
      const byT = new Map();
      for (let i = 0; i < slot.closed.length; i++) if (slot.closed[i].t >= slot.feedFrom) byT.set(slot.closed[i].t, slot.closed[i]);
      for (let i = 0; i < rest.length; i++) {
        const rb = rest[i], fb = byT.get(rb.t);
        if (!fb) continue;
        compared++;
        const diff = ["o", "h", "l", "c", "v"].filter(function (k) { return rb[k] !== fb[k]; });
        if (!diff.length) continue;
        mismatches++;
        // o/h/l/c is what STRAT-CORE classifies on; v feeds rvol. They are
        // counted apart because the stream can under-report the closing
        // VOLUME of a bar (measured 2026-09-22 04:00Z, HYPE 03:45: v
        // 20566.59 on the feed vs 20730.47 on REST, o/h/l/c identical, no
        // push dropped): the last trades of a period coalesced past the
        // boundary never reach the closed bar on the stream while the REST
        // store attributes them. The hourly pass repairs it; the gate is
        // ZERO o/h/l/c mismatches, with volume mismatches reported.
        if (diff.some(function (k) { return k !== "v"; })) ohlc++; else vol++;
        r.lastMismatch = { coin: name, t: rb.t, fields: diff, feed: closedFromBar(fb), rest: closedFromBar(rb) };
        if (logged < 20) {
          logged++;
          log("feed reconcile MISMATCH " + name + " t=" + new Date(rb.t).toISOString() + " " + diff.map(function (k) {
            return k + " feed=" + fb[k] + " rest=" + rb[k];
          }).join(" "));
        }
      }
    }
    try {
      const failed = await refreshTF(TF15, names, undefined, compare);
      r.passes++;
      r.coins = names.length;
      r.barsCompared += compared;
      r.mismatches += mismatches;
      r.mismatchesOhlc += ohlc;
      r.mismatchesVolume += vol;
      r.lastPassAt = new Date().toISOString();
      r.lastPass = { reason: reason, coins: names.length, barsCompared: compared, mismatches: mismatches,
                     mismatchesOhlc: ohlc, mismatchesVolume: vol, fetchFailures: failed, check: check };
      log("feed reconcile (" + reason + (check ? "" : ", repair only") + "): " + names.length + " coins, "
        + compared + " bars compared, " + mismatches + " mismatches (" + ohlc + " ohlc, " + vol + " volume-only), "
        + failed + " fetch failures");
      // The budget line for stage 2: how many coins this pass sent back to
      // REST for their higher slots (up to four requests each).
      if (marked) log("feed reconcile (" + reason + "): " + marked + " coins marked for higher re-confirm");
      onTick();
      return r.lastPass;
    } catch (e) {
      log("feed reconcile failed: " + (e && e.message));
      return null;
    } finally {
      r.inFlight = false;
      TF15.refetching = false;
    }
  }

  function feedHealth(now) {
    if (!feed) return null;
    now = now || Date.now();
    let covered = 0;
    for (let i = 0; i < state.order.length; i++) if (feed.covers(state.order[i])) covered++;
    const r = state.feed.reconcile;
    const behind = formingBehind(now);
    return Object.assign({ enabled: true }, feed.snapshot(now), {
      coveredCoins: covered,
      pushes: state.feed.pushes, pushRolls: state.feed.pushRolls, localRolls: state.feed.localRolls,
      synthesized: state.feed.synthesized, ignored: state.feed.ignored, late: state.feed.late,
      // Stage 2: periods closed locally per higher timeframe, the rollup
      // comparator, and how many coins per timeframe are NOT on the current
      // period right now (the roll-lag meter).
      rollups: Object.assign({}, state.feed.rollups),
      rollupReconcile: Object.assign({}, state.feed.rollupReconcile),
      behind: behind.covered,               // covered coins: the stage-2 acceptance meter
      behindUncovered: behind.uncovered,    // uncovered coins: the REST path, as before
      reconcile: { passes: r.passes, coins: r.coins, barsCompared: r.barsCompared, mismatches: r.mismatches,
                   mismatchesOhlc: r.mismatchesOhlc, mismatchesVolume: r.mismatchesVolume,
                   lastMismatch: r.lastMismatch, lastPassAt: r.lastPassAt, lastPass: r.lastPass, inFlight: r.inFlight,
                   intervalMs: feedReconcileMs }
    });
  }

  // The feed object: injected by tests (hooks.feed, a stub with covers /
  // setCoins / start / stop / snapshot), constructed when config.candleFeed
  // is on (env CANDLE_FEED=1), otherwise null - and with null every path
  // above is unreachable, so a flag-off worker is the worker as before.
  const feed = hooks.feed !== undefined ? hooks.feed
    : ((config && config.candleFeed)
        ? createCandleFeed({ log: log, onBar: applyFeedBar, onReconnect: function () { reconcileFeed("reconnect"); } })
        : null);
  const feedReconcileMs = (config && config.feedReconcileMs) || FEED_RECONCILE_MS;

  async function refreshMids() {
    try {
      // One allMids per tracked universe, fetched concurrently and merged. The
      // fetches are independently guarded so a failure in one universe cannot
      // starve the others of fresh mids (keeps xyz alert cadence unchanged when
      // perps is added). Keys never collide (bare vs "xyz:"-prefixed). Bare
      // main-dex allMids also carries non-perp keys we never look up - harmless,
      // the per-coin loop only reads names we enumerated.
      const parts = await Promise.all(universes.map(function (uv) {
        return postMids(infoBody("allMids", uv))
          .catch(function (e) {
            state.midsFailures++;
            log("mids refresh failed (" + uv.id + "): " + (e && e.message));
            return null;
          });
      }));
      const mids = {};
      let anyOk = false;
      const okUniverseIds = [];
      for (let p = 0; p < parts.length; p++) {
        if (parts[p]) {
          Object.assign(mids, parts[p]);
          anyOk = true;
          okUniverseIds.push(universes[p].id);
        }
      }
      if (!anyOk) return false;
      const now = Date.now();
      okUniverseIds.forEach(function (id) { state.lastMidsByUni[id] = now; });
      for (let i = 0; i < state.order.length; i++) {
        const name = state.order[i];
        const m = parseFloat(mids[name]);
        if (!isFinite(m)) continue;
        const coin = state.coins[name];
        coin.mid = m;
        // Mid tape: feeds the EXACT 5m and 60m returns (metrics.momentum).
        // 62 min retention (was 7 min pre-score_v 3): the 2 min slack bounds
        // the r60 anchor span to [60m, 62m]; metrics guards each anchor's max
        // age so the longer tape cannot stretch r5 during a mids stall.
        // CONTRACT: mid and the tape sample are written together - the last
        // sample's t IS the endpoint observation time metrics.momentum
        // anchors to (its staleness contract depends on this invariant).
        coin.hist.push({ t: now, m: m });
        while (coin.hist.length && coin.hist[0].t < now - 3720000) coin.hist.shift();
        let dailyChanged = false;
        for (let j = 0; j < TFS.length; j++) {
          if (TFS[j].derived) continue;          // W/M rebuild from the daily below
          const slot = coin.tf[TFS[j].id];
          if (!slot || !slot.forming) continue;
          const f = slot.forming;
          if (now > f.T) continue;               // period over; boundary refetch rolls it
          let changed = false;
          if (m > f.h) { f.h = m; changed = true; }  // monotonic expansion only
          if (m < f.l) { f.l = m; changed = true; }
          if (m !== f.c) { f.c = m; changed = true; }
          if (changed) {
            reanalyze(name, TFS[j].id);
            if (TFS[j].id === "1d") dailyChanged = true;
          }
        }
        if (dailyChanged) rebuildDerived(name);
      }
      state.lastMids = Date.now();
      state.revision++;
      return true;
    } catch (e) {
      log("mids refresh failed: " + (e && e.message));
      return false;
    }
  }

  // 30s served-score sampler (Deploy 1 item 3). Records, for every
  // tracked coin, the SAME post-readiness-gate score /api/state
  // serializes - through apistate.servedScore, with the same
  // config.ftfcTfs the /api/state route passes, so the sampler and the
  // payload gate identically. A null served score records as null (an
  // unready coin's history is real history); ranks are computed inside
  // the ring module at sample time, per universe. Pure local compute -
  // no exchange fetch, no rate-limit weight. `now` is injectable for
  // tests; the timer passes nothing.
  function sampleScores(now) {
    now = now || Date.now();
    const rows = [];
    for (let i = 0; i < state.order.length; i++) {
      const name = state.order[i];
      const c = state.coins[name];
      if (!c) continue;
      rows.push({ name: name, uni: c.uni || null,
                  score: servedScore(state, c, config && config.ftfcTfs, now) });
    }
    scoreRing.recordSample(state.scoreRing, rows, now);
    // A sample mutates what /api/state would serialize (scoreDelta), so
    // the serialization cache must see a new revision. An empty roster
    // recorded nothing - no mutation, no bump.
    if (rows.length) state.revision++;
  }

  function startTimers() {
    // allMids every 4s (guarded against overlap), then rule evaluation.
    let midsBusy = false;
    timers.push(setInterval(async function () {
      if (stopped || midsBusy) return;
      midsBusy = true;
      try {
        const ok = await refreshMids();
        if (ok) {
          log("mids ok (" + state.order.length + " coins)");
          onTick();
        }
      } finally { midsBusy = false; }
    }, 4000));

    // Bar-roll refetch + stale-slot recovery: keyed off each forming bar's
    // end time (calendar-safe). Staleness is detected PER COIN, so one
    // coin's failed refetch cannot be masked by another coin's fresh bar,
    // and a TF whose initial load failed for every coin (no slots at all)
    // is retried instead of staying dead forever. A coin whose slot exists
    // but has no live forming bar (fetch failed, or an illiquid market with
    // no trades this period) is retried no more than every 30s via
    // fetchedAt; a cycle with failures backs the whole TF off 30s so a down
    // exchange is not hammered.
    timers.push(setInterval(function () {
      if (stopped || !state.loaded) return;
      barRollTick(Date.now());
    }, 5000));

    // Contexts (funding / premium / OI / 24h vol) every 60s.
    timers.push(setInterval(function () {
      if (stopped) return;
      refreshCtxs();
    }, 60000));

    // 15m true-up every 5 min (also trues up forming-bar volume for RVOL),
    // scoped to trueUpUniverses (see the resolution above).
    timers.push(setInterval(function () {
      if (stopped) return;
      trueUp15m();
    }, 300000));

    // Feed reconciliation: one REST 15m pass per coin per hour (design 4).
    if (feed) {
      timers.push(setInterval(function () {
        if (stopped) return;
        reconcileFeed("hourly");
      }, feedReconcileMs));
    }

    // Served-score ring sample every 30s (scoreRing.GRAIN_MS - the ring
    // module owns the grain, so this timer and the window math cannot
    // drift apart). Rides the shared timers array, so stop() clears it
    // with everything else.
    timers.push(setInterval(function () {
      if (stopped) return;
      sampleScores();
    }, scoreRing.GRAIN_MS));
  }

  // One bar-roll timer tick (exported for tests: the timer passes Date.now()).
  function barRollTick(now) {
      const batch = rollBatchKey(now);   // one batch per 15-minute period: every sweep of this roll keeps rank order
      TFS.forEach(function (tf) {
        if (tf.derived) return;
        // A coin the feed COVERS rolls locally when its period is over -
        // independent of the REST flag below, which only gates sweeps (a
        // reconciliation or true-up pass must not delay local rolls).
        const feedTf = feed && tf.id === TF15.id;
        if (feedTf) {
          for (let i = 0; i < state.order.length; i++) {
            const name = state.order[i];
            const coin = state.coins[name];
            const s = coin.tf[tf.id];
            if (!s || !s.forming || !feed.covers(name)) continue;
            if (now > s.forming.T + 4000) localRollFeed(name, s, now);
            // Coverage that returned after REST advanced the 15m slot (no
            // rollup hook while uncovered) would leave a higher slot on the
            // old period until the next push or 15m roll (audit M4): roll it
            // here. Only when one is behind - a steady-state tick is a no-op.
            else if (higherBehind(coin, s)) rollupHigher(name, coin, now);
          }
        }
        if (tf.refetching) return;
        if (now < (tf.retryAfter || 0)) return;
        const stale = [];
        for (let i = 0; i < state.order.length; i++) {
          const name = state.order[i];
          const s = state.coins[name].tf[tf.id];
          if (!s) { stale.push(name); continue; }
          if (feedTf && s.forming && feed.covers(name)) continue;   // covered: never REST-swept
          // Stage 2: a higher slot that rolled LOCALLY already serves the new
          // period, so the old predicate below never fires for it; it is swept
          // while REST has not confirmed that period (restT) - once per
          // boundary, the same request at the same instant as before, now as
          // the reconcile instead of the roll.
          const unconfirmed = feed && !feedTf && s.forming && s.restT !== undefined && s.restT !== s.forming.t;
          if ((!s.forming || now > s.forming.T + 4000      // rolled (give the exchange a beat) or missing
               || (unconfirmed && now > s.forming.t + 4000))
              && now - (s.fetchedAt || 0) > 30000) {        // do not re-poll gapped markets every cycle
            stale.push(name);
          }
        }
        if (!stale.length) return;
        tf.refetching = true;
        log("bar roll: refetching " + tf.id + " (" + stale.length + "/" + state.order.length + " coins)");
        refreshTF(tf, stale, batch)
          .then(function (failed) {
            if (failed) tf.retryAfter = Date.now() + 30000;
            log("bar roll: " + tf.id + " done" + (failed ? " (" + failed + " failed, retrying in 30s)" : ""));
            onTick();
          })
          .catch(function (e) {
            tf.retryAfter = Date.now() + 30000;
            log("bar roll refetch " + tf.id + " failed: " + (e && e.message));
          })
          .finally(function () { tf.refetching = false; });
      });
  }

  // The 5-min 15m true-up, extracted from its timer so the universe scoping
  // is testable. Returns a promise for tests; the timer fires and forgets.
  function trueUp15m() {
    const tf = TFS.find(function (t) { return t.id === "15m"; });
    if (tf.refetching) return Promise.resolve();
    if (enqueue.pending() > TRUEUP_YIELD_PENDING) {
      log("15m true-up skipped (" + enqueue.pending() + " candle fetches queued)");
      return Promise.resolve();
    }
    let names = trueUpUniverses
      ? state.order.filter(function (n) {
          const c = state.coins[n];
          return c && trueUpUniverses.indexOf(c.uni) >= 0;
        })
      : state.order.slice();
    // A coin the feed covers gets its volume pushed cumulatively (F3b):
    // nothing to true up. With every coin covered the true-up is idle and
    // resumes by itself when the feed is down.
    if (feed) names = names.filter(function (n) { return !feed.covers(n); });
    if (!names.length) return Promise.resolve();
    tf.refetching = true;
    return refreshTF(tf, names)
      .then(function () {
        log("15m true-up done (" + names.length + "/" + state.order.length + " coins)");
        onTick();
      })
      .catch(function (e) { log("15m true-up failed: " + (e && e.message)); })
      .finally(function () { tf.refetching = false; });
  }

  async function start() {
    await loadUniverse();
    const fetchTFs = TFS.filter(function (tf) { return !tf.derived; });
    const total = state.order.length * fetchTFs.length;
    let done = 0, failed = 0;
    log("initial candle load: " + total + " fetches ("
      + state.order.length + " coins x " + fetchTFs.map(function (t) { return t.id; }).join("/") + ")");
    const jobs = [];
    const batch = enqueue.newBatch();   // the boot load is one wave
    fetchTFs.forEach(function (tf) {
      const rank = tfRank(tf);
      state.order.forEach(function (name) {
        jobs.push(enqueue(function () { return fetchCandles(name, tf); }, rank, batch)
          .then(function (d) { setCandles(name, tf, d); })
          .catch(function () { failed++; state.candleFailures++; })
          .finally(function () {
            done++;
            if (done % 100 === 0 || done === total) log("initial candle load: " + done + "/" + total);
          }));
      });
    });
    await Promise.all(jobs);
    // lastCandles is only advanced by SUCCESSFUL fetches (setCandles); a
    // fully-failed load leaves it stale so /health reports degraded, and the
    // bar-roll timer's stale-slot recovery re-attempts the missing slots.
    state.loaded = true;
    log("initial load complete (" + failed + " fetch failures)");
    startTimers();
    if (feed) {
      // After the load: pushes before the slots exist would be ignored.
      feed.setCoins(state.order.slice());
      feed.start();
      log("candle feed: starting (" + state.order.length + " coins, reconcile every " + Math.round(feedReconcileMs / 60000) + " min)");
      // The boot repair pass (see reconcileFeed): the load's 15m snapshots
      // are minutes old by now and the feed will not re-send a closed bar.
      const bootPass = setTimeout(function () { if (!stopped) reconcileFeed("boot"); }, FEED_BOOT_PASS_MS);
      if (bootPass.unref) bootPass.unref();
    }
  }

  function stop() {
    stopped = true;
    timers.forEach(clearInterval);
    timers.length = 0;
    limiter.stop();
    if (feed) feed.stop();
  }

  // refreshCtxs is exposed for tests (roster recovery); timers drive it live.
  // loadUniverse likewise: it is start()'s first step and was untested, so the
  // BOOT enumeration and the 60s refresh - which register coins by separate
  // code paths - can now be asserted to agree on what they capture.
  // refreshMids likewise: its ladder EXEMPTION (postMids) is a pinned
  // asymmetry - candles/ctx keep the retry ladder, the mids tape must not.
  // trueUp15m likewise: its universe SCOPING is the demand cut and
  // must be assertable without running timers.
  // sampleScores likewise: the sampled-equals-served parity and the
  // ring's roster eviction must be assertable with an injected clock.
  // startTimers likewise (review LOW): the 30s ring cadence and
  // stop()'s cleanup are wiring, and wiring that no test pins can be
  // removed while every behavior test stays green - a fake-timer test
  // drives THIS export instead of start(), which would fetch.
  // ledger likewise: /health serves its stats, and the per-minute request
  // line is how the exchange's refusal threshold is measured from the log.
  // limiter likewise: /health serves its stats (rate, holds, waits).
  // refreshTF likewise: the timeframe ranking and live-first order (A2) are
  // sweep wiring that a test drives with an injected queue observer.
  return {
    state: state, TFS: TFS, start: start, stop: stop,
    refreshCtxs: refreshCtxs, loadUniverse: loadUniverse,
    refreshMids: refreshMids, trueUp15m: trueUp15m,
    sampleScores: sampleScores, startTimers: startTimers,
    refreshTF: refreshTF, ledger: ledger, limiter: limiter,
    newBatch: enqueue.newBatch, queuePending: enqueue.pending,
    // Candle feed (stage 1): the push handler, the timer tick, the
    // reconciliation pass and the /health block are exported so tests
    // drive them with an injected feed stub and an injected clock.
    feed: feed, applyFeedBar: applyFeedBar, barRollTick: barRollTick,
    reconcileFeed: reconcileFeed, feedHealth: feedHealth,
    // Stage 2: the REST slot writer and the higher-timeframe rollup are
    // exported so tests build REST-shaped slots and drive the fold directly.
    setCandles: setCandles, rollupHigher: rollupHigher
  };
}

module.exports = { createLoop, TFS, HIGHER, splitClosedBars, makeQueue, tfRank, hasLiveSignal, TRUEUP_YIELD_PENDING, rollBatchKey, ROLL_BATCH_MS, FEED_RECONCILE_MS, FEED_BOOT_PASS_MS };
