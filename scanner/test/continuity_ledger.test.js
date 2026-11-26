"use strict";

// Continuity checkpoint ledger: encoding, served parity, the writer's keyframe/delta rules,
// UTC rotation + retention, lookup coverage semantics, the HTTP route and
// error isolation. Scratch dirs under the OS tmpdir; injected clocks;
// node builtins only.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const {
  createContinuityLedger, encode, decode, RETENTION_DAYS
} = require("../src/continuity_ledger.js");
const { buildApiState, servedContinuity } = require("../src/apistate.js");
const { createRequestHandler } = require("../server.js");

const FTFC = ["15m", "1h", "4h", "1d"];
const MIN = 60000;

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hip3-continuity-test-"));
}

// A forming bar whose close-vs-open gives `dir`, plus the analyzer's
// formingDir - the two things the served continuity reads.
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

// dirs: {15m, 1h, 4h, 1d, 1w, 1M} -> "up" | "down" | "flat" | undefined
// (undefined = the slot is missing: an FTFC TF missing makes the coin
// unready; a missing 1w/1M makes dwm incomplete).
function mkCoin(name, dirs) {
  const tf = {};
  ["15m", "1h", "4h", "1d"].forEach(function (id) { if (dirs[id]) tf[id] = slot(dirs[id]); });
  ["1w", "1M"].forEach(function (id) { if (dirs[id]) tf[id] = slot(dirs[id], false); });
  return { name: name, sym: name.replace(/^xyz:/, ""), uni: name.indexOf("xyz:") === 0 ? "xyz" : "perps",
           mid: 100, hist: [], ctx: {}, tf: tf };
}

const ALL_UP = { "15m": "up", "1h": "up", "4h": "up", "1d": "up", "1w": "up", "1M": "up" };

function mkState(coins) {
  const state = { order: [], coins: {}, loaded: true, universes: ["xyz", "perps"], revision: 1 };
  coins.forEach(function (c) { state.order.push(c.name); state.coins[c.name] = c; });
  return state;
}

function removeCoin(state, name) {
  state.order = state.order.filter(function (n) { return n !== name; });
  delete state.coins[name];
}

function readLines(dir, day) {
  const f = path.join(dir, "continuity-" + day + ".jsonl");
  return fs.readFileSync(f, "utf8").trim().split("\n").map(function (l) { return JSON.parse(l); });
}

// A ledger on an injected clock; start() runs the boot keyframe at clock.t.
function mkLedger(dir, state, clock, bootId, extra) {
  return createContinuityLedger(Object.assign({
    dir: dir, state: state, ftfcTfs: FTFC, bootId: bootId || "boot-a",
    now: function () { return clock.t; }
  }, extra || {}));
}

const T0 = Date.UTC(2026, 8, 22, 12, 1, 0); // 2026-09-22T12:01Z, off a quarter boundary

// --- encoding ----------------------------------------------------------------

test("encode/decode round-trips every served value, and rejects the unknown", function () {
  const cases = [
    { ftfc: "up", dots: ["up", "up", "up", "up"], ready: true,
      dwmContinuity: { complete: true, dir: "up", dots: { "1d": "up", "1w": "up", "1M": "up" } } },
    { ftfc: "mixed", dots: ["down", "flat", "up", "down"], ready: true,
      dwmContinuity: { complete: true, dir: null, dots: { "1d": "down", "1w": "flat", "1M": "up" } } },
    { ftfc: null, dots: ["flat", "flat", "down", "down"], ready: false,
      dwmContinuity: { complete: false, dir: null, dots: { "1d": "down", "1w": null, "1M": null } } },
    { ftfc: "down", dots: ["down", "down", "down", "down"], ready: true,
      dwmContinuity: { complete: true, dir: "down", dots: { "1d": "down", "1w": "down", "1M": "down" } } }
  ];
  cases.forEach(function (sc) { assert.deepStrictEqual(decode(encode(sc)), sc); });
  assert.strictEqual(encode(cases[0]), "uuuuu1uuuu1", "the documented example");
  assert.throws(function () { encode(Object.assign({}, cases[0], { ftfc: "sideways" })); });
  assert.throws(function () { decode("uuuuu1xuuu1"); });
  assert.throws(function () { decode("short"); });
});

// --- parity: sampled === served ----------------------------------------------

