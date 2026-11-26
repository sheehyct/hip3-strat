"use strict";

// Roster recovery via the ctx refresh (loop.js refreshCtxs): a universe whose
// boot enumeration failed, or a coin listed mid-flight, must be REGISTERED on
// the next 60s ctx cycle rather than waiting for a redeploy. Motivated by the
// 2026-08-07 incident: a single HTTP 429 on the xyz metaAndAssetCtxs at boot
// left the worker perps-only - and, with alerting configured for xyz, silent -
// until a manual restart.

const test = require("node:test");
const assert = require("node:assert");
const { createLoop } = require("../src/loop.js");

const realFetch = globalThis.fetch;

function ctxOf(mid) { return { midPx: String(mid), markPx: String(mid) }; }

// Queue of metaAndAssetCtxs payloads, one consumed per POST, FIFO.
function stubFetch(payloads) {
  const calls = [];
  globalThis.fetch = async function (url, opts) {
    calls.push(JSON.parse(opts.body));
    const body = payloads.shift();
    if (!body) throw new Error("fetch stub exhausted");
    return { status: 200, ok: true, json: async function () { return body; } };
  };
  return calls;
}

test.afterEach(function () { globalThis.fetch = realFetch; });

test("refreshCtxs registers unknown allowed coins (boot-miss recovery)", async function () {
  const logs = [];
  const loop = createLoop(
    { coins: { block: ["BAD"] } },
    { universes: [{ id: "xyz", dex: "xyz" }], log: function (m) { logs.push(m); } }
  );
  const calls = stubFetch([
    [
      { universe: [
        { name: "xyz:NVDA" },
        { name: "xyz:OLD", isDelisted: true },
        { name: "xyz:BAD" }
      ] },
      [ctxOf(100), ctxOf(1), ctxOf(2)]
    ]
  ]);
  // Simulates the incident state: enumeration never happened for this
  // universe (order empty), timers would drive the 60s ctx cycle.
  await loop.refreshCtxs();
  assert.deepStrictEqual(loop.state.order, ["xyz:NVDA"], "allowed coin registered; delisted + blocked skipped");
  const c = loop.state.coins["xyz:NVDA"];
  assert.strictEqual(c.uni, "xyz");
  assert.strictEqual(c.sym, "NVDA");
  assert.strictEqual(c.mid, 100);
  assert.ok(c.ctx, "ctx attached at registration");
  assert.deepStrictEqual(c.tf, {}, "tf empty - the stale-slot recovery timer backfills candles");
  assert.ok(logs.some(function (m) { return /registered 1 coins on ctx refresh/.test(m); }),
    "recovery is visible in the worker log");
  assert.deepStrictEqual(calls[0], { type: "metaAndAssetCtxs", dex: "xyz" });
});

// maxLeverage capture. It rides the SAME ctx path as roster recovery, which is
// why it is tested here. The value comes off the metaAndAssetCtxs META entry
// (d[0].universe[i]) while every other field the worker keeps comes off the
// parallel ctx array (d[1][i]) - two arrays of the same length, so reading the
// wrong one yields undefined rather than an error.

function levLoop() {
  return createLoop(
    { coins: {} },
    { universes: [{ id: "xyz", dex: "xyz" }], log: function () {} }
  );
}

test("ctx refresh captures maxLeverage off the meta entry", async function () {
  const loop = levLoop();
  stubFetch([
    [{ universe: [{ name: "xyz:NVDA", maxLeverage: 20 }] }, [ctxOf(100)]]
  ]);
  await loop.refreshCtxs();
  assert.strictEqual(loop.state.coins["xyz:NVDA"].maxLeverage, 20);
});

// The BOOT enumeration is a separate code path from the 60s refresh, and the
// two register coins differently. Coins entering by one route must not carry a
// different field set from coins entering by the other - that asymmetry is
// exactly what produced the ftfc_flip baseline regression (review F2), where a
// recovery-registered coin reached the running loop in a shape no coin had
// ever been in before.
test("boot enumeration captures maxLeverage on the same terms as the refresh", async function () {
  const loop = levLoop();
  stubFetch([
    [{ universe: [
      { name: "xyz:NVDA", maxLeverage: 20 },
      { name: "xyz:GONE", maxLeverage: 5, isDelisted: true },
      { name: "xyz:NOLEV" }
    ] }, [ctxOf(100), ctxOf(1), ctxOf(2)]]
  ]);
  await loop.loadUniverse();
  assert.deepStrictEqual(loop.state.order, ["xyz:NVDA", "xyz:NOLEV"]);
  assert.strictEqual(loop.state.coins["xyz:NVDA"].maxLeverage, 20,
    "a coin must carry its cap from boot, not wait for the first 60s cycle");
  assert.strictEqual(loop.state.coins["xyz:NOLEV"].maxLeverage, null);
});

