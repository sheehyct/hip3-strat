"use strict";

// Regression tests for the code review of the continuity ledger. Each test
// is the review's own reproduction vector; every one FAILED before the
// fix. Scratch dirs under the OS tmpdir; node builtins only.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { createContinuityLedger } = require("../src/continuity_ledger.js");
const { createRequestHandler } = require("../server.js");

const T = 1790078460000;                       // 2026-09-22T12:01:00Z
const TFS = ["15m", "1h", "4h", "1d"];
const U = "uuuuu1uuuu1", D = "ddddd1dddd1";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hip3-continuity-audit-"));
}
function key(t, enc, boot) {
  return JSON.stringify({ t: t, v: 1, k: 1, boot: boot || "a", tfs: TFS, c: { BTC: enc } });
}
function delta(t, c) { return JSON.stringify({ t: t, v: 1, c: c }); }

// A reader-only ledger (empty roster) over pre-written lines; its boot
// keyframe lands at `now`, after everything queried.
async function reader(dir, now, extra) {
  const l = createContinuityLedger(Object.assign({
    dir: dir, state: { order: [], coins: {} }, ftfcTfs: TFS, bootId: "reader",
    now: function () { return now; }
  }, extra || {}));
  await l.start();
  l.stop();
  return l;
}
async function at(l, t, coin) { return (await l.continuityAt([{ coin: coin || "BTC", t: t }]))[0]; }

function slot(dir, analyzed) {
  const c = dir === "up" ? 101 : (dir === "down" ? 99 : 100);
  const s = { closed: [{ t: 1, o: 99, h: 101, l: 98, c: 100 }],
              forming: { t: 2, T: 3, o: 100, h: 103, l: 97, c: c, v: 1 } };
  if (analyzed !== false) {
    s.an = { types: ["2U"], formingType: "2U", formingDir: dir, completed: null,
             setups: [], invalidated: false, live: [] };
  }
  return s;
}
function btcState(dir) {
  const tf = {};
  ["15m", "1h", "4h", "1d"].forEach(function (id) { tf[id] = slot(dir); });
  ["1w", "1M"].forEach(function (id) { tf[id] = slot(dir, false); });
  return { order: ["BTC"], coins: { BTC: { name: "BTC", sym: "BTC", uni: "perps", mid: 100, hist: [], ctx: {}, tf: tf } } };
}
function setDir(state, dir) {
  Object.assign(state.coins.BTC.tf, btcState(dir).coins.BTC.tf);
}

// --- F1 HIGH ---------------------------------------------------------------

test("F1: a corrupt line is a coverage break - no tick's state is carried across it", async function () {
  const dir = scratch();
  const lost = delta(T + 30000, { BTC: D }).slice(0, -2);        // truncated JSON
  fs.writeFileSync(path.join(dir, "continuity-2026-09-22.jsonl"),
    [key(T, U), lost, delta(T + 60000, {}), key(T + 90000, D)].join("\n") + "\n");
  const l = await reader(dir, T + 120000);
  const across = await at(l, T + 60000);
  assert.strictEqual(across.covered, false, "the audit vector: was covered:true, ftfc up");
  assert.strictEqual((await at(l, T + 45000)).covered, false);
  const onTick = await at(l, T);
  assert.strictEqual(onTick.covered, true, "t exactly on the last valid tick stays covered");
  assert.strictEqual(onTick.ftfc, "up");
  const recovered = await at(l, T + 90000);
  assert.strictEqual(recovered.covered, true, "a same-boot keyframe restores coverage");
  assert.strictEqual(recovered.ftfc, "down");
});

test("F1: the same break holds when the day is read back from its gzip", async function () {
  const dir = scratch();
  const lost = delta(T + 30000, { BTC: D }).slice(0, -2);
  fs.writeFileSync(path.join(dir, "continuity-2026-09-22.jsonl"),
    [key(T, U), lost, delta(T + 60000, {}), key(T + 90000, D)].join("\n") + "\n");
  // A reader on the NEXT day gzips the past raw file at boot, then decodes it cold.
  const l = await reader(dir, Date.UTC(2026, 8, 23, 0, 0, 30));
  assert.ok(fs.existsSync(path.join(dir, "continuity-2026-09-22.jsonl.gz")));
  assert.strictEqual((await at(l, T + 60000)).covered, false);
  assert.strictEqual((await at(l, T)).covered, true);
});