test("servedContinuity equals the fields buildApiState serves, same state", function () {
  const state = mkState([
    mkCoin("xyz:AAPL", ALL_UP),
    mkCoin("BTC", { "15m": "down", "1h": "up", "4h": "flat", "1d": "down", "1w": "down", "1M": "up" }),
    mkCoin("xyz:NEW", { "15m": "up", "1h": "up", "1d": "up" }),          // unready: no 4h
    mkCoin("ETH", { "15m": "down", "1h": "down", "4h": "down", "1d": "down" }) // dwm incomplete
  ]);
  const now = T0;
  const payload = buildApiState(state, FTFC, null, now);
  assert.strictEqual(payload.coins.length, 4);
  payload.coins.forEach(function (row) {
    const sc = servedContinuity(state, state.coins[row.name], FTFC, now);
    assert.deepStrictEqual(sc, {
      ftfc: row.ftfc, dots: row.dots, dwmContinuity: row.dwmContinuity, ready: row.ready
    }, row.name);
  });
  // The fixture exercises every branch it claims to.
  const byName = {};
  payload.coins.forEach(function (r) { byName[r.name] = r; });
  assert.strictEqual(byName["xyz:NEW"].ready, false);
  assert.strictEqual(byName["xyz:NEW"].ftfc, null);
  assert.strictEqual(byName["ETH"].dwmContinuity.complete, false);
  assert.strictEqual(byName["BTC"].ftfc, "mixed");
});

// --- flag off ------------------------------------------------------------------

test("constructing the ledger has no side effects: no directory, no timer", function () {
  const dir = path.join(scratch(), "continuity");
  const clock = { t: T0 };
  mkLedger(dir, mkState([]), clock);
  assert.strictEqual(fs.existsSync(dir), false, "the directory appears only on start()");
});

// --- writer ----------------------------------------------------------------------

test("writer: boot keyframe, empty heartbeats, a delta per changed field, removal writes null", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const state = mkState([mkCoin("xyz:AAPL", ALL_UP), mkCoin("BTC", ALL_UP), mkCoin("ETH", ALL_UP)]);
  const led = mkLedger(dir, state, clock);
  t.after(function () { led.stop(); });
  await led.start();

  await led.tickOnce(T0 + 30000);                               // nothing changed
  state.coins["xyz:AAPL"].tf["15m"] = slot("down");             // a dot (and so ftfc)
  await led.tickOnce(T0 + 60000);
  state.coins["BTC"].tf["1M"] = slot("down", false);            // dwm only
  await led.tickOnce(T0 + 90000);
  delete state.coins["ETH"].tf["4h"];                           // readiness only... and ftfc
  await led.tickOnce(T0 + 120000);
  removeCoin(state, "BTC");                                     // roster removal
  await led.tickOnce(T0 + 150000);

  const lines = readLines(dir, "2026-09-22");
  assert.strictEqual(lines.length, 6);
  assert.strictEqual(lines[0].k, 1, "the first tick after start is a keyframe");
  assert.strictEqual(lines[0].boot, "boot-a");
  assert.deepStrictEqual(lines[0].tfs, FTFC);
  assert.deepStrictEqual(Object.keys(lines[0].c).sort(), ["BTC", "ETH", "xyz:AAPL"]);
  assert.strictEqual(lines[0].v, 1);
  assert.deepStrictEqual(lines[1], { t: T0 + 30000, v: 1, c: {} }, "unchanged -> empty heartbeat delta");
  assert.deepStrictEqual(Object.keys(lines[2].c), ["xyz:AAPL"]);
  assert.strictEqual(decode(lines[2].c["xyz:AAPL"]).dots[0], "down");
  assert.deepStrictEqual(Object.keys(lines[3].c), ["BTC"]);
  assert.strictEqual(decode(lines[3].c.BTC).dwmContinuity.dots["1M"], "down");
  assert.deepStrictEqual(Object.keys(lines[4].c), ["ETH"]);
  assert.strictEqual(decode(lines[4].c.ETH).ready, false);
  assert.deepStrictEqual(lines[5].c, { BTC: null }, "roster removal writes null");
  lines.slice(1).forEach(function (l) { assert.strictEqual(l.k, undefined); });

  const h = led.health();
  assert.strictEqual(h.enabled, true);
  assert.strictEqual(h.samples, 6);
  assert.strictEqual(h.lastSampleTs, T0 + 150000);
  assert.strictEqual(h.since, T0);
  assert.strictEqual(h.lastError, null);
  assert.strictEqual(h.sample_ms, 30000);
  assert.strictEqual(h.keyframe_ms, 900000);
  assert.strictEqual(h.retention_days, RETENTION_DAYS);
  assert.ok(typeof h.lastTickMs === "number" && h.lastTickMs >= 0);
});

