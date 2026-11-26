// src/lib/candles.ts: parsing, merging, live folding, the MFP chart
// source, websocket channels and price precision.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyLive, candleWindow, CHART_TFS, chartSourceForMfp, decimalsFor, dedupeLines, mergeBars, orderLine, parseHlCandles,
  parseHlWsBbo, parseHlWsCandle, parseHlWsMids, tfSpec,
} from "../src/lib/candles.ts";

test("timeframes: 1m 3m 5m 15m 30m 1h 4h 1D", () => {
  assert.deepEqual(CHART_TFS.map((t) => t.id), ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"]);
  assert.equal(tfSpec("3m").ms, 180e3);
  assert.equal(tfSpec("1d").label, "1D");
});

test("candleSnapshot rows parse to ascending bars in seconds; junk rows drop", () => {
  const b = parseHlCandles([
    { t: 1700000900000, o: "2", h: "3", l: "1", c: "2.5", v: "10" },
    { t: 1700000000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 5 },
    { t: 1700000300000, o: 1, h: 0.5, l: 2, c: 1.5, v: 5 },   // high < low
    "junk",
  ]);
  assert.deepEqual(b.map((x) => x.time), [1700000000, 1700000900]);
  assert.equal(b[1].close, 2.5);
  assert.equal(parseHlCandles({}), null);
});

test("mergeBars and applyLive", () => {
  const a = [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { time: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  const m = mergeBars(a, [{ time: 2, open: 9, high: 9, low: 9, close: 9, volume: 9 }, { time: 3, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  assert.deepEqual(m.map((x) => x.time), [1, 2, 3]);
  assert.equal(m[1].close, 9);
  assert.equal(applyLive(a, { time: 2, open: 5, high: 5, low: 5, close: 5, volume: 5 })[1].close, 5);
  assert.equal(applyLive(a, { time: 3, open: 5, high: 5, low: 5, close: 5, volume: 5 }).length, 3);
  assert.equal(applyLive(a, { time: 0, open: 5, high: 5, low: 5, close: 5, volume: 5 }).length, 2);
});

test("websocket channels: candle, allMids, bbo", () => {
  const c = parseHlWsCandle({ channel: "candle", data: { t: 1700000000000, T: 1700000899999, s: "BTC", i: "15m", o: "1", h: "2", l: "0.5", c: "1.5", v: "3", n: 4 } });
  assert.equal(c.coin, "BTC"); assert.equal(c.interval, "15m"); assert.equal(c.bar.time, 1700000000);
  assert.equal(parseHlWsCandle({ channel: "pong" }), null);
  assert.deepEqual(parseHlWsMids({ channel: "allMids", data: { mids: { BTC: "80000.5", "xyz:NVDA": "190.1", BAD: "x" } } }), { BTC: 80000.5, "xyz:NVDA": 190.1 });
  assert.deepEqual(parseHlWsBbo({ channel: "bbo", data: { coin: "BTC", time: 1, bbo: [{ px: "79999", sz: "1", n: 1 }, { px: "80001", sz: "1", n: 1 }] } }), { coin: "BTC", bid: 79999, ask: 80001 });
  assert.deepEqual(parseHlWsBbo({ channel: "bbo", data: { coin: "BTC", time: 1, bbo: [null, { px: "80001", sz: "1", n: 1 }] } }), { coin: "BTC", bid: null, ask: 80001 });
});

test("candle window and precision", () => {
  assert.deepEqual(candleWindow("15m", 1700000000000, 2), { startTime: 1700000000000 - 1800000, endTime: 1700000000000 });
  assert.equal(decimalsFor(81000), 1);
  assert.equal(decimalsFor(190.1), 2);
  assert.equal(decimalsFor(1.5), 3);
  assert.equal(decimalsFor(0.0000123), 8);
});

test("MFP chart source: the Hyperliquid market itself, else the same base asset, labelled", () => {
  const hl = new Set(["BTC", "kPEPE", "xyz:NVDA", "xyz:GOLD"]);
  assert.deepEqual(chartSourceForMfp({ provider: "hyperliquid", coin: "BTC", symbol: "BTC" }, hl), { coin: "BTC", note: null });
  assert.equal(chartSourceForMfp({ provider: "binance", coin: "BTCUSDT", symbol: "BTC" }, hl).coin, "BTC");
  assert.match(chartSourceForMfp({ provider: "binance", coin: "BTCUSDT", symbol: "BTC" }, hl).note, /MFP fills on binance/);
  assert.equal(chartSourceForMfp({ provider: "binance", coin: "1000PEPEUSDT", symbol: "1000PEPE" }, hl).coin, "kPEPE");
  assert.equal(chartSourceForMfp({ provider: "binance", coin: "NVDAUSDT", symbol: "NVDA" }, hl).coin, "xyz:NVDA");
  assert.equal(chartSourceForMfp({ provider: "x", coin: "XAUUSD", symbol: "XAU" }, hl).coin, "xyz:GOLD");
  assert.equal(chartSourceForMfp({ provider: "binance", coin: "ZZZUSDT", symbol: "ZZZ" }, hl), null);
});

test("dedupeLines merges titles at one price", () => {
  const out = dedupeLines([{ price: 1, tone: "info", title: "a", style: "solid", width: 1 }, { price: 1, tone: "bear", title: "b", style: "dashed", width: 2 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "a / b");
  assert.equal(out[0].width, 2);
});

test("a working order's price line: side colour, solid when resting, dashed when pending", () => {
  const o = { side: "buy", kind: "limit", price: 64000, size: 0.01 };
  assert.deepEqual(orderLine(o, "MFP", false), [{ price: 64000, tone: "bull", title: "MFP limit buy 0.01", style: "solid", width: 1 }]);
  assert.deepEqual(orderLine({ ...o, side: "sell" }, "HL", true), [{ price: 64000, tone: "bear", title: "HL limit sell 0.01 (pending)", style: "dashed", width: 1 }]);
  assert.equal(orderLine({ ...o, kind: "other" }, "MFP", false)[0].title, "MFP order buy 0.01");   // a stop entry
  assert.equal(orderLine({ ...o, kind: "sl" }, "MFP", false)[0].title, "MFP sl buy 0.01");
  for (const bad of [0, -1, NaN, Infinity, null, undefined]) assert.deepEqual(orderLine({ ...o, price: bad }, "MFP", false), []);
  // two orders at one price share a line
  assert.equal(dedupeLines([...orderLine(o, "MFP", false), ...orderLine({ ...o, size: 0.02 }, "MFP", false)])[0].title, "MFP limit buy 0.01 / MFP limit buy 0.02");
});
