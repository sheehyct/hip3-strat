// src/lib/hl_orders.ts: asset ids, exact action payloads for every
// permitted action, the refusals, the runtime guard and response parsing.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertScopedAction, assetIdFor, buildCancelAction, buildClosePositionOrder, buildLeverageAction, buildLimitOrder,
  buildMarketOrder, buildModifyAction, buildTriggerOrder, floatToWire, hlOrderFate, newCloid, parseCancelResponse,
  parseOrderResponse, parseSimpleResponse, reverseGate, reversePreCheck, roundPx, roundSz,
} from "../src/lib/hl_orders.ts";

const AAPL = { coin: "xyz:AAPL", assetId: assetIdFor(0, 5), szDecimals: 3, dex: "xyz", index: 5, maxLeverage: 10 };
const ETH = { coin: "ETH", assetId: assetIdFor(null, 1), szDecimals: 4, dex: "", index: 1, maxLeverage: 50 };
const CL = "0x" + "a".repeat(32);

test("asset ids: main dex is the index, xyz (builder 0) is 110000 + index", () => {
  assert.equal(assetIdFor(null, 1), 1);
  assert.equal(assetIdFor(0, 5), 110005);
  assert.equal(assetIdFor(1, 0), 120000);
  assert.throws(() => assetIdFor(null, -1));
  assert.throws(() => assetIdFor(0, 1.5));
});

test("floatToWire matches the SDK's rules", () => {
  assert.equal(floatToWire(100), "100");
  assert.equal(floatToWire(229.09), "229.09");
  assert.equal(floatToWire(0.42), "0.42");
  assert.equal(floatToWire(1.5e-7), "0.00000015");
  assert.throws(() => floatToWire(0.1 + 0.2 + 1e-9 + 1e-13), /rounding/);
  assert.throws(() => floatToWire(NaN));
});

test("roundPx / roundSz reproduce broker.py", () => {
  assert.equal(roundPx(231.4 * 0.99, 3), 229.09);
  assert.equal(roundPx(231.4 * 1.01, 3), 233.71);
  assert.equal(roundPx(65846.9 * 0.99, 5), 65188);
  assert.equal(roundPx(0.0737123, 0), 0.073712);
  assert.equal(roundSz(0.4299, 2), 0.42);
  assert.equal(roundSz(1.0000000001, 3), 1);
  assert.throws(() => roundPx(0, 3));
});

test("cloids are 0x + 32 hex, time-prefixed, distinct", () => {
  const a = newCloid(1700000000000, () => 0.5);
  assert.match(a, /^0x[0-9a-f]{32}$/);
  assert.notEqual(newCloid(1700000000000, () => 0.1), newCloid(1700000000000, () => 0.9));
  assert.equal(newCloid(1700000000000, () => 0.5), a);
});

test("buildMarketOrder: IoC capped away from mid, exact wire in SDK key order", () => {
  const buy = buildMarketOrder(AAPL, true, 0.42, 231.4, 0.01, false, CL);
  assert.deepEqual(buy.action, { type: "order", orders: [{ a: 110005, b: true, p: "233.71", s: "0.42", r: false, t: { limit: { tif: "Ioc" } }, c: CL }], grouping: "na" });
  assert.deepEqual(Object.keys(buy.wire), ["a", "b", "p", "s", "r", "t", "c"]);
  assert.deepEqual(Object.keys(buy.action), ["type", "orders", "grouping"]);
  const sell = buildMarketOrder(ETH, false, 0.05, 1863.5, 0.01, true, CL);
  assert.equal(sell.wire.p, "1844.9"); assert.equal(sell.wire.r, true); assert.equal(sell.side, "SELL");
  assert.throws(() => buildMarketOrder(AAPL, true, 1, 231.4, 0.051, false, CL), /slippage/);   // above 5 percent
  assert.throws(() => buildMarketOrder(AAPL, true, 1, 231.4, 0, false, CL), /slippage/);
  assert.throws(() => buildMarketOrder(AAPL, true, 1, 0, 0.01, false, CL), /no mid/);
  assert.throws(() => buildMarketOrder(AAPL, true, 0.0001, 231.4, 0.01, false, CL), /size step/);
  assert.throws(() => buildMarketOrder(AAPL, true, 1, 231.4, 0.01, false, "0x12"), /cloid/);
  assert.doesNotThrow(() => buildMarketOrder(AAPL, true, 1, 231.4, 0.05, false, CL), "5 percent exactly is allowed");
});