test("writer: a keyframe on every clock-aligned 15-minute boundary", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };                                      // 12:01:00
  const led = mkLedger(dir, mkState([mkCoin("BTC", ALL_UP)]), clock);
  t.after(function () { led.stop(); });
  await led.start();
  for (let s = T0 + 30000; s <= T0 + 30 * MIN; s += 30000) await led.tickOnce(s);
  const keys = readLines(dir, "2026-09-22").filter(function (l) { return l.k; }).map(function (l) {
    return new Date(l.t).toISOString().slice(11, 19);
  });
  assert.deepStrictEqual(keys, ["12:01:00", "12:15:00", "12:30:00"]);
});

// --- rotation --------------------------------------------------------------------

test("rotation: UTC rollover gzips yesterday; files past retention are pruned", async function (t) {
  const dir = scratch();
  const old = new Date(Date.UTC(2026, 8, 22) - (RETENTION_DAYS + 5) * 86400000).toISOString().slice(0, 10);
  const kept = new Date(Date.UTC(2026, 8, 22) - (RETENTION_DAYS - 5) * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, "continuity-" + old + ".jsonl.gz"), zlib.gzipSync("x\n"));
  fs.writeFileSync(path.join(dir, "continuity-" + kept + ".jsonl.gz"), zlib.gzipSync("x\n"));
  const late = Date.UTC(2026, 8, 22, 23, 59, 30);
  const clock = { t: late };
  const led = mkLedger(dir, mkState([mkCoin("BTC", ALL_UP)]), clock);
  t.after(function () { led.stop(); });
  await led.start();
  await led.tickOnce(Date.UTC(2026, 8, 23, 0, 0, 0));
  const names = fs.readdirSync(dir).sort();
  assert.ok(names.indexOf("continuity-2026-09-22.jsonl.gz") >= 0, "yesterday gzipped");
  assert.ok(names.indexOf("continuity-2026-09-22.jsonl") < 0, "raw original removed");
  assert.ok(names.indexOf("continuity-2026-09-23.jsonl") >= 0, "today raw");
  assert.ok(names.indexOf("continuity-" + old + ".jsonl.gz") < 0, "past retention pruned");
  assert.ok(names.indexOf("continuity-" + kept + ".jsonl.gz") >= 0, "inside retention kept");
  assert.strictEqual(readLines(dir, "2026-09-23")[0].k, 1, "the first tick of a UTC day is a keyframe");
});

test("rotation: boot gzips a raw past-day file a previous process left behind", async function (t) {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, "continuity-2026-09-21.jsonl"), '{"t":1,"v":1,"k":1,"boot":"x","c":{}}\n');
  const clock = { t: T0 };
  const led = mkLedger(dir, mkState([]), clock);
  t.after(function () { led.stop(); });
  await led.start();
  assert.ok(fs.existsSync(path.join(dir, "continuity-2026-09-21.jsonl.gz")));
  assert.ok(!fs.existsSync(path.join(dir, "continuity-2026-09-21.jsonl")));
});

// --- lookup ----------------------------------------------------------------------

async function lookup(led, coin, t) {
  return (await led.continuityAt([{ coin: coin, t: t }]))[0];
}

test("lookup: on a change, between changes, before the first sample, unknown coin, unready", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const state = mkState([mkCoin("xyz:AAPL", ALL_UP), mkCoin("xyz:NEW", { "15m": "up", "1h": "up", "1d": "up" })]);
  const led = mkLedger(dir, state, clock);
  t.after(function () { led.stop(); });
  await led.start();
  await led.tickOnce(T0 + 30000);
  state.coins["xyz:AAPL"].tf["1h"] = slot("down");
  await led.tickOnce(T0 + 60000);                               // the change tick
  await led.tickOnce(T0 + 90000);
  clock.t = T0 + 100000;

  const onChange = await lookup(led, "xyz:AAPL", T0 + 60000);
  assert.strictEqual(onChange.covered, true);
  assert.strictEqual(onChange.at, T0 + 60000);
  assert.deepStrictEqual(onChange.dots, ["up", "down", "up", "up"]);
  assert.strictEqual(onChange.ftfc, "mixed");

  const between = await lookup(led, "xyz:AAPL", T0 + 59999);
  assert.strictEqual(between.covered, true);
  assert.strictEqual(between.at, T0 + 30000);
  assert.strictEqual(between.ftfc, "up");
  assert.deepStrictEqual(between.dwmContinuity, { complete: true, dir: "up", dots: { "1d": "up", "1w": "up", "1M": "up" } });
  assert.strictEqual(between.ready, true);

  const early = await lookup(led, "xyz:AAPL", T0 - 1);
  assert.deepStrictEqual(early, { coin: "xyz:AAPL", t: T0 - 1, covered: false, at: null, ftfc: null,
                                  dots: null, dwmContinuity: null, ready: null });

  assert.strictEqual((await lookup(led, "xyz:NOPE", T0 + 45000)).covered, false, "unknown coin");

  const unready = await lookup(led, "xyz:NEW", T0 + 45000);
  assert.strictEqual(unready.covered, true, "unready is covered - distinct from not covered");
  assert.strictEqual(unready.ready, false);
  assert.strictEqual(unready.ftfc, null);

  assert.strictEqual((await lookup(led, "xyz:AAPL", T0 + 200000)).covered, false, "future t");
});

