// Round-trip reconstruction, stats, buckets, continuity and codec tests for
// src/lib/trades.ts. Runs with `npm test` (node --test; the .ts source loads
// through Node's type stripping, no build step). Fixture wallets are the
// obviously fake 0x000...0001 / 0002 - never a real address.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyFunding, bucketize, classifyTfc, closedIn, computeStats, concentrationSentence,
  decimate, decodeFill, encodeFill, foldFunding, joinTfc, lossConcentrations, makeNyTime,
  mergeFills, mfpPortfolioWindows, nyOffsetMsByRule, parseFill, parseFundingRow, parseLedgerAnswers, parsePortfolio, pnlSeries,
  providerFromStamps,
  reconstructTrades, splitCoin, tradesFromMfp,
} from "../src/lib/trades.ts";

const W1 = "0x0000000000000000000000000000000000000001";
const W2 = "0x0000000000000000000000000000000000000002";
const T0 = Date.UTC(2026, 8, 1, 14, 0, 0); // 2026-09-01 10:00 ET
const M = 60e3, H = 3600e3;

let nextTid = 1000;
function fill(o) {
  const tid = o.tid ?? nextTid++;
  return {
    tid, oid: o.oid ?? tid, time: o.t ?? T0, coin: o.coin ?? "xyz:AAPL", side: o.side,
    px: o.px, sz: o.sz, startPosition: o.start ?? 0, closedPnl: o.pnl ?? 0,
    fee: o.fee ?? 0, builderFee: o.bfee ?? 0, feeToken: o.feeToken ?? "USDC",
    dir: o.dir ?? "", liquidatedUser: o.liq ?? null,
  };
}
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const ny = makeNyTime();

test("F1 long round trip: entry/exit, pnl, fees, return, duration", () => {
  const { trades, diag } = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0, fee: 0.1, dir: "Open Long", t: T0 }),
    fill({ side: "A", px: 110, sz: 1, start: 1, pnl: 10, fee: 0.11, dir: "Close Long", t: T0 + 2 * H }),
  ]);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.side, "long"); assert.equal(t.status, "closed"); assert.equal(t.truncated, false);
  assert.equal(t.entryAvgPx, 100); assert.equal(t.exitAvgPx, 110);
  assert.equal(t.grossPnl, 10); approx(t.fees, 0.21); approx(t.netPnl, 9.79);
  approx(t.returnPct, 9.79); assert.equal(t.durationMs, 2 * H);
  assert.equal(t.fills, 2); assert.equal(t.orders, 2); assert.equal(t.closeReason, "manual");
  assert.equal(t.funding, null); assert.equal(diag.dirMismatch, 0);
  assert.equal(t.dex, "xyz"); assert.equal(t.sym, "AAPL");
});

test("F2 short round trip", () => {
  const { trades } = reconstructTrades(W1, [
    fill({ side: "A", px: 50, sz: 2, start: 0, dir: "Open Short" }),
    fill({ side: "B", px: 45, sz: 2, start: -2, pnl: 10, dir: "Close Short", t: T0 + H }),
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "short"); assert.equal(trades[0].grossPnl, 10); assert.equal(trades[0].exitAvgPx, 45);
});

test("F3 one order, three fills in the same millisecond", () => {
  const { trades } = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 0.5, start: 0, oid: 7, tid: 1 }),
    fill({ side: "B", px: 100, sz: 0.3, start: 0.5, oid: 7, tid: 2 }),
    fill({ side: "B", px: 100, sz: 0.2, start: 0.8, oid: 7, tid: 3 }),
    fill({ side: "A", px: 101, sz: 1, start: 1, pnl: 1, oid: 8, tid: 4, t: T0 + M }),
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].fills, 4); assert.equal(trades[0].orders, 2); assert.equal(trades[0].maxSize, 1);
});

test("F4 partial closes stay one trade; exit is size-weighted", () => {
  const { trades } = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 2, start: 0 }),
    fill({ side: "A", px: 110, sz: 1, start: 2, pnl: 10, t: T0 + M }),
    fill({ side: "A", px: 120, sz: 1, start: 1, pnl: 20, t: T0 + 2 * M }),
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].grossPnl, 30); assert.equal(trades[0].exitAvgPx, 115); assert.equal(trades[0].closeTime, T0 + 2 * M);
});