test("buildLimitOrder: Gtc or Alo, rounded price", () => {
  const o = buildLimitOrder(ETH, true, 1.5, 1863.456, "Gtc", false, CL);
  assert.deepEqual(o.action, { type: "order", orders: [{ a: 1, b: true, p: "1863.5", s: "1.5", r: false, t: { limit: { tif: "Gtc" } }, c: CL }], grouping: "na" });
  assert.equal(buildLimitOrder(ETH, true, 1.5, 1863.5, "Alo", true, CL).wire.t.limit.tif, "Alo");
  assert.throws(() => buildLimitOrder(ETH, true, 1.5, 1863.5, "Ioc", false, CL), /Gtc or Alo/);
  assert.throws(() => buildLimitOrder(ETH, true, 1.5, 0, "Gtc", false, CL), /price/);
});

test("buildTriggerOrder: reduce-only market trigger on the closing side, never more than the position", () => {
  // long 2 ETH: TP sells above, SL sells below
  const tp = buildTriggerOrder(ETH, 2, "tp", 2000, 2, CL, 1863.5);
  // p sits 1 percent THROUGH the trigger on the closing side (a sell: below)
  assert.deepEqual(tp.action, { type: "order", orders: [{ a: 1, b: false, p: "1980", s: "2", r: true, t: { trigger: { isMarket: true, triggerPx: "2000", tpsl: "tp" } }, c: CL }], grouping: "na" });
  const sl = buildTriggerOrder(ETH, 2, "sl", 1800, 2, CL, 1863.5);
  assert.equal(sl.wire.b, false); assert.equal(sl.wire.t.trigger.tpsl, "sl"); assert.equal(sl.wire.p, "1782");
  const stpBuy = buildTriggerOrder(ETH, -2, "sl", 1900, 2, CL, 1863.5);
  assert.equal(stpBuy.wire.b, true); assert.equal(stpBuy.wire.p, "1919", "a buy trigger's p sits above the trigger");
  assert.throws(() => buildTriggerOrder(ETH, 2, "tp", 2000, 2, CL, 1863.5, 0.06), /slippage/);
  // short 0.5 AAPL: TP buys below, SL buys above
  const stp = buildTriggerOrder(AAPL, -0.5, "tp", 220, 0.5, CL, 231.4);
  assert.equal(stp.wire.b, true);
  assert.throws(() => buildTriggerOrder(ETH, 2, "tp", 1800, 2, CL, 1863.5), /must be above/);
  assert.throws(() => buildTriggerOrder(ETH, 2, "sl", 2000, 2, CL, 1863.5), /must be below/);
  assert.throws(() => buildTriggerOrder(ETH, -2, "tp", 2000, 2, CL, 1863.5), /must be below/);
  assert.throws(() => buildTriggerOrder(ETH, 2, "tp", 2000, 3, CL, 1863.5), /exceed the position/);
  assert.throws(() => buildTriggerOrder(ETH, 0, "tp", 2000, 1, CL, 1863.5), /no position/);
});