test("lookup: a gap with no tick within 60 s is not covered; inside 60 s it is", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const led = mkLedger(dir, mkState([mkCoin("BTC", ALL_UP)]), clock);
  t.after(function () { led.stop(); });
  await led.start();
  await led.tickOnce(T0 + 30000);
  await led.tickOnce(T0 + 5 * MIN);                             // the worker stalled
  clock.t = T0 + 6 * MIN;
  assert.strictEqual((await lookup(led, "BTC", T0 + 30000 + 60000)).covered, true, "exactly 60 s");
  assert.strictEqual((await lookup(led, "BTC", T0 + 30000 + 60001)).covered, false, "past 60 s");
  assert.strictEqual((await lookup(led, "BTC", T0 + 4 * MIN)).covered, false, "deep in the gap");
});

test("lookup: across a boot keyframe the restart span is not covered; pre-restart lookups still answer", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const state = mkState([mkCoin("BTC", ALL_UP), mkCoin("ETH", ALL_UP)]);
  const a = mkLedger(dir, state, clock, "boot-a");
  t.after(function () { a.stop(); });
  await a.start();
  await a.tickOnce(T0 + 30000);
  a.stop();
  // New process 40 s later: within 60 s of A's last tick, but a restart.
  removeCoin(state, "ETH");
  clock.t = T0 + 70000;
  const b = mkLedger(dir, state, clock, "boot-b");
  t.after(function () { b.stop(); });
  await b.start();
  await b.tickOnce(T0 + 100000);
  clock.t = T0 + 110000;

  assert.strictEqual((await lookup(b, "BTC", T0 + 15000)).covered, true, "before the restart");
  assert.strictEqual((await lookup(b, "BTC", T0 + 30000)).covered, true, "ON A's last tick");
  assert.strictEqual((await lookup(b, "BTC", T0 + 45000)).covered, false,
    "A's tail: it died at an unknown moment after its last tick");
  assert.strictEqual((await lookup(b, "BTC", T0 + 65000)).covered, false, "between A's last tick and B's boot");
  const afterBoot = await lookup(b, "BTC", T0 + 75000);
  assert.strictEqual(afterBoot.covered, true);
  assert.strictEqual(afterBoot.at, T0 + 70000);
  assert.strictEqual((await lookup(b, "ETH", T0 + 15000)).covered, true, "ETH was in A's roster");
  assert.strictEqual((await lookup(b, "ETH", T0 + 75000)).covered, false,
    "the boot keyframe replaces the roster: ETH is gone");
  const lines = readLines(dir, "2026-09-22");
  assert.strictEqual(lines[2].boot, "boot-b");
  assert.strictEqual(lines[2].k, 1);
});

test("lookup: an earlier boot's tail with no successor is not covered", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const state = mkState([mkCoin("BTC", ALL_UP)]);
  const a = mkLedger(dir, state, clock, "boot-a");
  await a.start();
  a.stop();
  // A reader in a NEW process before its own first tick lands.
  const b = mkLedger(dir, state, clock, "boot-b");
  assert.strictEqual((await lookup(b, "BTC", T0 + 10000)).covered, false);
});

