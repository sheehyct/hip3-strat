"use strict";

// Telemetry collector (design review): line shape, per-coin
// tuple contents, UTC-day rotation with gzip, and 35-day pruning. Uses a
// scratch dir under the OS tmpdir; node builtins only.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { createTelemetry, PRUNE_DAYS } = require("../src/telemetry.js");
const { SCORE_V } = require("../src/metrics.js");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hip3-telemetry-test-"));
}

// A coin with one live in-force signal, one recrossed, full D/W/M alignment.
function mkState() {
  const slot = (dir, live) => ({
    closed: [{ t: 1, o: 99, h: 101, l: 98, c: 100 }],
    forming: { t: 2, T: 3, o: 100, h: 103, l: 97, c: dir === "up" ? 101 : 99, v: 1 },
    an: { types: ["2U"], formingType: "2U", formingDir: dir, completed: null,
          setups: [], invalidated: false, live: live || [] }
  });
  const coin = {
    name: "xyz:T", sym: "T", uni: "xyz", mid: 101, hist: [], ctx: {},
    tf: {
      "1d": slot("up", [
        { name: "a", dir: "up", entry: 100, stop: 98, target: 110, kind: "rev" },   // in force (101 > 100)
        { name: "b", dir: "up", entry: 102, stop: 98, target: 110, kind: "rev" }    // recrossed (101 < 102)
      ]),
      "1h": slot("up"),
      "1w": slot("up"),
      "1M": slot("up")
    }
  };
  return { order: ["xyz:T"], coins: { "xyz:T": coin }, loaded: true, universes: ["xyz"] };
}

const FTFC = ["1h", "1d"];
const T0 = Date.UTC(2026, 6, 21, 12, 0, 0); // 2026-07-21T12:00Z

test("telemetry line: compact per-coin tuple with score terms, gate, oof count", async function () {
  const dir = scratch();
  const tel = createTelemetry({ dir: dir, ftfcTfs: FTFC });
  fs.mkdirSync(dir, { recursive: true });
  await tel.sampleOnce(mkState(), T0);
  const file = path.join(dir, "telemetry-2026-07-21.jsonl");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.strictEqual(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec.t, T0);
  assert.strictEqual(rec.v, 3, "schema v3: readiness + true-up parity gates");
  assert.strictEqual(rec.sv, SCORE_V, "score_v rides every line so the series splits at semantics changes");
  const tuple = rec.c["xyz:T"];
  // [score,dot,mom,inf,act,dwmDir,oof,live,flags,r60,atr1h]
  assert.strictEqual(tuple.length, 11);
  assert.ok(Number.isInteger(tuple[0]), "score int");
  assert.strictEqual(tuple[1], 1, "both fast dots up -> dotNetFast 1");
  assert.strictEqual(tuple[3], 0.5, "one in-force up signal -> inForceNet 0.5");
  assert.strictEqual(tuple[5], "u", "full D/W/M alignment");
  assert.strictEqual(tuple[6], 1, "one recrossed signal counted as oof");
  assert.strictEqual(tuple[7], 2, "two live signals on fast TFs");
  assert.strictEqual(tuple[8], 1 | 16, "rvol missing + hourly yardstick missing (1 closed 1h bar)");
  assert.strictEqual(tuple[9], null, "no tape and no 15m candles -> no raw r60");
  assert.strictEqual(tuple[10], null, "no yardstick -> no raw atr1h");
  assert.strictEqual(tel.stats().samples, 1);
  assert.strictEqual(tel.stats().lastSampleTs, T0);
});