test("buildClosePositionOrder: a long sells below mid, a short buys above, reduce-only IoC, fraction never exceeds the position", () => {
  const long = buildClosePositionOrder({ coin: "xyz:AAPL", szi: 0.42 }, AAPL, 231.4, CL);
  assert.deepEqual(long.action, { type: "order", orders: [{ a: 110005, b: false, p: "229.09", s: "0.42", r: true, t: { limit: { tif: "Ioc" } }, c: CL }], grouping: "na" });
  const half = buildClosePositionOrder({ coin: "ETH", szi: -1 }, ETH, 1863.5, CL, 0.01, 0.5);
  assert.equal(half.wire.b, true); assert.equal(half.wire.s, "0.5"); assert.equal(half.wire.r, true);
  const q = buildClosePositionOrder({ coin: "ETH", szi: 0.0009 }, ETH, 1863.5, CL, 0.01, 0.25);
  assert.equal(q.wire.s, "0.0002", "floored to the size step");
  assert.throws(() => buildClosePositionOrder({ coin: "ETH", szi: 0.0003 }, ETH, 1863.5, CL, 0.01, 0.25), /size step/, "a fragment under one step is refused, not rounded up");
  assert.throws(() => buildClosePositionOrder({ coin: "ETH", szi: 1 }, AAPL, 100, CL), /asset row/);
  assert.throws(() => buildClosePositionOrder({ coin: "xyz:AAPL", szi: 0 }, AAPL, 100, CL), /no position/);
  assert.throws(() => buildClosePositionOrder({ coin: "xyz:AAPL", szi: 1 }, AAPL, 100, CL, 0.01, 1.5), /fraction/);
  assert.throws(() => buildClosePositionOrder({ coin: "xyz:AAPL", szi: 1 }, AAPL, 100, CL, 0.5), /slippage/);
});

test("cancel, modify and leverage actions", () => {
  assert.deepEqual(buildCancelAction([{ asset: AAPL, oid: 534160744038 }]), { type: "cancel", cancels: [{ a: 110005, o: 534160744038 }] });
  assert.throws(() => buildCancelAction([]));
  const repl = buildLimitOrder(ETH, true, 1, 1800, "Gtc", false, CL);
  assert.deepEqual(buildModifyAction(77, repl), { type: "modify", oid: 77, order: repl.wire });
  assert.throws(() => buildModifyAction(-1, repl), /oid/);
  assert.deepEqual(buildLeverageAction(ETH, true, 5), { type: "updateLeverage", asset: 1, isCross: true, leverage: 5 });
  assert.deepEqual(buildLeverageAction(AAPL, false, 10), { type: "updateLeverage", asset: 110005, isCross: false, leverage: 10 });
  assert.throws(() => buildLeverageAction(AAPL, false, 11), /maximum/);
  assert.throws(() => buildLeverageAction(AAPL, false, 2.5), /whole number/);
  assert.throws(() => buildLeverageAction(AAPL, false, 0), /whole number/);
});