// THE ONE THAT MATTERS. maxLeverage is a mutable venue property: Hyperliquid
// can change an asset's cap. refreshCtxsOnce sets most coin fields only inside
// the registration branch and re-assigns ctx every cycle for every coin, so
// writing maxLeverage in the wrong place freezes it at its first-seen value
// forever - and a frozen leverage cap still looks like a perfectly ordinary
// number, so nothing would ever surface it.
test("ctx refresh REFRESHES maxLeverage on an already-known coin", async function () {
  const loop = levLoop();
  stubFetch([
    [{ universe: [{ name: "xyz:NVDA", maxLeverage: 20 }] }, [ctxOf(100)]],
    [{ universe: [{ name: "xyz:NVDA", maxLeverage: 10 }] }, [ctxOf(101)]]
  ]);
  await loop.refreshCtxs();
  assert.strictEqual(loop.state.coins["xyz:NVDA"].maxLeverage, 20, "first cycle");
  await loop.refreshCtxs();
  assert.strictEqual(loop.state.coins["xyz:NVDA"].maxLeverage, 10,
    "the venue lowered the cap - a coin registered earlier must follow it down");
  assert.strictEqual(loop.state.order.length, 1, "refresh must not re-register");
});

// Unknown must stay unknown. Number(null) and Number("") are both 0, so a
// naive coercion turns a missing cap into a real-looking 0x that a
// "max leverage >= 10x" filter would act on as though the venue had spoken.
test("ctx refresh maps a missing or nonsensical maxLeverage to null, not 0", async function () {
  const loop = levLoop();
  stubFetch([
    [{ universe: [
      { name: "xyz:A" },                      // field absent
      { name: "xyz:B", maxLeverage: null },
      { name: "xyz:C", maxLeverage: 0 },
      { name: "xyz:D", maxLeverage: "" },
      { name: "xyz:E", maxLeverage: -5 },
      { name: "xyz:F", maxLeverage: "20" }    // string digits are a real value
    ] }, [ctxOf(1), ctxOf(2), ctxOf(3), ctxOf(4), ctxOf(5), ctxOf(6)]]
  ]);
  await loop.refreshCtxs();
  const lev = function (s) { return loop.state.coins["xyz:" + s].maxLeverage; };
  ["A", "B", "C", "D", "E"].forEach(function (s) {
    assert.strictEqual(lev(s), null, s + " must be null (unknown), not 0");
  });
  assert.strictEqual(lev("F"), 20, "a numeric string is still a real cap");
});

// Overlap guard. Without it the 60s interval can fire while a cycle is still
// in flight (post()'s network-error path alone is 4 attempts x a 15s timeout
// plus 1s/2s/4s backoff = 67s per call, and universes are awaited
// sequentially). Two invocations cannot double-register, but the OLDER
// response completes LAST and wins - reproduced pre-fix as order
// [KEEP, NEW, STALE] against an expected roster of [KEEP, STALE], with
// KEEP's ctx regressed from 200 back to 100 and lastContextsByUni stamped
// forward, marking the stale data freshest (code review 2026-08-07).
function deferredCtxFetch(payloadsByCall, delaysByCall) {
  const calls = [];
  globalThis.fetch = async function (url, opts) {
    const n = calls.push(JSON.parse(opts.body));
    await new Promise(function (r) { setTimeout(r, delaysByCall[n - 1]); });
    return { status: 200, ok: true, json: async function () { return payloadsByCall[n - 1]; } };
  };
  return calls;
}

test("refreshCtxs does not overlap: a tick landing mid-cycle is skipped", async function () {
  const logs = [];
  const loop = createLoop({}, {
    universes: [{ id: "xyz", dex: "xyz" }],
    log: function (m) { logs.push(m); }
  });
  const calls = deferredCtxFetch([
    [{ universe: [{ name: "xyz:KEEP" }, { name: "xyz:STALE" }] }, [ctxOf(100), ctxOf(9)]],
    [{ universe: [{ name: "xyz:KEEP" }, { name: "xyz:NEW" }] }, [ctxOf(200), ctxOf(7)]]
  ], [60, 5]);

  const slow = loop.refreshCtxs();
  await new Promise(function (r) { setTimeout(r, 10); });
  await loop.refreshCtxs();   // the next 60s tick, arriving mid-cycle
  await slow;

  assert.strictEqual(calls.length, 1, "the overlapping tick issued no request");
  assert.ok(logs.some(function (m) { return /ctx refresh skipped/.test(m); }),
    "the skip is visible in the worker log");
  assert.deepStrictEqual(loop.state.order, ["xyz:KEEP", "xyz:STALE"],
    "no coin registered from a roster that never arrived");
  assert.strictEqual(loop.state.coins["xyz:KEEP"].ctx.midPx, "100",
    "ctx reflects the cycle that actually ran");
});

