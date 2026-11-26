"use strict";

// Continuity checkpoint ledger:
// a durable, time-indexed record of every served coin's CONTINUITY - ftfc,
// dots, dwmContinuity, ready - exactly as /api/state served it, so a
// consumer can ask "what was it at time t?" for trade attribution. /api/state
// is current-only; without this, a trade the phone did not watch open reads
// "Continuity unknown" forever.
//
// Passive, like telemetry.js and briefing_store.js: reads loop.state on its
// own timer, never touches the loop, makes ZERO exchange requests. Every
// value comes from apistate.servedContinuity - the one path /api/state uses
// (the servedScore precedent) - so nothing here computes continuity.
// Enabled only by CONTINUITY_LEDGER=1 (server.js); unset, this module is
// never constructed.
//
// STORAGE: data/continuity/continuity-YYYY-MM-DD.jsonl (UTC day), one line
// per 30s tick. data/ should sit on a persistent volume so it
// survives redeploys. Yesterday's file is gzipped on the first tick
// of a new UTC day (and at boot, for a raw past-day file a restart left
// behind); files older than RETENTION_DAYS are deleted.
//
//   Keyframe - a full roster snapshot. Written on the first tick after boot,
//   on every clock-aligned 15-minute boundary (so the first tick of every
//   UTC day is one), and on the tick after any failed write:
//     {"t":<ms>,"v":1,"k":1,"boot":"<boot_id>","tfs":[...],"c":{"<coin>":"<enc>",...}}
//   Delta - only the coins whose served continuity changed since the last
//   written line. Written even when nothing changed ("c":{}): that line is
//   the coverage heartbeat - it proves the worker was sampling at t:
//     {"t":<ms>,"v":1,"c":{"<coin>":"<enc>"}}
//   A coin that left the roster appears in a delta as "<coin>":null. A
//   keyframe REPLACES the whole state, so a coin absent from it is gone.
//
//   boot_id is the briefing store's (served on /health as briefing.boot_id).
//   Deltas inherit the boot of the keyframe before them; a boot id change
//   between two ticks is how a reader knows the process restarted there.
//   tfs is the configured FTFC set the dots are ordered by.
//
// ENCODING v1 - one compact string per coin (the endpoint decodes; no
// consumer ever sees it). Positions, for a configured FTFC set of n TFs:
//   [0]          ftfc            u=up d=down m=mixed -=null (unready)
//   [1..n]       dots, tfs order u=up d=down f=flat
//   [n+1]        dwm complete    1 / 0
//   [n+2]        dwm dir         u / d / - (null)
//   [n+3..n+5]   dwm dots 1d,1w,1M  u / d / f / - (null)
//   [n+6]        ready           1 / 0
// So n = length - 7, and a fully aligned ready coin on the 4-TF set reads
// "uuuuu1uuuu1". Any change to this layout moves `v`.
//
// LOOKUP semantics (continuityAt): the state at t is the latest keyframe at
// or before t with every delta up to t applied; `at` is the last tick at or
// before t. NOT COVERED - every state field null - when t is outside
// retention, before the first sample, or in the future; when no tick falls
// within GAP_MS (2 x the sample interval) at or before t; when the process
// restarted between that tick and t (the boot id changes at the next tick,
// or that tick belongs to an earlier boot with nothing after it - the dead
// process's last <= 30 s are a gap, since when it died is unknown); or when
// the coin was not in the roster at t; or when a BREAK follows that tick -
// a line replay rejected (corrupt, out of order, or an encoding its
// keyframe's `tfs` does not admit) or a write that failed - since what the
// lost line said is unknown. The ledger never returns a stale state across
// a gap. An unready coin at t is covered, with ready false.
//
// Robustness (code review 2026-09-24): writes after a failed append are
// newline-fenced and re-counted; a clock behind the newest recorded tick is
// refused before any rotation, and compression never overwrites an
// existing archive; day replay yields to the event loop in slices; public
// lookups are admission-bounded (MAX_QUEUE), deadlined and cancellable.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { servedContinuity } = require("./apistate.js");