test("F1: a corrupt line opening the next day breaks coverage from the previous day's last tick", async function () {
  const dir = scratch();
  const late = Date.UTC(2026, 8, 22, 23, 59, 50);
  fs.writeFileSync(path.join(dir, "continuity-2026-09-22.jsonl"), key(late, U) + "\n");
  fs.writeFileSync(path.join(dir, "continuity-2026-09-23.jsonl"),
    ["{garbage", key(Date.UTC(2026, 8, 23, 0, 0, 20), D)].join("\n") + "\n");
  const l = await reader(dir, Date.UTC(2026, 8, 23, 0, 5, 0));
  assert.strictEqual((await at(l, Date.UTC(2026, 8, 23, 0, 0, 10))).covered, false);
  assert.strictEqual((await at(l, late)).covered, true);
});

// --- F2 HIGH (and F7 LOW) --------------------------------------------------

test("F2: an encoding inconsistent with its keyframe's declared tfs is not certified", async function () {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, "continuity-2026-09-22.jsonl"), key(T, "uuuu1uuuu1") + "\n");
  const l = await reader(dir, T + 60000);
  const r = await at(l, T);
  assert.strictEqual(r.covered, false, "the audit vector: was covered:true with THREE dots");
});

test("F2: a keyframe without tfs, or a delta that breaks the declared shape, vouches for nothing", async function () {
  const dir = scratch();
  const noTfs = JSON.stringify({ t: T, v: 1, k: 1, boot: "a", c: { BTC: U } });
  fs.writeFileSync(path.join(dir, "continuity-2026-09-22.jsonl"), noTfs + "\n");
  assert.strictEqual((await at(await reader(dir, T + 60000), T)).covered, false);

  const dir2 = scratch();
  fs.writeFileSync(path.join(dir2, "continuity-2026-09-22.jsonl"),
    [key(T, U), delta(T + 30000, { BTC: "uuuuuu1uuuu1" })].join("\n") + "\n");
  const l2 = await reader(dir2, T + 90000);
  assert.strictEqual((await at(l2, T + 30000)).covered, false, "a 5-dot delta under a 4-TF keyframe");
  assert.strictEqual((await at(l2, T)).covered, true);
});

test("F7: an empty FTFC set records and answers dots [] consistently", async function () {
  const dir = scratch();
  const state = btcState("up");
  const l = createContinuityLedger({ dir: dir, state: state, ftfcTfs: [], bootId: "a",
                                     now: function () { return T; } });
  await l.start();
  l.stop();
  const r = await at(l, T);
  assert.strictEqual(r.covered, true, "was not covered: decode refused its own 7-char encoding");
  assert.deepStrictEqual(r.dots, []);
  assert.strictEqual(r.ftfc, "mixed");
  assert.strictEqual(l.health().lastError, null);
});

// --- F3 MED ----------------------------------------------------------------

test("F3: a partial append is fenced - the recovery keyframe survives a restart", async function (t) {
  const dir = scratch();
  const clock = { t: T };
  const state = btcState("up");
  const a = createContinuityLedger({ dir: dir, state: state, ftfcTfs: TFS, bootId: "a",
                                     now: function () { return clock.t; } });
  await a.start();
  a.stop();
  setDir(state, "down");
  const orig = fs.promises.appendFile;
  fs.promises.appendFile = async function (file, out) {
    fs.promises.appendFile = orig;                                // one shot
    await orig(file, out.slice(0, Math.floor(out.length / 2)));
    throw new Error("injected partial append");
  };
  t.after(function () { fs.promises.appendFile = orig; });
  await a.tickOnce(T + 30000);
  assert.ok(/partial append/.test(a.health().lastError));
  await a.tickOnce(T + 60000);
  await a.tickOnce(T + 90000);
  assert.strictEqual(a.health().lastError, null);
  assert.strictEqual(a.health().dayBytes, fs.statSync(path.join(dir, "continuity-2026-09-22.jsonl")).size,
    "dayBytes re-counted from disk, partial bytes included");

  clock.t = T + 100000;
  const before = await at(a, T + 60000);
  const gapBefore = await at(a, T + 45000);
  const b = await reader(dir, T + 120000);
  const after = await at(b, T + 60000);
  assert.strictEqual(before.covered, true);
  assert.strictEqual(before.ftfc, "down");
  assert.deepStrictEqual(after, before, "the audit vector: was not covered after restart");
  assert.strictEqual(gapBefore.covered, false, "the failed tick's span is a break, live");
  assert.strictEqual((await at(b, T + 45000)).covered, false, "and the same break after restart");
});