test("F5 scale-in gives a size-weighted entry", () => {
  const { trades } = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0 }),
    fill({ side: "B", px: 120, sz: 1, start: 1, t: T0 + M }),
    fill({ side: "A", px: 130, sz: 2, start: 2, pnl: 40, t: T0 + 2 * M }),
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryAvgPx, 110); assert.equal(trades[0].maxSize, 2);
});

test("F6 add after a partial close: maxSize tracks the peak, still one trade", () => {
  const { trades } = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 3, start: 0 }),
    fill({ side: "A", px: 110, sz: 2, start: 3, pnl: 20, t: T0 + M }),
    fill({ side: "B", px: 105, sz: 2, start: 1, t: T0 + 2 * M }),
    fill({ side: "A", px: 108, sz: 3, start: 3, pnl: 14, t: T0 + 3 * M }),
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].maxSize, 3); assert.equal(trades[0].entryAvgPx, 102); assert.equal(trades[0].grossPnl, 34);
});

test("F7 flip in one fill: close leg carries the pnl, fee splits pro rata, second trade born at the flip", () => {
  const { trades, diag } = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0, fee: 0.1, dir: "Open Long", tid: 1 }),
    fill({ side: "A", px: 110, sz: 3, start: 1, pnl: 10, fee: 0.3, dir: "Long > Short", tid: 2, t: T0 + M }),
    fill({ side: "B", px: 100, sz: 2, start: -2, pnl: 20, fee: 0.2, dir: "Close Short", tid: 3, t: T0 + 2 * M }),
  ]);
  assert.equal(trades.length, 2);
  const long = trades.find((t) => t.side === "long"), short = trades.find((t) => t.side === "short");
  assert.equal(long.grossPnl, 10); approx(long.fees, 0.1 + 0.1); assert.equal(long.closeTime, T0 + M);
  assert.equal(short.openTime, T0 + M); assert.equal(short.entryAvgPx, 110); assert.equal(short.maxSize, 2);
  approx(short.fees, 0.2 + 0.2); assert.equal(short.grossPnl, 20);
  assert.ok(short.id.endsWith(":o")); assert.equal(diag.dirMismatch, 0);
});

test("F7b same-millisecond fills chain by startPosition, not by tid (seen live)", () => {
  // tid order says the 0.19 top-up came first; the venue's startPosition says the 0.69 opener did.
  const { trades, diag } = reconstructTrades(W1, [
    fill({ side: "B", px: 45.1, sz: 0.19, start: 0.69, tid: 7327662498454, t: T0 }),
    fill({ side: "B", px: 45.0, sz: 0.69, start: 0, tid: 397480185398168, t: T0 }),
    fill({ side: "A", px: 46.0, sz: 0.88, start: 0.88, pnl: 0.8, tid: 9, t: T0 + H }),
  ]);
  assert.equal(diag.gaps, 0);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].truncated, false); assert.equal(trades[0].status, "closed");
  approx(trades[0].maxSize, 0.88); assert.equal(trades[0].legs[0].size, 0.69);
});

test("F8 shuffled input gives identical output", () => {
  const fills = [
    fill({ side: "B", px: 100, sz: 2, start: 0, tid: 1 }),
    fill({ side: "A", px: 110, sz: 1, start: 2, pnl: 10, tid: 2, t: T0 + M }),
    fill({ side: "A", px: 120, sz: 1, start: 1, pnl: 20, tid: 3, t: T0 + 2 * M }),
  ];
  const a = reconstructTrades(W1, fills).trades;
  const b = reconstructTrades(W1, [fills[2], fills[0], fills[1]]).trades;
  assert.deepEqual(a, b);
});

test("F9 a trade still open at the end has no close, no duration, net = -fees", () => {
  const { trades } = reconstructTrades(W1, [fill({ side: "B", px: 100, sz: 1, start: 0, fee: 0.05 })]);
  assert.equal(trades[0].status, "open"); assert.equal(trades[0].closeTime, null);
  assert.equal(trades[0].durationMs, null); approx(trades[0].netPnl, -0.05);
  assert.equal(closedIn(trades, "all", T0 + H).length, 0);
});

test("F10 history that starts mid-position is a truncated trade, excluded from stats", () => {
  const { trades } = reconstructTrades(W1, [
    fill({ side: "A", px: 110, sz: 1, start: 2, pnl: 5, t: T0 }),
    fill({ side: "A", px: 115, sz: 1, start: 1, pnl: 7, t: T0 + M }),
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].truncated, true); assert.equal(trades[0].openTime, null);
  assert.equal(trades[0].status, "closed"); assert.equal(trades[0].grossPnl, 12);
  assert.equal(closedIn(trades, "all", T0 + H).length, 0);
});