const SAMPLE_MS = 30000;          // the score ring's cadence
const KEYFRAME_MS = 900000;       // 15 min; divides a UTC day exactly
const RETENTION_DAYS = 35;        // chosen retention
const GAP_MS = 2 * SAMPLE_MS;     // coverage tolerance at or before t
const DAY_MS = 86400000;
const LRU_DAYS = 3;               // decoded past days kept in memory
const V = 1;
// Disk ceiling for ONE day file. The computed worst case - every coin
// changing on every tick - is ~286 coins x 2,880 ticks x ~30 B = ~25 MB raw;
// 64 MB leaves 2.5x headroom for roster growth. At the
// ceiling the writer stops appending for the rest of the UTC day and
// surfaces lastError: lookups then read that span as NOT COVERED (a gap),
// never as a wrong state. Retention bounds the total: 35 gzipped days.
const MAX_DAY_BYTES = 64 * 1024 * 1024;
// Public-route admission (audit F6): at most MAX_QUEUE lookup requests are
// accepted at once (running + waiting); more are refused before their items
// are retained. Each accepted request has a deadline; a request whose client
// disconnected or whose deadline passed stops before its next item.
const MAX_QUEUE = 4;
const REQUEST_TIMEOUT_MS = 15000;

const FILE_RE = /^continuity-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

function utcDay(ts) { return new Date(ts).toISOString().slice(0, 10); }
function dayStart(day) { return Date.parse(day + "T00:00:00.000Z"); }
function fileFor(dir, day) { return path.join(dir, "continuity-" + day + ".jsonl"); }

// --- encoding --------------------------------------------------------------

const FTFC_ENC = { up: "u", down: "d", mixed: "m" };
const FTFC_DEC = { u: "up", d: "down", m: "mixed", "-": null };
const DOT_ENC = { up: "u", down: "d", flat: "f" };
const DOT_DEC = { u: "up", d: "down", f: "flat" };
const DWM_DOT_DEC = { u: "up", d: "down", f: "flat", "-": null };
const DWM_TFS = ["1d", "1w", "1M"];

function encChar(map, v, nullable) {
  if (v === null || v === undefined) {
    if (nullable) return "-";
    throw new Error("unexpected null in served continuity");
  }
  const ch = map[v];
  if (!ch) throw new Error("unencodable served continuity value: " + v);
  return ch;
}

// served {ftfc, dots, dwmContinuity, ready} -> compact string. Throws on a
// value outside the served vocabulary, so a future served value cannot be
// recorded as a lookalike.
function encode(sc) {
  let s = encChar(FTFC_ENC, sc.ftfc, true);
  for (let i = 0; i < sc.dots.length; i++) s += encChar(DOT_ENC, sc.dots[i], false);
  const dwm = sc.dwmContinuity;
  s += dwm.complete ? "1" : "0";
  s += dwm.dir === "up" ? "u" : (dwm.dir === "down" ? "d" : "-");
  for (let i = 0; i < DWM_TFS.length; i++) {
    const d = dwm.dots[DWM_TFS[i]];
    s += d === null || d === undefined ? "-" : encChar(DOT_ENC, d, false);
  }
  s += sc.ready ? "1" : "0";
  return s;
}

function decChar(map, ch) {
  if (!Object.prototype.hasOwnProperty.call(map, ch)) throw new Error("bad continuity encoding");
  return map[ch];
}

// Exact-shape check of a v1 string for a keyframe that declared n FTFC
// timeframes (audit F2: a string one dot short still decoded, as a shape
// /api/state never served). n = 0 is legal - an empty configured set
// serves dots [] (audit F7).
const ENC_RE = new Map();
function validEnc(s, n) {
  if (typeof s !== "string" || !Number.isInteger(n) || n < 0 || s.length !== n + 7) return false;
  let re = ENC_RE.get(n);
  if (!re) {
    re = new RegExp("^[udm-][udf]{" + n + "}[01][ud-][udf-]{3}[01]$");
    ENC_RE.set(n, re);
  }
  return re.test(s);
}