// --- F4 MED ----------------------------------------------------------------

test("F4: a clock step back across midnight is refused and never rewrites the archive", async function () {
  const dir = scratch();
  const clock = { t: Date.UTC(2026, 8, 22, 23, 59, 40) };
  const state = btcState("up");
  const l = createContinuityLedger({ dir: dir, state: state, ftfcTfs: TFS, bootId: "a",
                                     now: function () { return clock.t; } });
  await l.start();
  l.stop();
  setDir(state, "down");
  await l.tickOnce(Date.UTC(2026, 8, 23, 0, 0, 10));
  setDir(state, "flat");
  await l.tickOnce(Date.UTC(2026, 8, 22, 23, 59, 55));         // the step back
  assert.ok(/behind the newest recorded tick/.test(l.health().lastError));
  assert.strictEqual(l.health().errors, 1);
  await l.tickOnce(Date.UTC(2026, 8, 23, 0, 0, 25));
  assert.ok(!fs.existsSync(path.join(dir, "continuity-2026-09-22.jsonl")), "no raw file reopened for yesterday");
  const archive = zlib.gunzipSync(fs.readFileSync(path.join(dir, "continuity-2026-09-22.jsonl.gz"))).toString();
  assert.ok(archive.indexOf('"t":' + Date.UTC(2026, 8, 22, 23, 59, 40)) >= 0, "the 23:59:40 record survives");
  clock.t = Date.UTC(2026, 8, 23, 0, 1, 0);
  const r = await at(l, Date.UTC(2026, 8, 22, 23, 59, 40));
  assert.strictEqual(r.covered, true, "the audit vector: was not covered, archive replaced");
  assert.strictEqual(r.ftfc, "up");
});

test("F4: a process that boots with its clock behind recorded history cannot write", async function () {
  const dir = scratch();
  const state = btcState("up");
  const a = createContinuityLedger({ dir: dir, state: state, ftfcTfs: TFS, bootId: "a",
                                     now: function () { return Date.UTC(2026, 8, 23, 0, 0, 10); } });
  await a.start();
  a.stop();
  const b = createContinuityLedger({ dir: dir, state: state, ftfcTfs: TFS, bootId: "b",
                                     now: function () { return Date.UTC(2026, 8, 22, 23, 59, 50); } });
  await b.start();
  b.stop();
  assert.ok(/behind the newest recorded tick/.test(b.health().lastError));
  assert.ok(!fs.existsSync(path.join(dir, "continuity-2026-09-22.jsonl")));
});

test("F4: compressing onto an existing archive merges, never overwrites", async function () {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, "continuity-2026-09-22.jsonl.gz"), zlib.gzipSync(key(T, U) + "\n"));
  fs.writeFileSync(path.join(dir, "continuity-2026-09-22.jsonl"), key(T + 600000, D) + "\n");
  const l = await reader(dir, Date.UTC(2026, 8, 23, 0, 5, 0));
  const text = zlib.gunzipSync(fs.readFileSync(path.join(dir, "continuity-2026-09-22.jsonl.gz"))).toString();
  assert.ok(text.indexOf('"t":' + T + ",") >= 0 && text.indexOf('"t":' + (T + 600000) + ",") >= 0);
  assert.strictEqual((await at(l, T)).ftfc, "up");
});

// --- F5 MED ----------------------------------------------------------------