test("F11 a chain gap closes the current trade as truncated and reopens from startPosition", () => {
  const { trades, diag } = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0, t: T0 }),
    fill({ side: "A", px: 120, sz: 1, start: 2, pnl: 20, t: T0 + M }),
  ]);
  assert.equal(diag.gaps, 1);
  assert.equal(trades.length, 2);
  assert.ok(trades.every((t) => t.truncated));
  const survivor = trades.find((t) => t.status === "open");
  assert.ok(survivor); assert.equal(survivor.maxSize, 2);
});

test("F12 dust residue reads flat; a real residual stays open", () => {
  const dust = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0 }),
    fill({ side: "A", px: 110, sz: 0.9999999999, start: 1, pnl: 10, t: T0 + M }),
  ]).trades;
  assert.equal(dust.length, 1); assert.equal(dust[0].status, "closed");
  const real = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0 }),
    fill({ side: "A", px: 110, sz: 0.9, start: 1, pnl: 9, t: T0 + M }),
  ]).trades;
  assert.equal(real[0].status, "open");
});

test("F13 dex and symbol split", () => {
  assert.deepEqual(splitCoin("xyz:AAPL"), { dex: "xyz", sym: "AAPL" });
  assert.deepEqual(splitCoin("BTC"), { dex: "", sym: "BTC" });
  const { trades } = reconstructTrades(W1, [
    fill({ coin: "BTC", side: "B", px: 100, sz: 1, start: 0 }),
    fill({ coin: "BTC", side: "A", px: 101, sz: 1, start: 1, pnl: 1, t: T0 + M }),
  ]);
  assert.equal(trades[0].dex, ""); assert.equal(trades[0].sym, "BTC");
});

test("F14 own liquidation, counterparty liquidation, ADL", () => {
  const own = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0 }),
    fill({ side: "A", px: 80, sz: 1, start: 1, pnl: -20, liq: W1.toUpperCase(), t: T0 + M }),
  ]).trades[0];
  assert.equal(own.closeReason, "liquidation");
  const counter = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0 }),
    fill({ side: "A", px: 101, sz: 1, start: 1, pnl: 1, liq: W2, t: T0 + M }),
  ]).trades[0];
  assert.equal(counter.closeReason, "manual");
  const byDir = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0 }),
    fill({ side: "A", px: 80, sz: 1, start: 1, pnl: -20, dir: "Liquidated Long", t: T0 + M }),
  ]).trades[0];
  assert.equal(byDir.closeReason, "liquidation");
  const adl = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0 }),
    fill({ side: "A", px: 105, sz: 1, start: 1, pnl: 5, dir: "Auto-Deleveraging", t: T0 + M }),
  ]).trades[0];
  assert.equal(adl.closeReason, "adl");
});

test("F15 spot rows and zero-size rows are dropped by parseFill", () => {
  assert.equal(parseFill({ coin: "PURR/USDC", side: "B", px: "1", sz: "1", startPosition: "0", time: 1, tid: 1 }), null);
  assert.equal(parseFill({ coin: "@1", side: "B", px: "1", sz: "1", startPosition: "0", time: 1, tid: 1 }), null);
  assert.equal(parseFill({ coin: "BTC", side: "B", px: "1", sz: "0", startPosition: "0", time: 1, tid: 1 }), null);
  assert.equal(parseFill(null), null);
});

test("F16 rebate (negative fee) plus builderFee", () => {
  const { trades } = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0, fee: -0.01, bfee: 0.02 }),
    fill({ side: "A", px: 101, sz: 1, start: 1, pnl: 1, fee: -0.01, bfee: 0.02, t: T0 + M }),
  ]);
  approx(trades[0].fees, 0.02); approx(trades[0].netPnl, 0.98);
});

test("F17 a docs-shaped raw fill parses (strings to numbers, liquidation object)", () => {
  const f = parseFill({
    coin: "xyz:AAPL", px: "324.87", sz: "0.034", side: "B", time: 1788364066147, startPosition: "0.384",
    dir: "Open Long", closedPnl: "0.0", hash: "0x00", oid: 534141304794, crossed: false, fee: "0.001422",
    builderFee: "0.001104", tid: 970562375136619, cloid: "0xa7", feeToken: "USDC", twapId: null,
    liquidation: { liquidatedUser: W2, markPx: "300", method: "market" },
  });
  assert.ok(f);
  assert.equal(f.px, 324.87); assert.equal(f.sz, 0.034); assert.equal(f.startPosition, 0.384);
  assert.equal(f.builderFee, 0.001104); assert.equal(f.liquidatedUser, W2); assert.equal(f.side, "B");
});