// compact string -> the served shapes. Throws on a malformed string, or on
// one whose dot count is not the n its keyframe declared (when given).
function decode(s, n) {
  if (n === undefined) n = typeof s === "string" ? s.length - 7 : -1;
  if (!validEnc(s, n)) throw new Error("bad continuity encoding");
  const dots = [];
  for (let i = 1; i <= n; i++) dots.push(decChar(DOT_DEC, s[i]));
  const complete = s[n + 1];
  const ready = s[n + 6];
  if ((complete !== "1" && complete !== "0") || (ready !== "1" && ready !== "0")) {
    throw new Error("bad continuity encoding");
  }
  const dir = s[n + 2];
  if (dir !== "u" && dir !== "d" && dir !== "-") throw new Error("bad continuity encoding");
  const dwmDots = {};
  for (let i = 0; i < DWM_TFS.length; i++) dwmDots[DWM_TFS[i]] = decChar(DWM_DOT_DEC, s[n + 3 + i]);
  return {
    ftfc: decChar(FTFC_DEC, s[0]),
    dots: dots,
    dwmContinuity: {
      complete: complete === "1",
      dir: dir === "u" ? "up" : (dir === "d" ? "down" : null),
      dots: dwmDots
    },
    ready: ready === "1"
  };
}

// --- timelines -------------------------------------------------------------
// One UTC day, replayed from its lines: tick times + the boot each tick ran
// under, and per coin the ordered list of (t, enc) changes, where enc null
// means "not in the roster". Replay starts UNSYNCED: deltas before the
// day's first keyframe (or after a corrupt line) are ignored and their
// ticks not recorded, so an unknowable span reads as a gap, never as state.
//
// BREAKS (audit F1): a rejected line - unparseable, out of order, or
// carrying an encoding its keyframe's `tfs` does not admit - records a
// coverage break after the last accepted tick (brk holds that tick's
// index; brkAtStart marks one before the day's first accepted tick).
// Lookup never carries a tick's state across a break, however close the
// next accepted tick is: the lost line may have been a change. The writer
// marks the same break on a failed write, so live answers and answers
// replayed after a restart agree.

function newTimeline(day) {
  return { day: day, tickT: [], tickBoot: [], coins: new Map(), cur: new Map(),
           synced: false, boot: null, n: null, brk: new Set(), brkAtStart: false };
}

function markBreak(tl) {
  if (tl.tickT.length) tl.brk.add(tl.tickT.length - 1); else tl.brkAtStart = true;
}

// Every value in a record is a valid encoding for n dots, or null.
function recordValuesValid(c, n) {
  const names = Object.keys(c);
  for (let i = 0; i < names.length; i++) {
    const e = c[names[i]];
    if (e !== null && !validEnc(e, n)) return false;
  }
  return true;
}

function setCoin(tl, name, enc, t) {
  const prev = tl.cur.has(name) ? tl.cur.get(name) : null;
  if (prev === enc) return;
  if (enc === null) tl.cur.delete(name); else tl.cur.set(name, enc);
  let ch = tl.coins.get(name);
  if (!ch) { ch = { ts: [], enc: [] }; tl.coins.set(name, ch); }
  ch.ts.push(t); ch.enc.push(enc);
}

function rejectRecord(tl) {
  tl.synced = false;
  markBreak(tl);
  return false;
}

function applyRecord(tl, rec) {
  const ok = rec && typeof rec === "object" && rec.v === V && Number.isFinite(rec.t)
    && rec.c && typeof rec.c === "object"
    && (!tl.tickT.length || rec.t > tl.tickT[tl.tickT.length - 1]);
  if (!ok) return rejectRecord(tl);
  const t = rec.t;
  if (rec.k) {
    // A keyframe declares the dot count every encoding until the next
    // keyframe must have; without a well-formed tfs it vouches for nothing.
    const tfsOk = Array.isArray(rec.tfs) && rec.tfs.every(function (x) { return typeof x === "string"; });
    if (!tfsOk || typeof rec.boot !== "string" || !recordValuesValid(rec.c, rec.tfs.length)) {
      return rejectRecord(tl);
    }
    tl.n = rec.tfs.length;
    tl.boot = rec.boot;
    Array.from(tl.cur.keys()).forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(rec.c, name)) setCoin(tl, name, null, t);
    });
    Object.keys(rec.c).forEach(function (name) {
      const e = rec.c[name];
      setCoin(tl, name, typeof e === "string" ? e : null, t);
    });
    tl.synced = true;
  } else {
    if (!tl.synced || !recordValuesValid(rec.c, tl.n)) return rejectRecord(tl);
    Object.keys(rec.c).forEach(function (name) {
      const e = rec.c[name];
      setCoin(tl, name, typeof e === "string" ? e : null, t);
    });
  }
  tl.tickT.push(t); tl.tickBoot.push(tl.boot);
  return true;
}