test("lookup: a read across a gzipped previous day, including just after midnight", async function (t) {
  const dir = scratch();
  const late = Date.UTC(2026, 8, 22, 23, 59, 20);
  const clock = { t: late };
  const state = mkState([mkCoin("BTC", ALL_UP)]);
  const led = mkLedger(dir, state, clock);
  t.after(function () { led.stop(); });
  await led.start();
  await led.tickOnce(late + 30000);                             // 23:59:50
  state.coins.BTC.tf["15m"] = slot("down");
  await led.tickOnce(late + 60000);                             // 00:00:20 next day
  clock.t = late + 70000;
  assert.ok(fs.existsSync(path.join(dir, "continuity-2026-09-22.jsonl.gz")));

  const yday = await lookup(led, "BTC", late + 10000);
  assert.strictEqual(yday.covered, true, "read back from the gzipped day");
  assert.strictEqual(yday.at, late);
  assert.strictEqual(yday.ftfc, "up");

  const midnight = await lookup(led, "BTC", Date.UTC(2026, 8, 23, 0, 0, 10));
  assert.strictEqual(midnight.covered, true, "the last tick at or before t is yesterday's 23:59:50");
  assert.strictEqual(midnight.at, late + 30000);
  assert.strictEqual(midnight.dots[0], "up");

  const today = await lookup(led, "BTC", late + 60000);
  assert.strictEqual(today.dots[0], "down");
});

test("lookup survives a reboot: today's file is replayed and a crash's partial line is fenced off", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const state = mkState([mkCoin("BTC", ALL_UP)]);
  const a = mkLedger(dir, state, clock, "boot-a");
  await a.start();
  await a.tickOnce(T0 + 30000);
  a.stop();
  fs.appendFileSync(path.join(dir, "continuity-2026-09-22.jsonl"), '{"t":' + (T0 + 60000) + ',"v":1,"c":{"BT');
  clock.t = T0 + 200000;
  const b = mkLedger(dir, state, clock, "boot-b");
  t.after(function () { b.stop(); });
  await b.start();
  clock.t = T0 + 210000;
  assert.strictEqual((await lookup(b, "BTC", T0 + 20000)).covered, true, "boot-a history answers after reboot");
  assert.strictEqual((await lookup(b, "BTC", T0 + 205000)).covered, true, "boot-b keyframe parsed intact");
  const raw = fs.readFileSync(path.join(dir, "continuity-2026-09-22.jsonl"), "utf8").split("\n");
  assert.strictEqual(JSON.parse(raw[3]).boot, "boot-b", "the boot keyframe starts on its own line");
});

// --- error isolation -------------------------------------------------------------

test("a failing append surfaces lastError; the next tick still runs and is a keyframe", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const led = mkLedger(dir, mkState([mkCoin("BTC", ALL_UP)]), clock);
  t.after(function () { led.stop(); });
  await led.start();
  fs.rmSync(dir, { recursive: true, force: true });
  await led.tickOnce(T0 + 30000);
  const h1 = led.health();
  assert.ok(h1.lastError && /append failed/.test(h1.lastError), h1.lastError);
  assert.strictEqual(h1.errors, 1);
  fs.mkdirSync(dir, { recursive: true });
  await led.tickOnce(T0 + 60000);
  const h2 = led.health();
  assert.strictEqual(h2.lastError, null);
  assert.strictEqual(h2.samples, 2);
  const lines = readLines(dir, "2026-09-22");
  assert.strictEqual(lines[0].k, 1, "the tick after a failed write is a keyframe");
});

test("a throwing snapshot is caught and counted, never thrown", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const state = mkState([mkCoin("BTC", ALL_UP)]);
  const led = mkLedger(dir, state, clock);
  t.after(function () { led.stop(); });
  await led.start();
  state.coins.BTC.tf = null;                                    // servedContinuity will throw
  await led.tickOnce(T0 + 30000);
  assert.ok(/tick failed/.test(led.health().lastError));
  state.coins.BTC.tf = mkCoin("BTC", ALL_UP).tf;
  await led.tickOnce(T0 + 60000);
  assert.strictEqual(led.health().lastError, null);
});

test("the day-file ceiling stops appending and reads as a gap, never a wrong state", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const led = mkLedger(dir, mkState([mkCoin("BTC", ALL_UP)]), clock, "boot-a", { maxDayBytes: 400 });
  t.after(function () { led.stop(); });
  await led.start();
  for (let s = T0 + 30000; s <= T0 + 20 * 30000; s += 30000) await led.tickOnce(s);
  assert.ok(/ceiling/.test(led.health().lastError));
  assert.ok(fs.statSync(path.join(dir, "continuity-2026-09-22.jsonl")).size <= 400);
  clock.t = T0 + 20 * 30000 + 1000;
  assert.strictEqual((await lookup(led, "BTC", T0 + 20 * 30000)).covered, false);
});