// Review 2026-07-25 F1/F3/F4: one line, three coins - a fresh coin records
// its RAW momentum inputs unflagged while a mids-stalled sibling is flagged
// 32 (NOT calibration-grade) in the SAME sample (the one-universe-fails
// state), and an overdue 1h slot is flagged 64|16 instead of silently
// normalizing on a dead yardstick.
test("telemetry v2: stale endpoint and overdue yardstick are flagged per coin; raws recorded", async function () {
  const yardBars = (endAge) => {
    const bars = [];
    for (let i = 0; i < 21; i++) {
      const T = T0 - endAge - (20 - i) * 3600000;
      // constant TR 1 on a 100 close -> atr1h 1%
      bars.push({ t: T - 3600000, T: T, o: 100, h: 100.5, l: 99.5, c: 100 });
    }
    return bars;
  };
  const tapeCoin = (name, midAge, yEndAge) => ({
    name: name, sym: name, uni: "xyz", mid: 105, ctx: {},
    hist: [{ t: T0 - midAge - 3660000, m: 100 }, { t: T0 - midAge, m: 105 }],
    tf: { "1h": { closed: yardBars(yEndAge), forming: null, an: null } }
  });
  const state = {
    order: ["xyz:F", "xyz:S", "xyz:O"],
    coins: {
      "xyz:F": tapeCoin("xyz:F", 4000, 60000),      // fresh endpoint, fresh yardstick
      "xyz:S": tapeCoin("xyz:S", 300000, 60000),    // mids stalled 5 min (universe gap)
      "xyz:O": tapeCoin("xyz:O", 4000, 4500001)     // 1h slot overdue (failed rolls)
    },
    loaded: true, universes: ["xyz"]
  };
  const dir = scratch();
  const tel = createTelemetry({ dir: dir, ftfcTfs: FTFC });
  fs.mkdirSync(dir, { recursive: true });
  await tel.sampleOnce(state, T0);
  const rec = JSON.parse(fs.readFileSync(
    path.join(dir, "telemetry-2026-07-21.jsonl"), "utf8").trim());
  const f = rec.c["xyz:F"], s = rec.c["xyz:S"], o = rec.c["xyz:O"];
  // fresh: exact r60 5% on a 1% yardstick, no stale/fallback flags
  assert.strictEqual(f[8] & (8 | 16 | 32 | 64), 0, "fresh coin carries no source/stale flags");
  assert.strictEqual(f[9], 5, "raw r60 recorded (already exceeds the +/-1 clamp x yardstick)");
  assert.strictEqual(f[10], 1, "raw atr1h recorded");
  // stalled sibling in the SAME line: flagged 32, raws still recorded
  assert.ok(s[8] & 32, "stale endpoint flagged - sample not calibration-grade");
  assert.strictEqual(s[8] & (8 | 16 | 64), 0);
  assert.strictEqual(s[9], 5, "frozen span-correct r60 still recorded");
  // overdue yardstick: fallback (16) plus the STALE-not-young distinction (64)
  assert.ok(o[8] & 64, "slot present but overdue");
  assert.ok(o[8] & 16, "fixed-1.5 fallback used");
  assert.strictEqual(o[8] & 32, 0, "endpoint itself is fresh");
  assert.strictEqual(o[10], null, "no usable yardstick -> no raw atr1h");
});

test("telemetry rotation: UTC day change gzips the finished day", async function () {
  const dir = scratch();
  const tel = createTelemetry({ dir: dir, ftfcTfs: FTFC });
  fs.mkdirSync(dir, { recursive: true });
  const st = mkState();
  await tel.sampleOnce(st, T0);
  await tel.sampleOnce(st, T0 + 86400000);   // next UTC day
  const names = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(names,
    ["telemetry-2026-07-21.jsonl.gz", "telemetry-2026-07-22.jsonl"]);
  // the gz round-trips to the original line
  const gz = fs.readFileSync(path.join(dir, "telemetry-2026-07-21.jsonl.gz"));
  const rec = JSON.parse(zlib.gunzipSync(gz).toString().trim());
  assert.strictEqual(rec.t, T0);
});

test("telemetry prune: files older than PRUNE_DAYS are deleted on rotation", async function () {
  const dir = scratch();
  const tel = createTelemetry({ dir: dir, ftfcTfs: FTFC });
  fs.mkdirSync(dir, { recursive: true });
  const oldDay = new Date(T0 - (PRUNE_DAYS + 2) * 86400000).toISOString().slice(0, 10);
  const keepDay = new Date(T0 - 2 * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, "telemetry-" + oldDay + ".jsonl.gz"), "x");
  fs.writeFileSync(path.join(dir, "telemetry-" + keepDay + ".jsonl.gz"), "x");
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "x");
  const st = mkState();
  await tel.sampleOnce(st, T0);
  await tel.sampleOnce(st, T0 + 86400000);   // triggers rotation + prune
  const names = fs.readdirSync(dir).sort();
  assert.ok(names.indexOf("telemetry-" + oldDay + ".jsonl.gz") < 0, "old file pruned");
  assert.ok(names.indexOf("telemetry-" + keepDay + ".jsonl.gz") >= 0, "recent file kept");
  assert.ok(names.indexOf("unrelated.txt") >= 0, "non-telemetry files untouched");
});

test("telemetry never scores an empty state but still writes a line", async function () {
  const dir = scratch();
  const tel = createTelemetry({ dir: dir, ftfcTfs: FTFC });
  fs.mkdirSync(dir, { recursive: true });
  await tel.sampleOnce({ order: [], coins: {}, loaded: false, universes: [] }, T0);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "telemetry-2026-07-21.jsonl"), "utf8").trim());
  assert.deepStrictEqual(rec.c, {});
});
