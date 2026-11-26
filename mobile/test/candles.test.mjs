// src/lib/candles.ts: candle parsing, live folding, the MFP chart-source
// mapping, and the served STRAT overlay (display of /api/state only).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyLive, candleWindow, chartSourceForMfp, CHART_TFS, dedupeLines, isChartTf, mergeBars, parseHlCandles,
  parseHlWsCandle, positionLines, servedOverlay, tfSpec,
} from "../src/lib/candles.ts";

const row = (t, o, h, l, c, v = "1") => ({ t, T: t + 59999, s: "BTC", i: "1m", o: String(o), c: String(c), h: String(h), l: String(l), v, n: 3 });
const always = () => true;

test("the seven chips, with the worker's TF keys where it serves them", () => {
  assert.deepEqual(CHART_TFS.map((t) => t.label), ["1m", "5m", "15m", "30m", "1h", "4h", "1D"]);
  assert.deepEqual(CHART_TFS.map((t) => t.served), [null, null, "15m", "30m", "1h", "4h", "1d"]);
  assert.equal(tfSpec("4h").ms, 14400e3);
  assert.equal(isChartTf("1d"), true);
  assert.equal(isChartTf("1w"), false);
});

test("candleSnapshot parses to ascending unique bars in seconds; junk rows drop; non-lists are null", () => {
  const bars = parseHlCandles([row(120000, 2, 3, 1, 2.5), row(60000, 1, 2, 0.5, 1.5), row(120000, 2, 4, 1, 3), { t: "x" }, row(180000, 1, 0.5, 1, 1)]);
  assert.deepEqual(bars.map((b) => b.time), [60, 120]);
  assert.equal(bars[1].high, 4);                      // later duplicate wins
  assert.equal(bars[0].volume, 1);
  assert.equal(parseHlCandles({ error: "x" }), null);
  assert.deepEqual(parseHlCandles([]), []);
});

test("live folding: replace the same bar, append a newer one, ignore an older one", () => {
  const bars = parseHlCandles([row(60000, 1, 2, 0.5, 1.5), row(120000, 2, 3, 1, 2.5)]);
  const same = applyLive(bars, { time: 120, open: 2, high: 3.5, low: 1, close: 3.2, volume: 9 });
  assert.equal(same.length, 2);
  assert.equal(same[1].close, 3.2);
  assert.equal(applyLive(bars, { time: 180, open: 3, high: 3, low: 3, close: 3, volume: 0 }).length, 3);
  assert.equal(applyLive(bars, { time: 0.5, open: 3, high: 3, low: 3, close: 3, volume: 0 }), bars);
  assert.equal(applyLive([], { time: 5, open: 1, high: 1, low: 1, close: 1, volume: 0 }).length, 1);
  assert.deepEqual(mergeBars(bars, [{ time: 30, open: 1, high: 1, low: 1, close: 1, volume: 0 }]).map((b) => b.time), [30, 60, 120]);
});

test("the WebSocket candle channel parses; other messages are null", () => {
  const m = parseHlWsCandle({ channel: "candle", data: row(60000, 1, 2, 0.5, 1.5) });
  assert.equal(m.coin, "BTC");
  assert.equal(m.interval, "1m");
  assert.equal(m.bar.time, 60);
  assert.equal(parseHlWsCandle({ channel: "pong" }), null);
  assert.equal(parseHlWsCandle({ channel: "subscriptionResponse", data: {} }), null);
  assert.equal(parseHlWsCandle("x"), null);
});

test("history windows hold the requested bar count", () => {
  const w = candleWindow("1h", 10 * 3600e3, 3);
  assert.deepEqual(w, { startTime: 7 * 3600e3, endTime: 10 * 3600e3 });
  assert.equal(candleWindow("1d", 1000, 300).startTime, 0);
});

test("MFP chart source: Hyperliquid markets direct, others via the same base on Hyperliquid, else none", () => {
  const hl = new Set(["BTC", "ETH", "kPEPE", "xyz:AAPL", "xyz:GOLD"]);
  assert.deepEqual(chartSourceForMfp({ provider: "hyperliquid", coin: "xyz:AAPL", symbol: "AAPL" }, hl), { coin: "xyz:AAPL", note: null });
  assert.equal(chartSourceForMfp({ provider: "binance", coin: "BTCUSDT", symbol: "BTC" }, hl).coin, "BTC");
  assert.match(chartSourceForMfp({ provider: "binance", coin: "BTCUSDT", symbol: "BTC" }, hl).note, /Hyperliquid BTC - MFP fills on binance/);
  assert.equal(chartSourceForMfp({ provider: "binance", coin: "1000PEPEUSDT", symbol: "1000PEPE" }, hl).coin, "kPEPE");
  assert.equal(chartSourceForMfp({ provider: "veranta", coin: "XAUUSD", symbol: "GOLD" }, hl).coin, "xyz:GOLD");
  assert.equal(chartSourceForMfp({ provider: "veranta", coin: "EURUSD", symbol: "EURUSD" }, hl), null);
  assert.equal(chartSourceForMfp({ provider: "hyperliquid", coin: "xyz:NOPE", symbol: "" }, hl), null);
});