test("F18 funding folds into the trade whose window contains the row", () => {
  const { trades } = reconstructTrades(W1, [
    fill({ coin: "xyz:TSLA", side: "B", px: 100, sz: 1, start: 0, t: T0 }),
    fill({ coin: "xyz:TSLA", side: "A", px: 101, sz: 1, start: 1, pnl: 1, t: T0 + 2 * H }),
    fill({ coin: "xyz:TSLA", side: "B", px: 100, sz: 1, start: 0, t: T0 + 5 * H }),
  ]);
  const closedT = trades.find((t) => t.status === "closed"), openT = trades.find((t) => t.status === "open");
  const rows = [
    { time: T0 + H, coin: "xyz:TSLA", usdc: -0.5, hash: "a" },      // inside the closed trade
    { time: T0 + 3 * H, coin: "xyz:TSLA", usdc: -9, hash: "b" },    // between trades: nobody
    { time: T0 + H, coin: "xyz:AAPL", usdc: -7, hash: "c" },        // other coin
    { time: T0 + 6 * H, coin: "xyz:TSLA", usdc: 0.25, hash: "d" },  // open trade, still accruing
  ];
  const map = foldFunding(trades, rows, T0 + 7 * H);
  assert.equal(map.get(closedT.id), -0.5); assert.equal(map.get(openT.id), 0.25);
  const applied = applyFunding(trades, map, () => true);
  const c = applied.find((t) => t.id === closedT.id);
  approx(c.netPnl, 1 - 0.5);
  const partial = applyFunding(trades, map, (t) => t.id !== closedT.id);
  assert.equal(partial.find((t) => t.id === closedT.id).funding, null);
  assert.equal(parseFundingRow({ time: 1, hash: "0x0", delta: { type: "funding", coin: "xyz:TSLA", usdc: "-0.001052", szi: "0.479", fundingRate: "0.00000625" } }).usdc, -0.001052);
  assert.equal(parseFundingRow({ time: 1, delta: { coin: 5 } }), null);
});

function roundTrip(o) {
  const openT = o.t, closeT = o.t + o.hold;
  return [
    fill({ coin: o.coin, side: o.side === "long" ? "B" : "A", px: 100, sz: 1, start: 0, t: openT, fee: 0.05 }),
    fill({ coin: o.coin, side: o.side === "long" ? "A" : "B", px: 100 + (o.side === "long" ? o.pnl : -o.pnl), sz: 1, start: o.side === "long" ? 1 : -1, pnl: o.pnl, t: closeT, fee: 0.05 }),
  ];
}