// keepCur: today's file replayed at boot stays LIVE - the writer's boot
// keyframe must diff against the replayed roster, or a coin that left it
// across the restart would never get its null and would read as present.
//
// Async and SLICED (audit F5): a supported worst-case day (every coin
// changing every tick, ~24 MB raw) parsed in one synchronous pass held the
// worker's event loop for ~210 ms. Lines are scanned incrementally and the
// replay yields to the loop after every REPLAY_SLICE_BYTES of text, so no
// slice holds the loop for more than a few milliseconds.
const REPLAY_SLICE_BYTES = 256 * 1024;
function yieldLoop() { return new Promise(function (resolve) { setImmediate(resolve); }); }

async function timelineFromText(day, text, keepCur) {
  const tl = newTimeline(day);
  let pos = 0, sliceStart = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    if (nl > pos) {
      let rec = null;
      try { rec = JSON.parse(text.slice(pos, nl)); } catch (e) { rec = null; }
      applyRecord(tl, rec);
    }
    pos = nl + 1;
    if (pos - sliceStart >= REPLAY_SLICE_BYTES) {
      sliceStart = pos;
      await yieldLoop();
    }
  }
  if (!keepCur) tl.cur = null; // a finished day never takes new lines
  return tl;
}

// Largest index i with arr[i] <= x, or -1.
function lastAtOrBefore(arr, x) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function encAt(tl, coin, t) {
  const ch = tl.coins.get(coin);
  if (!ch) return null;
  const i = lastAtOrBefore(ch.ts, t);
  return i < 0 ? null : ch.enc[i];
}

function notCovered(coin, t) {
  return { coin: coin, t: t, covered: false, at: null, ftfc: null, dots: null,
           dwmContinuity: null, ready: null };
}

// --- the ledger ------------------------------------------------------------