test("assertScopedAction accepts exactly the permitted shapes", () => {
  const lim = { a: 1, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Gtc" } }, c: CL };
  const ok = [
    { type: "order", orders: [lim], grouping: "na" },
    { type: "order", orders: [{ ...lim, t: { limit: { tif: "Ioc" } } }], grouping: "na" },
    { type: "order", orders: [{ ...lim, t: { limit: { tif: "Alo" } } }], grouping: "na" },
    { type: "order", orders: [{ ...lim, r: true, t: { trigger: { isMarket: true, triggerPx: "1", tpsl: "sl" } } }], grouping: "na" },
    { type: "cancel", cancels: [{ a: 1, o: 2 }] },
    { type: "modify", oid: 3, order: lim },
    { type: "updateLeverage", asset: 1, isCross: false, leverage: 5 },
  ];
  for (const a of ok) assert.doesNotThrow(() => assertScopedAction(a), JSON.stringify(a));
  const bad = [
    { type: "order", orders: [lim, lim], grouping: "na" },                                  // two orders
    { type: "order", orders: [lim], grouping: "normalTpsl" },
    { type: "order", orders: [lim], grouping: "positionTpsl" },
    { type: "order", orders: [{ ...lim, c: undefined }], grouping: "na" },
    { type: "order", orders: [{ a: 1, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" }, // no cloid
    { type: "order", orders: [{ ...lim, c: "0x12" }], grouping: "na" },
    { type: "order", orders: [{ ...lim, t: { limit: { tif: "Gtd" } } }], grouping: "na" },
    { type: "order", orders: [{ ...lim, t: { trigger: { isMarket: true, triggerPx: "1", tpsl: "sl" } } }], grouping: "na" },  // trigger not reduce-only
    { type: "order", orders: [{ ...lim, r: true, t: { trigger: { isMarket: false, triggerPx: "1", tpsl: "sl" } } }], grouping: "na" },
    { type: "order", orders: [{ ...lim, r: true, t: { trigger: { isMarket: true, triggerPx: "1", tpsl: "x" } } }], grouping: "na" },
    { type: "order", orders: [{ ...lim, r: "false" }], grouping: "na" },
    { type: "order", orders: [{ ...lim, p: 1 }], grouping: "na" },
    { type: "order", orders: [{ ...lim, p: "0" }], grouping: "na" },
    { type: "order", orders: [lim], grouping: "na", builder: { b: "0x00", f: 1 } },
    { type: "order", orders: [], grouping: "na" },
    { type: "cancel", cancels: [{ a: 1, o: 2, extra: 1 }] },
    { type: "cancel", cancels: [] },
    { type: "modify", oid: 3, order: lim, extra: 1 },
    { type: "modify", oid: "3", order: lim },
    { type: "updateLeverage", asset: 1, isCross: "no", leverage: 5 },
    { type: "updateLeverage", asset: 1, isCross: true, leverage: 0 },
    { type: "updateLeverage", asset: 1, isCross: true, leverage: 5, vaultAddress: "0x00" },
    { type: "batchModify", modifies: [] },
    { type: "cancelByCloid", cancels: [] },
    { type: "usdSend", destination: "0x00", amount: "1", time: 1 },
    { type: "withdraw3", destination: "0x00", amount: "1", time: 1 },
    { type: "approveAgent", agentAddress: "0x00", agentName: "x", nonce: 1 },
    { type: "approveBuilderFee" }, { type: "spotSend" }, { type: "vaultTransfer" }, { type: "createSubAccount" },
    { type: "scheduleCancel" }, { type: "twapOrder" }, { type: "updateIsolatedMargin" }, { type: "usdClassTransfer" },
    null, 1, "order",
  ];
  for (const b of bad) assert.throws(() => assertScopedAction(b), undefined, JSON.stringify(b));
});

test("reversePreCheck and reverseGate (copied discipline)", () => {
  assert.equal(reversePreCheck(1.0, 1.0, 4), null);
  assert.match(reversePreCheck(1.0, 0.4, 4), /size changed/);
  assert.match(reversePreCheck(1.0, -1.0, 4), /changed side/);
  assert.match(reversePreCheck(1.0, 0, 4), /no position/);
  const ok = { venueSzi: 1.0, closeRequested: 1.0, closeFilled: 1.0, closeAmbiguous: false, closeResidual: 0, closeError: null, restingOnCoin: 0, szDecimals: 4 };
  assert.deepEqual(reverseGate(ok), { ok: true, size: 1.0 });
  assert.deepEqual(reverseGate({ ...ok, closeFilled: 0.4 }), { ok: true, size: 0.4 });
  assert.equal(reverseGate({ ...ok, closeResidual: 0.1 }).ok, false);
  assert.equal(reverseGate({ ...ok, restingOnCoin: 2 }).ok, false);
  assert.equal(reverseGate({ ...ok, restingOnCoin: null }).ok, false);
  assert.equal(reverseGate({ ...ok, closeError: "x" }).ok, false);
  assert.equal(reverseGate({ ...ok, venueSzi: NaN }).ok, false);
});

test("fuzz: every built market order is a single IoC with string p/s inside the cap, every close reduce-only on the closing side", () => {
  let n = 0;
  for (let szDecimals = 0; szDecimals <= 6; szDecimals++) {
    const asset = { coin: "xyz:X", assetId: assetIdFor(0, 7), szDecimals, dex: "xyz", index: 7, maxLeverage: 20 };
    for (const mag of [0.001, 0.05, 1, 12.5, 400, 1e6]) {
      for (const sign of [1, -1]) {
        for (const mid of [0.0123, 1, 97.19, 65846.9]) {
          let c;
          try { c = buildClosePositionOrder({ coin: asset.coin, szi: mag * sign }, asset, mid, CL); } catch (e) { continue; }
          assert.equal(c.wire.r, true); assert.equal(c.wire.b, sign < 0);
          assert.ok(parseFloat(c.wire.s) <= mag + 1e-12);
          const cap = parseFloat(c.wire.p);
          // price rounding (5 sig figs, 6 - szDecimals decimals) can swallow a
          // 1 percent cap on an unrealistic szDecimals / price pair; it never
          // crosses to the wrong side
          assert.ok(sign > 0 ? cap <= mid : cap >= mid, "cap on the closing side");
          assertScopedAction(c.action);
          n++;
        }
      }
    }
  }
  assert.ok(n > 200, "fuzz ran " + n);
});

test("responses parse", () => {
  assert.deepEqual(parseOrderResponse({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.42", avgPx: "229.71", oid: 5 } }] } } }), { kind: "filled", totalSz: 0.42, avgPx: 229.71, oid: 5 });
  assert.deepEqual(parseOrderResponse({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 7 } }] } } }), { kind: "resting", oid: 7 });
  assert.deepEqual(parseOrderResponse({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order must have minimum value of $10." }] } } }), { kind: "error", message: "Order must have minimum value of $10." });
  assert.deepEqual(parseOrderResponse({ status: "err", response: "Invalid nonce" }), { kind: "err", message: "Invalid nonce" });
  assert.equal(parseOrderResponse(null).kind, "malformed");
  assert.deepEqual(parseCancelResponse({ status: "ok", response: { type: "cancel", data: { statuses: ["success", { error: "Order was never placed" }] } } }), { ok: 1, errors: ["Order was never placed"] });
  assert.deepEqual(parseSimpleResponse({ status: "ok", response: { type: "default" } }), { kind: "ok" });
  assert.deepEqual(parseSimpleResponse({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Cannot modify" }] } } }), { kind: "error", message: "Cannot modify" });
  assert.deepEqual(parseSimpleResponse({ status: "err", response: "x" }), { kind: "err", message: "x" });
});

// ---- orderStatus -> what happened to an order this app sent --------------------

test("hlOrderFate: open and triggered can still change; filled is done with the whole size", () => {
  assert.deepEqual(hlOrderFate("open", 1, 1), { fate: "open", filled: 0 });
  assert.deepEqual(hlOrderFate("open", 1, 0.4), { fate: "open", filled: 0.6 });
  assert.deepEqual(hlOrderFate("triggered", 1, 1), { fate: "open", filled: 0 });
  assert.deepEqual(hlOrderFate("filled", 0.05, 0), { fate: "done", filled: 0.05 });
});

test("hlOrderFate: a canceled or rejected order keeps the part that executed (an IoC that matched some size)", () => {
  assert.deepEqual(hlOrderFate("canceled", 1, 0.6), { fate: "done", filled: 0.4 });
  assert.deepEqual(hlOrderFate("canceled", 1, 1), { fate: "done", filled: 0 });
  assert.deepEqual(hlOrderFate("marginCanceled", 1, 1), { fate: "done", filled: 0 });
  assert.deepEqual(hlOrderFate("reduceOnlyCanceled", 2, 0.5), { fate: "done", filled: 1.5 });
  assert.deepEqual(hlOrderFate("rejected", 1, 1), { fate: "done", filled: 0 });
  assert.deepEqual(hlOrderFate("tickRejected", 1, 1), { fate: "done", filled: 0 });
});

test("hlOrderFate: a status this app does not know stays unknown, never guessed as dead or filled", () => {
  assert.deepEqual(hlOrderFate("somethingNew", 1, 0), { fate: "unrecognized", filled: 0 });
  assert.deepEqual(hlOrderFate("", 1, 1), { fate: "unrecognized", filled: 0 });
});