test("F19 stats, buckets, best/worst and loss concentrations over twelve trades", () => {
  // Deliberate shape: shorts carry most of the losses while being a minority of trades.
  const spec = [
    { coin: "xyz:AAPL", side: "long", pnl: 12, hold: 2 * H, t: T0 },
    { coin: "xyz:AAPL", side: "long", pnl: 8, hold: 3 * H, t: T0 + 4 * H },
    { coin: "xyz:TSLA", side: "long", pnl: 5, hold: 20 * M, t: T0 + 8 * H },
    { coin: "xyz:TSLA", side: "long", pnl: -3, hold: 2 * M, t: T0 + 10 * H },
    { coin: "BTC", side: "long", pnl: 6, hold: 30 * H, t: T0 + 12 * H },
    { coin: "BTC", side: "long", pnl: 4, hold: 6 * H, t: T0 + 44 * H },
    { coin: "ETH", side: "long", pnl: -2, hold: 10 * M, t: T0 + 51 * H },
    { coin: "ETH", side: "long", pnl: 3, hold: 40 * M, t: T0 + 52 * H },
    { coin: "xyz:NVDA", side: "short", pnl: -15, hold: 3 * M, t: T0 + 54 * H },
    { coin: "xyz:NVDA", side: "short", pnl: -11, hold: 4 * M, t: T0 + 55 * H },
    { coin: "xyz:GOLD", side: "short", pnl: -9, hold: 2 * M, t: T0 + 56 * H },
    { coin: "xyz:GOLD", side: "short", pnl: 2, hold: 5 * H, t: T0 + 57 * H },
  ];
  const fills = spec.flatMap(roundTrip);
  const { trades } = reconstructTrades(W1, fills);
  assert.equal(trades.length, 12);
  const now = T0 + 70 * H;
  const week = closedIn(trades, "week", now);
  assert.equal(week.length, 12);
  const s = computeStats(week);
  assert.equal(s.count, 12); assert.equal(s.wins, 7); assert.equal(s.losses, 5);
  approx(s.winRate, 7 / 12);
  approx(s.netPnl, spec.reduce((a, x) => a + x.pnl, 0) - 12 * 0.1);
  assert.ok(s.profitFactor > 0 && s.profitFactor < 2);
  assert.equal(s.best[0].sym, "AAPL"); assert.equal(s.worst[0].sym, "NVDA"); approx(s.worst[0].netPnl, -15.1);
  assert.equal(s.longWins, 6); assert.equal(s.shortLosses, 3);
  // percent view: returns on entry notional (entry 100, size 1 -> pnl - 0.1 fees, in %)
  approx(s.avgWinPct, (12 + 8 + 5 + 6 + 4 + 3 + 2 - 7 * 0.1) / 7, 1e-9);
  approx(s.avgLossPct, (-3 - 2 - 15 - 11 - 9 - 5 * 0.1) / 5, 1e-9);
  approx(s.expectancyPct, s.netPnl / 12, 1e-9);
  approx(s.largestWinPct, 11.9, 1e-9); approx(s.largestLossPct, -15.1, 1e-9);
  const o = { ny };
  const bySide = bucketize(week, "side", o);
  assert.deepEqual(bySide.map((b) => b.key).sort(), ["long", "short"]);
  assert.equal(bySide.find((b) => b.key === "short").losses, 3);
  approx(bySide.find((b) => b.key === "short").avgReturnPct, (-15 - 11 - 9 + 2 - 4 * 0.1) / 4, 1e-9);
  assert.equal(computeStats([]).avgWinPct, null);
  assert.equal(bucketize([], "side", o).length, 0);
  const byHold = bucketize(week, "hold", o);
  assert.ok(byHold.find((b) => b.key === "lt5m").losses >= 4);
  const byHour = bucketize(week, "hour", o);
  assert.ok(byHour.every((b) => /^\d{2}:00 ET$/.test(b.label)));
  const conc = lossConcentrations(week, o, ["side", "coin", "hold", "tfc"]);
  assert.ok(conc.length >= 2 && conc.length <= 3);
  assert.equal(new Set(conc.map((c) => c.dim)).size, conc.length, "distinct dims");
  const sideC = conc.find((c) => c.dim === "side");
  assert.ok(sideC && sideC.key === "short"); assert.ok(sideC.lossShare > 0.8); assert.ok(sideC.score > 0.4);
  assert.ok(!conc.some((c) => c.dim === "tfc"), "unknown continuity is never ranked");
  const sentence = concentrationSentence(sideC, (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(2));
  assert.match(sentence, /^Shorts: \d+% of losses from \d+% of trades \(3 losers, avg -\$\d+\.\d\d\)$/);
  assert.deepEqual(lossConcentrations([], o), []);
});

test("F20 New York time: Intl and the fixed rule agree, including the 2026 DST edges", () => {
  const rule = makeNyTime(null);
  assert.equal(rule.source, "rule");
  const instants = [
    [Date.UTC(2026, 0, 15, 17, 0), 12, 4],
    [Date.UTC(2026, 6, 15, 16, 0), 12, 3],
    [Date.UTC(2026, 2, 8, 6, 59), 1, 0],   // 01:59 EST, seconds before spring-forward
    [Date.UTC(2026, 2, 8, 7, 0), 3, 0],    // 03:00 EDT
    [Date.UTC(2026, 10, 1, 5, 59), 1, 0],  // 01:59 EDT, before fall-back
    [Date.UTC(2026, 10, 1, 6, 0), 1, 0],   // 01:00 EST after fall-back
    [Date.UTC(2026, 8, 1, 3, 30), 23, 1],  // 23:30 EDT Monday (UTC Tuesday)
    [Date.UTC(2026, 11, 31, 23, 0), 18, 4],
  ];
  for (const [t, h, w] of instants) {
    assert.equal(rule.hour(t), h, "rule hour " + new Date(t).toISOString());
    assert.equal(rule.weekday(t), w, "rule weekday " + new Date(t).toISOString());
    if (ny.source === "intl") {
      assert.equal(ny.hour(t), h, "intl hour " + new Date(t).toISOString());
      assert.equal(ny.weekday(t), w, "intl weekday " + new Date(t).toISOString());
    }
  }
  assert.equal(nyOffsetMsByRule(Date.UTC(2026, 6, 1)), -4 * H);
  assert.equal(nyOffsetMsByRule(Date.UTC(2026, 0, 1)), -5 * H);
});

test("F21 portfolio history parses both shapes, re-bases to zero, decimates", () => {
  const pairs = [["perpWeek", { accountValueHistory: [[1, "10"], [2, "12"]], pnlHistory: [[1, "3.5"], [2, "5"]], vlm: "99" }]];
  const a = parsePortfolio(pairs), b = parsePortfolio({ perpWeek: pairs[0][1] });
  assert.deepEqual(a, b);
  assert.equal(a.perpWeek.vlm, 99);
  assert.deepEqual(pnlSeries(a.perpWeek), [[1, 0], [2, 1.5]]);
  assert.deepEqual(pnlSeries(undefined), []);
  const big = Array.from({ length: 2000 }, (_, i) => [i, Math.sin(i / 7) * 10]);
  const d = decimate(big, 500);
  assert.ok(d.length <= 500 * 3 && d.length >= 500);
  assert.equal(d[0][0], 0); assert.equal(d[d.length - 1][0], 1999);
  const max = Math.max(...big.map((p) => p[1])), min = Math.min(...big.map((p) => p[1]));
  assert.ok(d.some((p) => p[1] === max) && d.some((p) => p[1] === min), "extremes survive");
  assert.deepEqual(decimate(big.slice(0, 10), 500), big.slice(0, 10));
});

test("F22 continuity stamps: threshold, four statuses, provider precedence", () => {
  const { trades } = reconstructTrades(W1, [
    fill({ side: "B", px: 100, sz: 1, start: 0, t: T0 }),
    fill({ side: "A", px: 101, sz: 1, start: 1, pnl: 1, t: T0 + H }),
  ]);
  const t = trades[0];
  const stamp = (over) => ({ wallet: W1, coin: "xyz:AAPL", openTime: T0, observedAt: T0 + 40e3, stateTs: T0 + 30e3, ftfc: "up", dots: ["up", "up", "up", "up"], dwm: null, source: "device", lagMs: null, ...over });
  assert.equal(classifyTfc(t, null), "unknown");
  assert.equal(classifyTfc(t, stamp()), "with");
  assert.equal(classifyTfc(t, stamp({ ftfc: "down" })), "against");
  assert.equal(classifyTfc(t, stamp({ ftfc: "mixed" })), "mixed");
  assert.equal(classifyTfc(t, stamp({ ftfc: null })), "unknown");
  assert.equal(classifyTfc(t, stamp({ observedAt: T0 + 6 * M })), "unknown", "late stamp");
  assert.equal(classifyTfc({ ...t, side: "short" }, stamp()), "against");
  const late = { get: () => stamp({ observedAt: T0 + 4 * M, source: "device" }) };
  const worker = { get: () => stamp({ observedAt: T0 + 15 * M, source: "worker", lagMs: 0 }) };
  const joined = joinTfc(trades, [late, worker]);
  assert.equal(joined[0].tfc.source, "worker");
  assert.equal(joinTfc(trades, [{ get: () => null }])[0].tfc, null);
});

test("F23 compact codec round-trips; merge dedupes by tid and evicts oldest", () => {
  const f = fill({ side: "B", px: 1.5, sz: 2, start: 0, fee: 0.01, bfee: 0.002, dir: "Open Long", liq: W2, t: T0, tid: 5, oid: 9 });
  assert.deepEqual(decodeFill(encodeFill(f)), f);
  assert.equal(decodeFill([1, 2]), null);
  const existing = [fill({ side: "B", px: 1, sz: 1, start: 0, t: T0, tid: 1 }), fill({ side: "A", px: 1, sz: 1, start: 1, t: T0 + M, tid: 2 })];
  const incoming = [fill({ side: "A", px: 2, sz: 1, start: 1, t: T0 + M, tid: 2 }), fill({ side: "B", px: 1, sz: 1, start: 0, t: T0 + 2 * M, tid: 3 })];
  const merged = mergeFills(existing, incoming, { maxFills: 100, maxAgeMs: 365 * 86400e3, now: T0 + 3 * M });
  assert.deepEqual(merged.map((x) => x.tid), [1, 2, 3]);
  assert.equal(merged[1].px, 2, "incoming wins on a tid collision");
  const capped = mergeFills(existing, incoming, { maxFills: 2, maxAgeMs: 365 * 86400e3, now: T0 + 3 * M });
  assert.deepEqual(capped.map((x) => x.tid), [2, 3]);
  const aged = mergeFills(existing, incoming, { maxFills: 100, maxAgeMs: 150e3, now: T0 + 3 * M });
  assert.deepEqual(aged.map((x) => x.tid), [2, 3]);
  // eviction mid-position leaves a truncated trade through the startPosition rule
  const { trades } = reconstructTrades(W1, capped);
  assert.ok(trades.some((t) => t.truncated));
});

// ---- MyFundedPerps closed positions -----------------------------------------
// The four sandbox round trips read 2026-10-23 (fake ids). Their balance moved
// by exactly -0.228938 = sum(realized_pnl - fees + funding).
const MFP_ROWS = [
  { id: "c4", provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "short", size: 0.001, entryPrice: 81238.4, exitPrice: 81238.5, openedAt: 4000, closedAt: 5000, realizedPnl: -0.0001, fees: 0.048744, funding: 0, closeReason: "user" },
  { id: "c3", provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "long", size: 0.001, entryPrice: 81238.7, exitPrice: 81238.5, openedAt: 3000, closedAt: 3900, realizedPnl: -0.0002, fees: 0.048744, funding: 0, closeReason: "user" },
  { id: "c2", provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "short", size: 0.001, entryPrice: 81187.8, exitPrice: 81195.4, openedAt: 2000, closedAt: 2900, realizedPnl: -0.0076, fees: 0.048715, funding: 0, closeReason: "liquidation" },
  { id: "c1", provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "long", size: 0.001, entryPrice: 81212.9, exitPrice: 81187.8, openedAt: 1000, closedAt: 1900, realizedPnl: -0.0251, fees: 0.04872, funding: -0.001015, closeReason: null },
];

test("MFP closed positions map to whole closed trades: net = gross - fees + funding, newest first", () => {
  const ts = tradesFromMfp([...MFP_ROWS].reverse(), "mfp:acct", () => "BTC");
  assert.deepEqual(ts.map((t) => t.id), ["mfp:c4", "mfp:c3", "mfp:c2", "mfp:c1"]);
  const sum = ts.reduce((s, t) => s + t.netPnl, 0);
  assert.ok(Math.abs(sum - -0.228938) < 1e-9, "the trades explain the sandbox balance change exactly");
  const t1 = ts[3];
  assert.equal(t1.status, "closed");
  assert.equal(t1.truncated, false);
  assert.equal(t1.wallet, "mfp:acct");
  assert.equal(t1.coin, "BTC");
  assert.equal(t1.sym, "BTC");
  assert.equal(t1.grossPnl, -0.0251);
  assert.equal(t1.funding, -0.001015);
  assert.ok(Math.abs(t1.netPnl - (-0.0251 - 0.04872 - 0.001015)) < 1e-12);
  assert.equal(t1.durationMs, 900);
  assert.ok(Math.abs(t1.returnPct - (t1.netPnl / 81.2129) * 100) < 1e-9);
  assert.deepEqual(t1.legs, []);
  assert.deepEqual(ts.map((t) => t.closeReason), ["manual", "manual", "liquidation", "unknown"]);
  // Computed stats treat them like any closed trade.
  const st = computeStats(ts);
  assert.equal(st.count, 4);
  assert.equal(st.losses, 4);
});

test("MFP coin mapping: a Hyperliquid equivalent sets coin and dex; none leaves an unserved mfp: coin", () => {
  const [x] = tradesFromMfp([{ ...MFP_ROWS[0], provider: "hyperliquid", symbol: "AAPL" }], "mfp:a", () => "xyz:AAPL");
  assert.equal(x.coin, "xyz:AAPL");
  assert.equal(x.dex, "xyz");
  const [y] = tradesFromMfp([{ ...MFP_ROWS[0], symbol: "NEWCOIN" }], "mfp:a", () => null);
  assert.equal(y.coin, "mfp:NEWCOIN");
  assert.equal(y.dex, "");
  assert.equal(y.sym, "NEWCOIN");
});

test("MFP equity windows: realized steps from the starting balance, open PnL on the last point", () => {
  const ts = tradesFromMfp(MFP_ROWS, "mfp:acct", () => "BTC");
  const now = 10000;
  const w = mfpPortfolioWindows(ts, 100000, 0.5, now);
  const all = w.perpAllTime;
  assert.deepEqual(all.pnlHistory[0], [1000, 0], "All starts at the first open with nothing realized");
  assert.equal(all.pnlHistory.length, 6, "start + four closes + now");
  const last = all.pnlHistory[all.pnlHistory.length - 1];
  assert.equal(last[0], now);
  assert.ok(Math.abs(last[1] - (-0.228938 + 0.5)) < 1e-9);
  assert.ok(Math.abs(all.accountValueHistory[all.accountValueHistory.length - 1][1] - (100000 - 0.228938 + 0.5)) < 1e-6);
  // pnlSeries re-bases on the window's first point, as for a Hyperliquid wallet.
  const s = pnlSeries(all);
  assert.equal(s[0][1], 0);
  // A 24 h window ending at now covers every close here; a window that
  // starts after the first two closes carries them in its starting level.
  const day = w.perpDay;
  assert.deepEqual(day.pnlHistory[0], [now - 86400e3, 0]);
  // Open PnL rides only on All: a shorter window cannot know how much of it
  // accrued inside the window.
  assert.ok(Math.abs(day.pnlHistory[day.pnlHistory.length - 1][1] - -0.228938) < 1e-9);
  // A close stamped after `now` keeps the end point at or after it.
  const skew = mfpPortfolioWindows(ts, 100000, null, 4500).perpAllTime.pnlHistory;
  assert.equal(skew[skew.length - 1][0], 5000);
  assert.ok(skew.every((p, i) => i === 0 || p[0] >= skew[i - 1][0]), "time never runs backwards");
  const late = mfpPortfolioWindows(ts, 100000, null, 86400e3 + 3000).perpDay;
  assert.equal(late.pnlHistory[0][0], 3000);
  const firstTwo = ts.filter((t) => t.closeTime < 3000).reduce((a, t) => a + t.netPnl, 0);
  assert.ok(Math.abs(late.pnlHistory[0][1] - firstTwo) < 1e-12);
  assert.equal(late.pnlHistory.length, 1 + 2 + 1, "start + the two later closes + now");
  assert.ok(Math.abs(all.vlm - ts.reduce((a, t) => a + 0.001 * (t.entryAvgPx + t.exitAvgPx), 0)) < 1e-9);
  // No trades: a flat line at the balance.
  const none = mfpPortfolioWindows([], 50000, null, now).perpAllTime;
  assert.deepEqual(none.pnlHistory, [[now, 0], [now, 0]]);
});

test("MFP trades join the worker ledger through the mapped Hyperliquid coin (wallet key case-insensitive)", () => {
  const ts = tradesFromMfp(MFP_ROWS, "mfp:Acct_1", () => "BTC");
  const asked = ts.map((t) => ({ coin: t.coin, t: t.openTime }));
  // The worker's reply shape, as answered live 2026-10-23 for these coins.
  const reply = asked.map((q) => ({
    coin: q.coin, t: q.t, covered: true, at: q.t - 500, ftfc: "down", dots: ["down", "down", "down", "down"],
    dwmContinuity: { complete: true, dir: "down", dots: { "1d": "down", "1w": "down", "1M": "down" } }, ready: true,
  }));
  const answers = parseLedgerAnswers(reply, asked, "mfp:acct_1", 10000);
  const stamps = answers.filter((a) => a.kind === "stamp").map((a) => a.stamp);
  assert.equal(stamps.length, 4);
  const joined = joinTfc(ts, [providerFromStamps(stamps)]);
  // Fast continuity DOWN: the shorts were with it, the longs against it.
  assert.deepEqual(joined.map((t) => t.side + ":" + classifyTfc(t, t.tfc)), ["short:with", "long:against", "short:with", "long:against"]);
  // An unmapped MFP coin never matches a served stamp.
  const [lonely] = tradesFromMfp([MFP_ROWS[0]], "mfp:Acct_1", () => null);
  assert.equal(joinTfc([lonely], [providerFromStamps(stamps)])[0].tfc, null);
});