// opts: { dir, state, ftfcTfs, bootId, log, now, sampleMs, keyframeMs,
//         retentionDays, maxDayBytes, maxQueue, requestTimeoutMs }
function createContinuityLedger(opts) {
  const dir = opts.dir;
  const state = opts.state;
  const ftfcTfs = opts.ftfcTfs || ["15m", "1h", "4h", "1d"];
  const bootId = opts.bootId;
  const log = opts.log || function () {};
  const clock = opts.now || Date.now;
  const sampleMs = opts.sampleMs || SAMPLE_MS;
  const keyframeMs = opts.keyframeMs || KEYFRAME_MS;
  const retentionDays = opts.retentionDays || RETENTION_DAYS;
  const maxDayBytes = opts.maxDayBytes || MAX_DAY_BYTES;
  const maxQueue = opts.maxQueue || MAX_QUEUE;
  const requestTimeoutMs = opts.requestTimeoutMs || REQUEST_TIMEOUT_MS;
  const gapMs = 2 * sampleMs;
  if (!dir || !state || !bootId) throw new Error("continuity ledger needs dir, state and bootId");

  let timer = null;
  let ready = null;              // init promise
  let inFlight = false;
  let samples = 0, errors = 0, skipped = 0;
  let lastSampleTs = null, lastTickMs = null, lastError = null;
  let since = null;              // first tick inside retention
  let currentDay = null;
  let live = null;               // today's timeline, fed by the writer
  let dayBytes = 0;
  let needKeyframe = true;       // first tick after boot
  let needNewline = false;       // today's file may end mid-line (crash / failed append)
  let needStat = false;          // dayBytes unknown after a failed append
  let lastT = null;              // newest tick on disk or written (monotonic guard)
  let queued = 0, busyRefused = 0, timedOut = 0;
  let lastKeyBucket = null;
  let written = new Map();       // coin -> enc as of the last written line
  const lru = new Map();         // day -> finished timeline (insertion = recency)
  let readQueue = Promise.resolve();

  // Every writer failure is also a coverage BREAK in the live timeline: the
  // unwritten tick may have carried a change, so no earlier tick's state
  // may be carried across it (the same answer a replay gives after restart).
  function fail(msg) {
    errors++;
    lastError = msg;
    needKeyframe = true;
    if (live) markBreak(live);
    log("[continuity] " + msg);
  }

  function cacheDay(tl) {
    lru.delete(tl.day);
    lru.set(tl.day, tl);
    while (lru.size > LRU_DAYS) lru.delete(lru.keys().next().value);
  }

  function readDayText(day) {
    const raw = fileFor(dir, day);
    return fs.promises.readFile(raw, "utf8").catch(function (e) {
      if (e.code !== "ENOENT") throw e;
      return fs.promises.readFile(raw + ".gz").then(gunzipText, function (e2) {
        if (e2.code === "ENOENT") return null;
        throw e2;
      });
    });
  }

  // A finished day's timeline, decoded lazily and kept in a small LRU.
  // Today is always the writer's live timeline. A missing file is an empty
  // timeline (no ticks - nothing covered that day).
  function timeline(day) {
    if (live && day === currentDay) return Promise.resolve(live);
    if (lru.has(day)) {
      const tl = lru.get(day);
      cacheDay(tl);
      return Promise.resolve(tl);
    }
    return readDayText(day).then(function (text) {
      return text === null ? newTimeline(day) : timelineFromText(day, text);
    }).then(function (tl) {
      cacheDay(tl);
      return tl;
    });
  }

  // Gzip a finished raw day file and remove the raw original. NEVER
  // replaces an existing archive's content (audit F4): if a .gz already
  // exists, the raw file is kept whole only when it already contains the
  // archive (a crash between writing the .gz and unlinking the raw);
  // otherwise the two are concatenated, archive first, so no record is
  // lost - replay rejects the out-of-order join as a break, which reads as
  // a gap, never as a wrong state. Best-effort: any error leaves the files.
  function gunzipText(buf) {
    return new Promise(function (resolve, reject) {
      zlib.gunzip(buf, function (err, out) { if (err) reject(err); else resolve(out.toString("utf8")); });
    });
  }
  function compress(file) {
    return fs.promises.readFile(file, "utf8").then(function (raw) {
      return fs.promises.readFile(file + ".gz").then(gunzipText, function (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }).then(function (old) {
        let text = raw;
        if (old !== null && !raw.startsWith(old)) {
          text = old + (old && old[old.length - 1] !== "\n" ? "\n" : "") + raw;
          log("[continuity] " + path.basename(file) + " met an existing archive - merged, nothing overwritten");
        }
        return new Promise(function (resolve, reject) {
          zlib.gzip(Buffer.from(text, "utf8"), function (err, gz) { if (err) reject(err); else resolve(gz); });
        });
      }).then(function (gz) {
        return fs.promises.writeFile(file + ".gz", gz);
      }).then(function () {
        return fs.promises.unlink(file);
      });
    }).catch(function () {});
  }

  function listDays() {
    return fs.promises.readdir(dir).then(function (names) {
      const days = {};
      names.forEach(function (n) {
        const m = FILE_RE.exec(n);
        if (m) (days[m[1]] = days[m[1]] || []).push(n);
      });
      return days;
    });
  }

  function cutoffDay(now) { return utcDay(now - retentionDays * DAY_MS); }

  function prune(now) {
    const cutoff = cutoffDay(now);
    return listDays().then(function (days) {
      const ops = [];
      Object.keys(days).forEach(function (day) {
        if (day >= cutoff) return;
        lru.delete(day);
        days[day].forEach(function (n) {
          ops.push(fs.promises.unlink(path.join(dir, n)).catch(function () {}));
        });
      });
      return Promise.all(ops);
    }).catch(function () {});
  }

  // since = the first recorded tick of the oldest retained day with any.
  function refreshSince(now) {
    const cutoff = cutoffDay(now);
    return listDays().then(function (days) {
      const sorted = Object.keys(days).filter(function (d) { return d >= cutoff; }).sort();
      let chain = Promise.resolve(null);
      sorted.forEach(function (day) {
        chain = chain.then(function (found) {
          if (found !== null) return found;
          return timeline(day).then(function (tl) { return tl.tickT.length ? tl.tickT[0] : null; });
        });
      });
      return chain;
    }).then(function (first) {
      since = first !== null ? first : (live && live.tickT.length ? live.tickT[0] : null);
    }).catch(function () {});
  }

  // The newest tick recorded on disk in any retained day - the monotonic
  // guard's floor at boot, so a clock that restarts BEHIND recorded history
  // (even on an earlier UTC day) cannot open and overwrite that history.
  function newestTick() {
    return listDays().then(function (days) {
      const sorted = Object.keys(days).sort().reverse();
      let chain = Promise.resolve(null);
      sorted.forEach(function (day) {
        chain = chain.then(function (found) {
          if (found !== null) return found;
          return timeline(day).then(function (tl) {
            return tl.tickT.length ? tl.tickT[tl.tickT.length - 1] : null;
          });
        });
      });
      return chain;
    }).catch(function () { return null; });
  }

  // Boot: gzip raw past-day files a previous process left behind, prune,
  // replay today's file into the live timeline, then find `since`.
  function init() {
    const now = clock();
    currentDay = utcDay(now);
    return fs.promises.mkdir(dir, { recursive: true }).then(function () {
      return listDays();
    }).then(function (days) {
      const ops = [];
      Object.keys(days).forEach(function (day) {
        if (day < currentDay && days[day].indexOf("continuity-" + day + ".jsonl") >= 0) {
          ops.push(compress(fileFor(dir, day)));
        }
      });
      return Promise.all(ops);
    }).then(function () {
      return prune(now);
    }).then(function () {
      return fs.promises.readFile(fileFor(dir, currentDay), "utf8").catch(function (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      });
    }).then(function (text) {
      if (text === null) {
        live = newTimeline(currentDay);
        dayBytes = 0;
        return null;
      }
      dayBytes = Buffer.byteLength(text, "utf8");
      needNewline = text.length > 0 && text[text.length - 1] !== "\n";
      return timelineFromText(currentDay, text, true).then(function (tl) { live = tl; });
    }).then(function () {
      return newestTick();
    }).then(function (t) {
      lastT = t;
      return refreshSince(now);
    });
  }

  // Serialize the current served state. Sync and cheap (no I/O): this is
  // the cost reported as lastTickMs.
  function snapshot(now) {
    const encs = new Map();
    for (let i = 0; i < state.order.length; i++) {
      const name = state.order[i];
      const coin = state.coins[name];
      if (!coin) continue;
      encs.set(name, encode(servedContinuity(state, coin, ftfcTfs, now)));
    }
    return encs;
  }

  // One tick: snapshot, build a keyframe or delta, rotate on a UTC day
  // change, append. Never throws; failures count and surface as lastError,
  // and the tick after a failure is a keyframe. A tick that fires while the
  // previous one is still writing is skipped (counted), so a stalled disk
  // cannot build a backlog.
  function tickOnce(now) {
    now = now === undefined ? clock() : now;
    if (inFlight) { skipped++; return Promise.resolve(); }
    if (currentDay === null) { fail("tick before init - start() has not completed"); return Promise.resolve(); }
    // Monotonic guard, checked BEFORE any day state changes (audit F4): a
    // clock step backwards - even across midnight - must not rotate into
    // an earlier day, open a fresh file for it and later overwrite that
    // day's archive. The tick is refused (counted, a break) and the writer
    // resumes once the clock passes the newest recorded tick.
    if (lastT !== null && now <= lastT) {
      fail("clock is behind the newest recorded tick (" + new Date(lastT).toISOString() + ") - tick refused");
      return Promise.resolve();
    }
    inFlight = true;
    let rec, line, encs, isKey, day, bucket;
    try {
      const t0 = process.hrtime.bigint();
      day = utcDay(now);
      encs = snapshot(now);
      bucket = Math.floor(now / keyframeMs);
      isKey = needKeyframe || bucket !== lastKeyBucket || day !== currentDay;
      const c = {};
      if (isKey) {
        encs.forEach(function (e, name) { c[name] = e; });
        rec = { t: now, v: V, k: 1, boot: bootId, tfs: ftfcTfs, c: c };
      } else {
        encs.forEach(function (e, name) { if (written.get(name) !== e) c[name] = e; });
        written.forEach(function (e, name) { if (!encs.has(name)) c[name] = null; });
        rec = { t: now, v: V, c: c };
      }
      line = JSON.stringify(rec) + "\n";
      lastTickMs = Number(process.hrtime.bigint() - t0) / 1e6;
    } catch (e) {
      fail("tick failed: " + (e && e.message));
      inFlight = false;
      return Promise.resolve();
    }

    let rotation = Promise.resolve();
    if (currentDay !== day) {
      const prevDay = currentDay;
      if (live) {
        live.cur = null;
        cacheDay(live);
      }
      live = newTimeline(day);
      currentDay = day;
      dayBytes = 0;
      needNewline = false;
      if (prevDay) {
        rotation = compress(fileFor(dir, prevDay)).then(function () {
          return prune(now);
        }).then(function () { return refreshSince(now); });
      }
    }

    return rotation.then(function () {
      if (!needStat) return null;
      // After a failed append the file may hold a partial line and bytes
      // dayBytes never counted: re-read the size from disk.
      return fs.promises.stat(fileFor(dir, day)).then(function (st) { dayBytes = st.size; }, function (e) {
        if (e.code === "ENOENT") { dayBytes = 0; return; }
        throw e;
      }).then(function () { needStat = false; });
    }).then(function () {
      const out = (needNewline ? "\n" : "") + line;
      const bytes = Buffer.byteLength(out, "utf8");
      if (dayBytes + bytes > maxDayBytes) {
        throw new Error("day file ceiling reached (" + maxDayBytes + " bytes) - not appending until the next UTC day");
      }
      return fs.promises.appendFile(fileFor(dir, day), out).then(function () {
        dayBytes += bytes;
        needNewline = false;
        written = encs;
        if (isKey) lastKeyBucket = bucket;
        needKeyframe = false;
        applyRecord(live, rec);
        lastT = now;
        samples++;
        lastSampleTs = now;
        lastError = null;
        if (since === null) since = now;
      });
    }).catch(function (e) {
      // The append may have written a PREFIX before failing (a full disk):
      // fence the next write onto a fresh line and re-count the file, so
      // the recovery keyframe cannot be glued to a fragment (audit F3).
      needNewline = true;
      needStat = true;
      fail("append failed: " + (e && e.message));
    }).then(function () {
      inFlight = false;
    });
  }

  function start() {
    ready = init().then(function () {
      log("[continuity] sampling every " + Math.round(sampleMs / 1000) + "s, keyframe every "
        + Math.round(keyframeMs / 60000) + " min, retention " + retentionDays + " d -> " + dir
        + " (boot " + bootId + ")");
      const first = tickOnce();
      timer = setInterval(function () {
        try { tickOnce(); } catch (e) { fail("tick threw: " + (e && e.message)); }
      }, sampleMs);
      if (timer.unref) timer.unref();
      return first;
    }).catch(function (e) {
      fail("disabled - init failed: " + (e && e.message));
    });
    return ready;
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // The last tick at or before t, searching t's day then the day before.
  function tickBefore(t) {
    const day = utcDay(t);
    return timeline(day).then(function (tl) {
      const i = lastAtOrBefore(tl.tickT, t);
      if (i >= 0) return { tl: tl, i: i };
      return timeline(utcDay(dayStart(day) - 1)).then(function (prev) {
        return prev.tickT.length ? { tl: prev, i: prev.tickT.length - 1 } : null;
      });
    });
  }

  // The first tick strictly after the tick at (tl, i), or null when there
  // is none yet (the next day is only consulted when it has begun).
  function tickAfter(tl, i, now) {
    if (i + 1 < tl.tickT.length) return Promise.resolve({ t: tl.tickT[i + 1], boot: tl.tickBoot[i + 1], brk: false });
    const next = utcDay(dayStart(tl.day) + DAY_MS);
    if (next > utcDay(now)) return Promise.resolve(null);
    return timeline(next).then(function (ntl) {
      if (ntl.brkAtStart) return { t: null, boot: null, brk: true };
      return ntl.tickT.length ? { t: ntl.tickT[0], boot: ntl.tickBoot[0], brk: false } : null;
    });
  }

  function lookupOne(coin, t, now) {
    if (t > now || t < now - retentionDays * DAY_MS) return Promise.resolve(notCovered(coin, t));
    return tickBefore(t).then(function (hit) {
      if (!hit) return notCovered(coin, t);
      const at = hit.tl.tickT[hit.i];
      const atBoot = hit.tl.tickBoot[hit.i];
      if (t - at > gapMs) return notCovered(coin, t);
      // A recorded break after this tick (a rejected line or a failed
      // write): what followed it is unknown, so only t ON the tick is
      // covered (audit F1).
      if (t > at && hit.tl.brk.has(hit.i)) return notCovered(coin, t);
      return tickAfter(hit.tl, hit.i, now).then(function (next) {
        if (next && next.brk && t > at) return notCovered(coin, t);
        // A restart between the tick and t: the next tick runs under a new
        // boot, or there is no next tick and the tick was an earlier boot's.
        // The old process died at an unknown moment after its last tick, so
        // that tail is a gap. t ON the tick is recorded state and stays
        // covered.
        const restarted = next ? next.boot !== atBoot : atBoot !== bootId;
        if (restarted && t > at) return notCovered(coin, t);
        const enc = encAt(hit.tl, coin, at);
        if (enc === null) return notCovered(coin, t);
        let served;
        try { served = decode(enc); } catch (e) { return notCovered(coin, t); }
        return {
          coin: coin, t: t, covered: true, at: at,
          ftfc: served.ftfc, dots: served.dots,
          dwmContinuity: served.dwmContinuity, ready: served.ready
        };
      });
    });
  }

  // Batch lookup, answers in request order. Items are processed grouped by
  // day (each day decoded at most once per request) and requests are
  // serialized through one queue, yielding to the event loop between items,
  // so a burst on this public route cannot stack decode work on the loop.
  //
  // Admission (audit F6): at most maxQueue requests are held (running +
  // waiting); beyond that the call rejects at once with code "busy" and
  // retains nothing. An accepted request stops before its next item once
  // opts.isCancelled() is true (the client went away) or its deadline
  // passes (rejects "timeout" at the deadline; the slot frees when the
  // work actually stops, so the bound holds on real work, not promises).
  function withCode(msg, code) { const e = new Error(msg); e.code = code; return e; }
  function continuityAt(items, callOpts) {
    callOpts = callOpts || {};
    if (queued >= maxQueue) {
      busyRefused++;
      return Promise.reject(withCode("continuity lookup queue full", "busy"));
    }
    queued++;
    let expired = false;
    const stopped = function () {
      return expired || (typeof callOpts.isCancelled === "function" && callOpts.isCancelled());
    };
    const work = readQueue.then(function () {
      return ready || Promise.resolve();
    }).then(function () {
      const now = clock();
      const out = new Array(items.length);
      const order = items.map(function (_, i) { return i; }).sort(function (a, b) {
        return items[a].t - items[b].t;
      });
      let chain = Promise.resolve();
      order.forEach(function (idx) {
        chain = chain.then(function () {
          if (stopped()) throw withCode("continuity lookup stopped", expired ? "timeout" : "cancelled");
          return lookupOne(items[idx].coin, items[idx].t, now);
        }).then(function (r) {
          out[idx] = r;
          return yieldLoop();
        });
      });
      return chain.then(function () { return out; });
    });
    const settled = work.then(function () {}, function () {});
    readQueue = settled;
    settled.then(function () { queued--; });
    let timer = null;
    const deadline = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        expired = true;
        timedOut++;
        reject(withCode("continuity lookup timed out", "timeout"));
      }, requestTimeoutMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([work, deadline]).then(function (v) {
      clearTimeout(timer);
      return v;
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function health() {
    return {
      enabled: true,
      since: since,
      sample_ms: sampleMs,
      keyframe_ms: keyframeMs,
      retention_days: retentionDays,
      samples: samples,
      lastSampleTs: lastSampleTs,
      lastTickMs: lastTickMs === null ? null : Math.round(lastTickMs * 100) / 100,
      lastError: lastError,
      errors: errors,
      skipped: skipped,
      dayBytes: dayBytes,
      queued: queued,
      busyRefused: busyRefused,
      timedOut: timedOut
    };
  }

  function summary() { return { since: since, sample_ms: sampleMs }; }

  return {
    start: start, stop: stop, tickOnce: tickOnce, continuityAt: continuityAt,
    health: health, summary: summary,
    whenReady: function () { return ready || Promise.resolve(); }
  };
}

module.exports = {
  createContinuityLedger, encode, decode,
  SAMPLE_MS, KEYFRAME_MS, RETENTION_DAYS, GAP_MS, MAX_DAY_BYTES, MAX_QUEUE, REQUEST_TIMEOUT_MS
};