test("refreshCtxs releases the guard so the following cycle runs", async function () {
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }] });
  const calls = deferredCtxFetch([
    [{ universe: [{ name: "xyz:KEEP" }] }, [ctxOf(100)]],
    [{ universe: [{ name: "xyz:KEEP" }, { name: "xyz:NEW" }] }, [ctxOf(200), ctxOf(7)]]
  ], [20, 0]);
  await loop.refreshCtxs();
  await loop.refreshCtxs();
  assert.strictEqual(calls.length, 2, "guard released after the first cycle settled");
  assert.deepStrictEqual(loop.state.order, ["xyz:KEEP", "xyz:NEW"]);
  assert.strictEqual(loop.state.coins["xyz:KEEP"].ctx.midPx, "200", "newest ctx applied");
});

test("refreshCtxs registers only NEW listings and leaves tracked coins intact", async function () {
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }] });
  stubFetch([
    [{ universe: [{ name: "xyz:NVDA" }] }, [ctxOf(100)]],
    [{ universe: [{ name: "xyz:NVDA" }, { name: "xyz:TSLA" }] }, [ctxOf(101), ctxOf(200)]]
  ]);
  await loop.refreshCtxs();
  // Tracked coin accrues live state between cycles; none of it may be reset.
  const nvda = loop.state.coins["xyz:NVDA"];
  const tfSentinel = { closed: [{ t: 1 }], forming: null };
  nvda.tf["1h"] = tfSentinel;
  nvda.mid = 555; // the 4s mids poll owns mid after registration
  await loop.refreshCtxs();
  assert.deepStrictEqual(loop.state.order, ["xyz:NVDA", "xyz:TSLA"], "new listing appended");
  assert.strictEqual(nvda.tf["1h"], tfSentinel, "candle slots untouched");
  assert.strictEqual(nvda.mid, 555, "mid not overwritten on refresh");
  assert.strictEqual(nvda.ctx.midPx, "101", "ctx refreshed as before");
  assert.strictEqual(loop.state.coins["xyz:TSLA"].mid, 200, "new coin seeded with roster mid");
});

// ---- Roster REMOVAL (code review 2026-08-14) ----
// Before this, state.order was append-only outside boot - loop.js's own
// comment admitted "such a coin persists until restart". The first real
// delisting would strand a frozen row in /api/state and flip the briefing to
// data_complete:false PERMANENTLY (expected drops the coin next cycle, rows
// keep serving it) until a manual restart.

test("ctx refresh REMOVES a coin the roster no longer advertises", async function () {
  const removedBatches = [];
  const logs = [];
  const loop = createLoop({}, {
    universes: [{ id: "xyz", dex: "xyz" }],
    log: function (m) { logs.push(m); },
    onRemove: function (names) { removedBatches.push(names); }
  });
  stubFetch([
    [{ universe: [{ name: "xyz:KEEP" }, { name: "xyz:GONE" }] }, [ctxOf(1), ctxOf(2)]],
    [{ universe: [{ name: "xyz:KEEP" }] }, [ctxOf(3)]]
  ]);
  await loop.refreshCtxs();
  assert.deepStrictEqual(loop.state.order, ["xyz:KEEP", "xyz:GONE"]);
  await loop.refreshCtxs();
  assert.deepStrictEqual(loop.state.order, ["xyz:KEEP"], "dropped from order");
  assert.strictEqual(loop.state.coins["xyz:GONE"], undefined, "dropped from the coin map");
  assert.deepStrictEqual(removedBatches, [["xyz:GONE"]], "onRemove told the rule engine");
  assert.ok(logs.some(function (m) { return /removed 1 coins no longer advertised/.test(m); }),
    "removal is visible in the worker log");
  assert.deepStrictEqual(loop.state.expectedMarketsByUni.xyz, ["xyz:KEEP"],
    "expected set and tracked set AGREE - the briefing data_complete failure is closed");
});