test("F5: cold-decoding a worst-case day never holds the event loop for long", async function () {
  const dir = scratch();
  const names = [];
  for (let i = 0; i < 286; i++) names.push("xyz:SYNTH" + String(i).padStart(3, "0"));
  const day0 = Date.UTC(2026, 8, 22);
  const lines = [];
  for (let k = 0; k < 2880; k++) {
    const t = day0 + k * 30000, c = {};
    names.forEach(function (n) { c[n] = k % 2 ? D : U; });
    lines.push(k % 30 === 0 ? JSON.stringify({ t: t, v: 1, k: 1, boot: "a", tfs: TFS, c: c })
                            : JSON.stringify({ t: t, v: 1, c: c }));
  }
  const l = await reader(dir, Date.UTC(2026, 8, 23, 0, 1, 0));
  // Written AFTER boot so the boot-time scans cannot have decoded it: the
  // timed lookup below is the cold decode.
  fs.writeFileSync(path.join(dir, "continuity-2026-09-22.jsonl.gz"), zlib.gzipSync(lines.join("\n") + "\n"));
  let last = performance.now(), maxGap = 0, running = true;
  const timer = setInterval(function () {
    const n = performance.now();
    maxGap = Math.max(maxGap, n - last);
    last = n;
    if (!running) clearInterval(timer);
  }, 1);
  const r = await at(l, day0 + 1000 * 30000, "xyz:SYNTH100");
  // The last synchronous slice ends right before the lookup resolves, so the
  // timer must fire once more AFTER it or that slice is never measured (the
  // first version of this test missed the whole pre-fold block that way).
  await new Promise(function (res) { setTimeout(res, 30); });
  running = false;
  assert.strictEqual(r.covered, true);
  assert.ok(maxGap < 80,"max event-loop gap " + maxGap.toFixed(1) + " ms (244 ms before the fold)");
});

// --- F6 MED ----------------------------------------------------------------

test("F6: admission is bounded, a deadline fires, a cancelled request stops before its next item", async function (t) {
  const dir = scratch();
  const l = await reader(dir, T, { maxQueue: 2, requestTimeoutMs: 200 });
  // Written AFTER boot so no boot-time scan has cached it: the lookup must read it.
  const t20 = T - 2 * 86400000;
  fs.writeFileSync(path.join(dir, "continuity-2026-09-20.jsonl.gz"), zlib.gzipSync(key(t20, U) + "\n"));
  // Hold the next storage read, like a stalled volume.
  const orig = fs.promises.readFile;
  let release = null;
  fs.promises.readFile = function () {
    const args = Array.prototype.slice.call(arguments);
    fs.promises.readFile = orig;
    return new Promise(function (resolve, reject) {
      release = function () { orig.apply(fs.promises, args).then(resolve, reject); };
    });
  };
  t.after(function () { fs.promises.readFile = orig; });
  const q = [{ coin: "BTC", t: t20 }];
  const first = l.continuityAt(q).catch(function (e) { return e; });
  const second = l.continuityAt(q).catch(function (e) { return e; });
  await assert.rejects(l.continuityAt(q), function (e) { return e.code === "busy"; }, "third request refused");
  assert.strictEqual(l.health().busyRefused, 1);
  const e1 = await first;
  assert.strictEqual(e1.code, "timeout", "the held request hits its deadline");
  assert.ok(release, "the lookup really reached storage");
  release();
  const e2 = await second;
  assert.strictEqual(e2.code, "timeout", "the waiting request's deadline passed too");
  // Slots free once the stopped work unwinds; a cancelled request stops early.
  await new Promise(function (r) { setTimeout(r, 20); });
  assert.strictEqual(l.health().queued, 0);
  await assert.rejects(l.continuityAt(q, { isCancelled: function () { return true; } }),
    function (e) { return e.code === "cancelled"; });
  const ok = await l.continuityAt(q);
  assert.strictEqual(ok[0].covered, true, "the queue works again after the stall clears");
  assert.strictEqual(ok[0].ftfc, "up");
});

test("F6: the route answers overload with 503 + Retry-After, never 500", async function () {
  const fake = {
    continuityAt: function () { const e = new Error("full"); e.code = "busy"; return Promise.reject(e); },
    health: function () { return {}; }, summary: function () { return {}; }
  };
  const handler = createRequestHandler({
    loop: { state: { order: [], coins: {}, loaded: true, universes: ["xyz"] } },
    rules: { alertsFired: function () { return 0; } },
    push: { count: function () { return 0; }, stats: function () { return {}; } },
    config: { ftfcTfs: TFS }, continuity: fake
  });
  const http = require("node:http");
  const server = http.createServer(handler);
  await new Promise(function (r) { server.listen(0, "127.0.0.1", r); });
  try {
    const res = await fetch("http://127.0.0.1:" + server.address().port + "/api/continuity_at",
      { method: "POST", body: JSON.stringify([{ coin: "BTC", t: T }]) });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers.get("retry-after"), "5");
    assert.deepStrictEqual(await res.json(), { error: "busy" });
  } finally {
    await new Promise(function (r) { server.close(r); });
  }
});