// --- HTTP route ------------------------------------------------------------------

function handlerWith(continuity, state) {
  return createRequestHandler({
    loop: { state: state || mkState([mkCoin("BTC", ALL_UP)]) },
    rules: { alertsFired: function () { return 0; } },
    push: { count: function () { return 0; }, stats: function () { return {}; } },
    config: { ftfcTfs: FTFC },
    continuity: continuity,
    now: function () { return T0; }
  });
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  t.after(function () { return new Promise(function (resolve) { server.close(resolve); }); });
  return server.address().port;
}

function request(port, method, p, body) {
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: "127.0.0.1", port: port, method: method, path: p,
      headers: body === undefined ? {} : { "Content-Type": "application/json" } }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("flag off: /health continuity_ledger null, /api/state without the key, endpoint 503", async function (t) {
  const port = await serve(t, handlerWith(null));
  const h = JSON.parse((await request(port, "GET", "/health")).body);
  assert.ok("continuity_ledger" in h);
  assert.strictEqual(h.continuity_ledger, null);
  const s = JSON.parse((await request(port, "GET", "/api/state")).body);
  assert.ok(!("continuity_ledger" in s), "flag-off payload carries no new key");
  const r = await request(port, "POST", "/api/continuity_at", "[]");
  assert.strictEqual(r.status, 503);
  assert.deepStrictEqual(JSON.parse(r.body), { error: "continuity ledger disabled" });
});

test("flag on: /api/state differs from flag off ONLY by continuity_ledger", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const state = mkState([mkCoin("BTC", ALL_UP)]);
  const led = mkLedger(dir, state, clock);
  t.after(function () { led.stop(); });
  await led.start();
  const on = JSON.parse((await request(await serve(t, handlerWith(led, state)), "GET", "/api/state")).body);
  const off = JSON.parse((await request(await serve(t, handlerWith(null, state)), "GET", "/api/state")).body);
  assert.deepStrictEqual(on.continuity_ledger, { since: T0, sample_ms: 30000 });
  delete on.continuity_ledger; delete on.ts; delete off.ts;
  assert.deepStrictEqual(on, off);
});

test("endpoint: 200 items answer in request order; 201 -> 400; oversized -> 413; malformed -> 400", async function (t) {
  const dir = scratch();
  const clock = { t: T0 };
  const state = mkState([mkCoin("BTC", ALL_UP), mkCoin("xyz:AAPL", ALL_UP)]);
  const led = mkLedger(dir, state, clock);
  t.after(function () { led.stop(); });
  await led.start();
  await led.tickOnce(T0 + 30000);
  clock.t = T0 + 40000;
  const port = await serve(t, handlerWith(led, state));

  const items = [];
  for (let i = 0; i < 200; i++) {
    items.push({ coin: i % 3 === 0 ? "BTC" : (i % 3 === 1 ? "xyz:AAPL" : "NOPE"), t: T0 + 40000 - i * 200 });
  }
  const ok = await request(port, "POST", "/api/continuity_at", JSON.stringify(items));
  assert.strictEqual(ok.status, 200);
  const out = JSON.parse(ok.body);
  assert.strictEqual(out.length, 200);
  out.forEach(function (r, i) {
    assert.strictEqual(r.coin, items[i].coin, "order preserved at " + i);
    assert.strictEqual(r.t, items[i].t);
    assert.strictEqual(r.covered, items[i].coin !== "NOPE" && items[i].t >= T0);
  });

  const tooMany = await request(port, "POST", "/api/continuity_at", JSON.stringify(items.concat([items[0]])));
  assert.strictEqual(tooMany.status, 400);
  const huge = await request(port, "POST", "/api/continuity_at", "[" + " ".repeat(33 * 1024) + "]");
  assert.strictEqual(huge.status, 413);
  assert.strictEqual((await request(port, "POST", "/api/continuity_at", "[{")).status, 400);
  assert.strictEqual((await request(port, "POST", "/api/continuity_at", '{"coin":"BTC"}')).status, 400);
  assert.strictEqual((await request(port, "POST", "/api/continuity_at", '[{"coin":"BTC","t":"x"}]')).status, 400);

  const h = JSON.parse((await request(port, "GET", "/health")).body).continuity_ledger;
  assert.strictEqual(h.enabled, true);
  assert.strictEqual(h.samples, 2);
});