const servedTf = (over = {}) => ({
  types: ["2U", "2D", "1"], formingType: "2U", forming: { t: 4 * 3600e3, T: 5 * 3600e3 - 1 }, invalidated: false,
  live: [{ name: "2-1-2U", dir: "up", entry: 101, stop: 99, target: 105 }],
  setups: [
    { name: "1-2D", dir: "down", trigger: 98, stop: 102, target: 95, kind: "rev" },
    { name: "info", dir: "up", trigger: 110, stop: 1, target: null, kind: "info" },
    { name: "3-2U", dir: "up", trigger: 103, stop: 97, target: 106, kind: "cont" },
    { name: "2U-2D", dir: "down", trigger: 96, stop: 103, target: 90, kind: "rev" },
  ],
  ...over,
});

test("overlay: live entry/stop/target, at most two setup triggers (rev first, info skipped), types at the worker's bar times", () => {
  const o = servedOverlay(servedTf(), 3600e3, 4.5 * 3600e3, always);
  // 1-2D and 2U-2D are rev and take the two slots; the 3-2U cont waits.
  assert.deepEqual(o.lines.map((l) => l.title), ["2-1-2U entry", "2-1-2U stop", "2-1-2U tgt", "1-2D trig", "2U-2D trig"]);
  assert.equal(o.lines[0].tone, "bull");
  assert.equal(o.lines[0].width, 2);
  assert.equal(o.lines[3].style, "dashed");
  assert.deepEqual(o.markers.map((m) => [m.time, m.text, m.forming]), [
    [3600, "2U", false], [7200, "2D", false], [10800, "1", false], [14400, "2U*", true],
  ]);
  assert.equal(o.markers[1].tone, "bear");
  assert.equal(o.lagBars, 0);
});

test("overlay: a setup whose name is already live is that signal (screener echo filter); conts are labelled", () => {
  const tf = servedTf({
    live: [{ name: "2D-2U", dir: "up", entry: 101, stop: 99, target: 105 }],
    setups: [
      { name: "2D-2U", dir: "up", trigger: 101, stop: 99, target: 105, kind: "rev" },
      { name: "3-1-2U", dir: "up", trigger: 103, stop: 97, target: 106, kind: "cont" },
    ],
  });
  const o = servedOverlay(tf, 3600e3, 4.5 * 3600e3, always);
  assert.deepEqual(o.lines.map((l) => l.title), ["2D-2U entry", "2D-2U stop", "2D-2U tgt", "3-1-2U (cont) trig"]);
});

test("overlay: out-of-force live signals are muted; invalidated TFs drop live signals except a 1-3 Rev Strat", () => {
  const out = servedOverlay(servedTf(), 3600e3, 4.5 * 3600e3, () => false);
  assert.equal(out.lines[0].tone, "muted");
  assert.equal(out.lines[1].tone, "muted");
  const inv = servedOverlay(servedTf({ invalidated: true }), 3600e3, 4.5 * 3600e3, always);
  assert.equal(inv.lines.some((l) => l.title.includes("entry")), false);
  const rev3 = servedOverlay(servedTf({ invalidated: true, live: [{ name: "1-3", dir: "up", entry: 101, stop: 99, target: null, rev3: true }] }), 3600e3, 4.5 * 3600e3, always);
  assert.equal(rev3.lines.some((l) => l.title === "1-3 entry"), true);
});

test("overlay: a forming bar that already closed reports how many bars the worker lags", () => {
  // forming 04:00-04:59:59.999, now 06:10 -> two bars behind
  const o = servedOverlay(servedTf(), 3600e3, 6 * 3600e3 + 600e3, always);
  assert.equal(o.lagBars, 2);
  assert.equal(o.markers.at(-1).time, 14400); // still placed on the bar it describes
  assert.deepEqual(servedOverlay(null, 3600e3, 0, always), { lines: [], markers: [], lagBars: 0 });
});

test("lines at one price collapse into one, keeping the heavier style", () => {
  const d = dedupeLines([
    { price: 100, tone: "bull", title: "a trig", style: "dashed", width: 1 },
    { price: 100, tone: "bear", title: "stop", style: "solid", width: 2 },
    { price: 100, tone: "bear", title: "stop", style: "solid", width: 2 },
  ]);
  assert.equal(d.length, 1);
  assert.equal(d[0].title, "a trig / stop");
  assert.equal(d[0].width, 2);
  assert.deepEqual(positionLines(81000, null).map((l) => l.title), ["your entry"]);
  assert.deepEqual(positionLines(null, 70000).map((l) => l.tone), ["bear"]);
});