test("a delisted flag removes like a dropped row; a re-list registers FRESH", async function () {
  const loop = createLoop({}, {
    universes: [{ id: "xyz", dex: "xyz" }], onRemove: function () {}
  });
  stubFetch([
    [{ universe: [{ name: "xyz:X" }] }, [ctxOf(1)]],
    [{ universe: [{ name: "xyz:X", isDelisted: true }] }, [ctxOf(1)]],
    [{ universe: [{ name: "xyz:X" }] }, [ctxOf(9)]]
  ]);
  await loop.refreshCtxs();
  loop.state.coins["xyz:X"].tf["1h"] = { closed: [{ t: 1 }], forming: null }; // accrued state
  await loop.refreshCtxs();
  assert.strictEqual(loop.state.coins["xyz:X"], undefined, "delisted flag = removed");
  await loop.refreshCtxs();
  const back = loop.state.coins["xyz:X"];
  assert.ok(back, "re-listed name registers again");
  assert.deepStrictEqual(back.tf, {},
    "as a NEW listing - no stale candle slots (the SPCX ticker-reuse class)");
  assert.strictEqual(back.mid, 9, "seeded from the re-list roster, not the old market");
});

test("an EMPTY advertised roster is an anomaly: removal skipped, not a mass delist", async function () {
  const logs = [];
  const removed = [];
  const loop = createLoop({}, {
    universes: [{ id: "xyz", dex: "xyz" }],
    log: function (m) { logs.push(m); },
    onRemove: function (names) { removed.push.apply(removed, names); }
  });
  stubFetch([
    [{ universe: [{ name: "xyz:KEEP" }] }, [ctxOf(1)]],
    [{ universe: [] }, []],
    [{ universe: [{ name: "xyz:KEEP" }] }, [ctxOf(2)]]
  ]);
  await loop.refreshCtxs();
  await loop.refreshCtxs();   // anomalous empty response
  assert.deepStrictEqual(loop.state.order, ["xyz:KEEP"], "nothing removed on an empty roster");
  assert.deepStrictEqual(removed, []);
  assert.ok(logs.some(function (m) { return /EMPTY - skipping removal/.test(m); }));
  await loop.refreshCtxs();
  assert.strictEqual(loop.state.coins["xyz:KEEP"].ctx.midPx, "2", "normal cycles resume");
});

test("removal is scoped to the responding universe (multi-universe safety)", async function () {
  const loop = createLoop({}, {
    universes: [{ id: "xyz", dex: "xyz" }, { id: "perps", dex: null }],
    onRemove: function () {}
  });
  stubFetch([
    [{ universe: [{ name: "xyz:A" }] }, [ctxOf(1)]],   // cycle 1: xyz
    [{ universe: [{ name: "BTC" }] }, [ctxOf(2)]],     // cycle 1: perps
    [{ universe: [{ name: "xyz:B" }] }, [ctxOf(3)]],   // cycle 2: xyz drops A, lists B
    [{ universe: [{ name: "BTC" }] }, [ctxOf(4)]]      // cycle 2: perps unchanged
  ]);
  await loop.refreshCtxs();
  assert.deepStrictEqual(loop.state.order, ["xyz:A", "BTC"]);
  await loop.refreshCtxs();
  assert.deepStrictEqual(loop.state.order.slice().sort(), ["BTC", "xyz:B"]);
  assert.strictEqual(loop.state.coins["xyz:A"], undefined, "xyz's drop removed");
  assert.ok(loop.state.coins["BTC"], "the other universe's coin untouched");
});

test("the loop revision starts at 0 and advances on a successful ctx cycle", async function () {
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }] });
  assert.strictEqual(loop.state.revision, 0);
  stubFetch([[{ universe: [{ name: "xyz:NVDA" }] }, [ctxOf(100)]]]);
  await loop.refreshCtxs();
  assert.ok(loop.state.revision > 0, "ctx success bumped the revision");
});

test("a FAILED refresh removes nothing (removal acts only on a successful response)", async function () {
  const loop = createLoop({}, {
    universes: [{ id: "xyz", dex: "xyz" }],
    onRemove: function () { throw new Error("onRemove must not be called on a failed cycle"); }
  });
  stubFetch([
    [{ universe: [{ name: "xyz:KEEP" }] }, [ctxOf(1)]]
  ]);
  await loop.refreshCtxs();
  // HTTP 400 is non-retryable in post(), so the cycle fails fast and cleanly.
  globalThis.fetch = async function () {
    return { status: 400, ok: false, json: async function () { return {}; } };
  };
  await loop.refreshCtxs();
  assert.deepStrictEqual(loop.state.order, ["xyz:KEEP"], "tracked roster intact after a failed cycle");
});
