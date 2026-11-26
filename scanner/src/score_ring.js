"use strict";

// In-memory ring of SERVED heat scores per coin, powering the additive
// per-coin `scoreDelta` field in /api/state.
//
// WHAT IS SAMPLED: the post-readiness-gate score /api/state serializes,
// computed through apistate.servedScore - the exact exported path the
// payload builder uses, never a lookalike. The one recorder this repo
// shipped that forked from the server needed a parity repair; the rows handed to
// recordSample are produced by that shared path in src/loop.js, and
// test/loop_scoredelta.test.js pins sampled === served.
//
// MEMORY ONLY, restart-honest by design: no volume writes, no
// persistence. After a restart every window is null until it refills -
// null means unknown, never zero (house convention). Bounded two ways:
// DEPTH samples per coin, and a coin the roster drops is evicted on the
// next sample.
//
// Three-way split: the score NETS opposing
// evidence, so one generic delta cannot describe a move. -80 -> +20 is
// +100 signed, -60 in magnitude (both endpoints LESS extreme), and a
// bearish-to-bullish flip - three distinct facts, three fields - plus
// the rank move within the coin's own universe.

const GRAIN_MS = 30000;   // sample cadence; src/loop.js's timer reads THIS
                          // constant, so grain and window math cannot drift
const DEPTH = 121;        // 121 samples = 120 x 30s INTERVALS = exactly 1h of
                          // reach. At 120 the ring spanned 3570s and h1 could
                          // never strictly qualify (review): the fix is one
                          // more sample, not a softer window rule.

// Window spans. "Then" is the NEWEST sample at least this much older
// than the newest sample; a window the ring cannot yet cover (boot,
// restart) is null.
const WINDOW_MS = { m5: 300000, m15: 900000, h1: 3600000 };

// Record one sampling pass. `rows` is [{name, uni, score}] for the FULL
// current roster - a null score records as null (an unready coin's
// history is real history, and a later window with a null endpoint must
// come out null, not fabricated). Ranks are computed HERE, at sample
// time, because a rank is a fact about the roster at that instant:
// 1-based position ordered by score descending among coins of the SAME
// universe with non-null scores at this sample. Ties keep roster order
// (Array.prototype.sort is stable). A null-score coin carries rank
// null - unknowable, never last place.
function recordSample(store, rows, now) {
  const groups = new Map();   // uni -> rows with a real score
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // Finite-or-null at the source (the finite-or-null convention): a NaN that
    // slipped through the pipeline is an unknown and must rank as one.
    if (!Number.isFinite(r.score)) continue;
    if (!groups.has(r.uni)) groups.set(r.uni, []);
    groups.get(r.uni).push(r);
  }
  const rank = new Map();     // name -> 1-based rank within its universe
  groups.forEach(function (list) {
    list.sort(function (a, b) { return b.score - a.score; });
    for (let i = 0; i < list.length; i++) rank.set(list[i].name, i + 1);
  });
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    seen.add(r.name);
    let arr = store[r.name];
    if (!arr) arr = store[r.name] = [];
    arr.push({
      t: now,
      score: Number.isFinite(r.score) ? r.score : null,
      rank: rank.has(r.name) ? rank.get(r.name) : null
    });
    while (arr.length > DEPTH) arr.shift();
  }
  // Roster eviction: a coin the loop no longer tracks drops its ring. A
  // re-listed name starts fresh - months-old samples must never seed a
  // "delta" for what may be a different market (the SPCX ticker-reuse
  // class).
  Object.keys(store).forEach(function (name) {
    if (!seen.has(name)) delete store[name];
  });
}

// One window between two ring samples. "Then" is the newest sample at
// least `span` older than the newest sample - the strict rule the task
// pins, with NO stand-in: at DEPTH 121 a full ring reaches exactly
// (DEPTH-1)*GRAIN_MS = 3600s, so h1 strictly qualifies the moment the
// ring is full (review retired the earlier one-grain concession by
// widening the ring instead of the rule). None qualifying -> null
// (window not yet filled since boot/restart).
function windowDelta(samples, span) {
  const nowS = samples[samples.length - 1];
  let then = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (nowS.t - samples[i].t >= span) { then = samples[i]; break; }
  }
  if (!then) return null;                                      // not filled yet
  if (then.score === null || nowS.score === null) return null; // endpoint unknown
  return {
    signed: nowS.score - then.score,
    mag: Math.abs(nowS.score) - Math.abs(then.score),
    flip: then.score < 0 && nowS.score > 0 ? "up"
        : then.score > 0 && nowS.score < 0 ? "down" : null,
    // rank_then - rank_now: positive = climbed. Both endpoints' ranks
    // were computed at sample time by the same rule; with both scores
    // non-null the ranks are non-null by construction, but the guard
    // keeps the field honest if that construction ever changes.
    rank: then.rank !== null && nowS.rank !== null ? then.rank - nowS.rank : null
  };
}

// The served scoreDelta for one coin: { m5, m15, h1 }, each either null
// or { signed, mag, flip, rank }. Total function: a missing store, an
// unknown coin, and an empty ring all serve the all-null shape, so the
// field is safely additive - consumers can ignore it entirely.
function scoreDelta(store, name) {
  const out = { m5: null, m15: null, h1: null };
  const samples = store ? store[name] : null;
  if (!samples || !samples.length) return out;
  Object.keys(WINDOW_MS).forEach(function (w) {
    out[w] = windowDelta(samples, WINDOW_MS[w]);
  });
  return out;
}

module.exports = { GRAIN_MS, DEPTH, WINDOW_MS, recordSample, scoreDelta };
