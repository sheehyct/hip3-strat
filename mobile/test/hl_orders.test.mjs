// src/lib/hl_orders.ts: asset ids, wire shapes, rounding against
// reference values (the Hyperliquid Python SDK's price rule), response
// parsing.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertScopedAction, assetIdFor, buildCancelAction, buildClosePositionOrder, buildReverseOpenOrder,
  floatToWire, parseCancelResponse, parseOrderResponse, previewReverseOpen, reverseGate, reversePreCheck,
  roundPx, roundSz,
} from "../src/lib/hl_orders.ts";

const AAPL = { coin: "xyz:AAPL", assetId: assetIdFor(0, 5), szDecimals: 3, dex: "xyz", index: 5 };
const ETH = { coin: "ETH", assetId: assetIdFor(null, 1), szDecimals: 4, dex: "", index: 1 };

// The real path to an opening leg: a clean, proven-flat close of closedSize
// passes reverseGate, and the builder takes that pass. A refused gate throws
// its reason, so the refusal tests read the gate's own words.
function openLeg(closed, asset, mid, slippage) {
  const pass = reverseGate({
    venueSzi: closed.closedSize, closeRequested: closed.closedSize, closeFilled: closed.closedSize,
    closeAmbiguous: false, closeResidual: 0, closeError: null, restingOnCoin: 0, szDecimals: asset.szDecimals,
  });
  if (!pass.ok) throw new Error(pass.reason);
  return buildReverseOpenOrder(pass, { coin: closed.coin, priorSzi: closed.priorSzi }, asset, mid, slippage);
}

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
  assert.equal(floatToWire(-1e-13), "0");                 // "-0.00000000" -> "-0" -> "0", within 1e-12
  assert.throws(() => floatToWire(-1e-10), /rounding/);   // the SDK raises here too: 1e-10 >= 1e-12
  assert.throws(() => floatToWire(0.1 + 0.2 + 1e-9 + 1e-13), /rounding/); // beyond 8 decimals
  assert.throws(() => floatToWire(NaN));
});

test("roundPx / roundSz reproduce the reference rounding", () => {
  // reference (Python): round(float(f"{px:.5g}"), max(0, 6 - szDecimals)); floor for size
  assert.equal(roundPx(231.4 * 0.99, 3), 229.09);
  assert.equal(roundPx(231.4 * 1.01, 3), 233.71);
  assert.equal(roundPx(65846.9 * 0.99, 5), 65188);       // 5 sig figs on a big price
  assert.equal(roundPx(0.0737123, 0), 0.073712);         // 6 decimals when szDecimals 0
  assert.equal(roundPx(1863.5 * 1.01, 4), 1882.1);
  assert.equal(roundSz(0.42, 3), 0.42);
  assert.equal(roundSz(0.4299, 2), 0.42);
  assert.equal(roundSz(1.0000000001, 3), 1);
  assert.equal(roundSz(53890.9, 0), 53890);
  assert.throws(() => roundPx(0, 3));
});

test("buildClosePositionOrder: a long sells below mid, a short buys above, reduce-only IoC, string p/s", () => {
  const long = buildClosePositionOrder({ coin: "xyz:AAPL", szi: 0.42 }, AAPL, 231.4);
  assert.deepEqual(long.action, { type: "order", orders: [{ a: 110005, b: false, p: "229.09", s: "0.42", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  assert.equal(long.side, "SELL"); assert.equal(long.capPx, 229.09); assert.equal(long.size, 0.42); assert.equal(long.dex, "xyz");
  // key order is what gets msgpack-encoded and signed (the SDK's a,b,p,s,r,t)
  assert.deepEqual(Object.keys(long.wire), ["a", "b", "p", "s", "r", "t"]);
  assert.deepEqual(Object.keys(long.action), ["type", "orders", "grouping"]);
  const short = buildClosePositionOrder({ coin: "ETH", szi: -0.05 }, ETH, 1863.5);
  assert.equal(short.side, "BUY"); assert.equal(short.wire.b, true); assert.equal(short.wire.p, "1882.1"); assert.equal(short.wire.s, "0.05"); assert.equal(short.wire.a, 1);
  assert.throws(() => buildClosePositionOrder({ coin: "ETH", szi: 1 }, AAPL, 100), /asset row/);
  assert.throws(() => buildClosePositionOrder({ coin: "xyz:AAPL", szi: 0 }, AAPL, 100), /no position/);
  assert.throws(() => buildClosePositionOrder({ coin: "xyz:AAPL", szi: 1 }, AAPL, 0), /no mid/);
  assert.throws(() => buildClosePositionOrder({ coin: "xyz:AAPL", szi: 0.0001 }, AAPL, 100), /size step/);
  assert.throws(() => buildClosePositionOrder({ coin: "xyz:AAPL", szi: 1 }, AAPL, 100, 0.5), /slippage/);
});

test("buildCancelAction", () => {
  assert.deepEqual(buildCancelAction([{ asset: AAPL, oid: 534160744038 }]), { type: "cancel", cancels: [{ a: 110005, o: 534160744038 }] });
  assert.throws(() => buildCancelAction([]));
});

test("assertScopedAction accepts exactly the permitted shapes", () => {
  assertScopedAction({ type: "order", orders: [{ a: 1, b: true, p: "1", s: "1", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  // The reverse's second leg passes only as buildReverseOpenOrder built it.
  assertScopedAction(openLeg({ coin: "ETH", priorSzi: 1, closedSize: 1 }, ETH, 4463.3).action);
  assertScopedAction({ type: "cancel", cancels: [{ a: 1, o: 2 }] });
  const open = { a: 1, b: true, p: "1", s: "1", r: false, t: { limit: { tif: "Ioc" } } };
  const close = { a: 1, b: true, p: "1", s: "1", r: true, t: { limit: { tif: "Ioc" } } };
  const built = openLeg({ coin: "ETH", priorSzi: 1, closedSize: 1 }, ETH, 4463.3).action;
  const bad = [
    { type: "order", orders: [open], grouping: "na" },                             // hand-built open
    { ...built },                                                                   // a copy of a built open
    { type: "order", orders: [{ ...built.orders[0], s: "1000000" }], grouping: "na" }, // resized copy
    { type: "order", orders: [open, open], grouping: "na" },                       // two opens
    { type: "order", orders: [close, open], grouping: "na" },                      // an open batched with a close
    { type: "order", orders: [open, close], grouping: "na" },
    { type: "order", orders: [{ ...open, t: { limit: { tif: "Gtc" } } }], grouping: "na" }, // a resting open
    { type: "order", orders: [{ ...open, t: { trigger: { isMarket: true, triggerPx: "1", tpsl: "sl" } } }], grouping: "na" },
    { type: "order", orders: [{ ...open, r: "false" }], grouping: "na" },          // not a boolean
    { type: "order", orders: [{ ...open, r: 0 }], grouping: "na" },
    { type: "order", orders: [{ a: 1, b: true, p: "1", s: "1", t: { limit: { tif: "Ioc" } } }], grouping: "na" }, // r missing
    { type: "order", orders: [{ a: 1, b: true, p: "1", s: "1", r: true, t: { limit: { tif: "Gtc" } } }], grouping: "na" },
    { type: "order", orders: [{ a: 1, b: true, p: "1", s: "1", r: true, t: { limit: { tif: "Alo" } } }], grouping: "na" },
    { type: "order", orders: [{ a: 1, b: true, p: "1", s: "1", r: true, t: { trigger: { isMarket: true, triggerPx: "1", tpsl: "sl" } } }], grouping: "na" },
    { type: "order", orders: [{ a: 1, b: true, p: "1", s: "1", r: true, t: { limit: { tif: "Ioc" } }, c: "0x00" }], grouping: "na" },
    { type: "order", orders: [{ a: 1, b: true, p: "1", s: "1", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na", builder: { b: "0x00", f: 1 } },
    { type: "order", orders: [{ a: 1, b: true, p: 1, s: "1", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" },
    { type: "order", orders: [{ a: 1, b: true, p: "0", s: "1", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" },
    { type: "order", orders: [], grouping: "na" },
    { type: "order", orders: [{ a: 1, b: true, p: "1", s: "1", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "normalTpsl" },
    { type: "cancel", cancels: [{ a: 1, o: 2, extra: 1 }] },
    { type: "cancel", cancels: [] },
    { type: "usdSend", destination: "0x00", amount: "1", time: 1 },
    { type: "withdraw3", destination: "0x00", amount: "1", time: 1 },
    { type: "approveAgent", agentAddress: "0x00", agentName: "x", nonce: 1 },
    { type: "updateLeverage", asset: 1, isCross: false, leverage: 5 },
    { type: "spotSend" }, { type: "vaultTransfer" }, { type: "createSubAccount" }, { type: "batchModify" }, { type: "scheduleCancel" },
    null, 1, "order",
  ];
  for (const b of bad) assert.throws(() => assertScopedAction(b), undefined, JSON.stringify(b));
});

test("buildReverseOpenOrder: opposite side of the closed position, same size, IoC, not reduce-only", () => {
  // A long of 0.42 AAPL reverses into a short: SELL, capped below mid.
  const s = openLeg({ coin: "xyz:AAPL", priorSzi: 0.42, closedSize: 0.42 }, AAPL, 231.4);
  assert.deepEqual(s.action, { type: "order", orders: [{ a: 110005, b: false, p: "229.09", s: "0.42", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  assert.equal(s.side, "SELL");
  // A short reverses into a long: BUY, capped above mid.
  const l = openLeg({ coin: "ETH", priorSzi: -1.5, closedSize: 1.5 }, ETH, 4463.3);
  assert.equal(l.side, "BUY");
  assert.equal(l.wire.b, true);
  assert.ok(l.capPx > 4463.3);
  // Key order is load-bearing for the signed hash: a, b, p, s, r, t.
  assert.deepEqual(Object.keys(s.wire), ["a", "b", "p", "s", "r", "t"]);
});

test("buildReverseOpenOrder refuses anything that is not a proven reverse", () => {
  assert.throws(() => openLeg({ coin: "xyz:AAPL", priorSzi: 0.42, closedSize: 0.5 }, AAPL, 231.4), /more than the position/);
  assert.throws(() => openLeg({ coin: "xyz:AAPL", priorSzi: 0, closedSize: 0.42 }, AAPL, 231.4), /no prior position/);
  assert.throws(() => openLeg({ coin: "xyz:AAPL", priorSzi: 0.42, closedSize: 0 }, AAPL, 231.4), /did not fill/);
  assert.throws(() => openLeg({ coin: "xyz:AAPL", priorSzi: 0.42, closedSize: 0.0001 }, AAPL, 231.4), /nothing was closed/); // below a size step
  assert.throws(() => openLeg({ coin: "ETH", priorSzi: 0.42, closedSize: 0.42 }, AAPL, 231.4), /asset row/);
  assert.throws(() => openLeg({ coin: "xyz:AAPL", priorSzi: 0.42, closedSize: 0.42 }, AAPL, 0), /no mid/);
  assert.throws(() => openLeg({ coin: "xyz:AAPL", priorSzi: 0.42, closedSize: 0.42 }, AAPL, 231.4, 0.5), /slippage/);
});

test("only a pass reverseGate issued can build a signable open; previews never sign", () => {
  const fake = Object.freeze({ ok: true, size: 1 });
  assert.throws(() => buildReverseOpenOrder(fake, { coin: "ETH", priorSzi: 1 }, ETH, 4463.3), /passed reverse gate/);
  assert.throws(() => buildReverseOpenOrder(null, { coin: "ETH", priorSzi: 1 }, ETH, 4463.3), /passed reverse gate/);
  const refused = reverseGate({ venueSzi: 1, closeRequested: 1, closeFilled: 1, closeAmbiguous: false, closeResidual: 0.5, closeError: null, restingOnCoin: 0, szDecimals: 4 });
  assert.throws(() => buildReverseOpenOrder(refused, { coin: "ETH", priorSzi: 1 }, ETH, 4463.3), /passed reverse gate/);
  const pv = previewReverseOpen({ coin: "ETH", priorSzi: 1, closedSize: 1 }, ETH, 4463.3);
  assert.equal(pv.wire.r, false);
  assert.throws(() => assertScopedAction(pv.action), /buildReverseOpenOrder/, "a preview is display-only");
  assert.equal(reverseGate({ venueSzi: NaN, closeRequested: 1, closeFilled: 1, closeAmbiguous: false, closeResidual: 0, closeError: null, restingOnCoin: 0, szDecimals: 4 }).ok, false, "NaN never throws, never passes");
});

test("a built open cannot be mutated into something else", () => {
  const b = openLeg({ coin: "ETH", priorSzi: 1, closedSize: 1 }, ETH, 4463.3);
  assert.throws(() => { "use strict"; b.action.orders[0].s = "1000000"; });
  assert.throws(() => { "use strict"; b.action.orders.push(b.wire); });
  assert.equal(b.action.orders[0].s, "1");
});

test("reversePreCheck: the venue must still hold the position the sheet showed", () => {
  assert.equal(reversePreCheck(1.0, 1.0, 4), null);
  assert.equal(reversePreCheck(-2.5, -2.5001, 4), null, "within one size step");
  assert.match(reversePreCheck(1.0, 0.4, 4), /size changed/, "a take-profit shrank it");
  assert.match(reversePreCheck(1.0, 1.5, 4), /size changed/, "it grew");
  assert.match(reversePreCheck(1.0, -1.0, 4), /changed side/);
  assert.match(reversePreCheck(1.0, 0, 4), /no position/);
  assert.match(reversePreCheck(1.0, NaN, 4), /no position/);
});

test("reverseGate: leg 2 only after a clean, proven-flat close, sized by the smallest truth", () => {
  const ok = { venueSzi: 1.0, closeRequested: 1.0, closeFilled: 1.0, closeAmbiguous: false, closeResidual: 0, closeError: null, restingOnCoin: 0, szDecimals: 4 };
  assert.deepEqual(reverseGate(ok), { ok: true, size: 1.0 });
  assert.deepEqual(reverseGate({ ...ok, venueSzi: -1.0 }), { ok: true, size: 1.0 }, "a short reverses the same way");
  assert.deepEqual(reverseGate({ ...ok, closeFilled: 0.4 }), { ok: true, size: 0.4 }, "never more than leg 1 filled");
  assert.deepEqual(reverseGate({ ...ok, closeFilled: 0.4, closeAmbiguous: true }), { ok: true, size: 1.0 }, "an ambiguous fill figure is not trusted as a cap; the venue size is");
  assert.deepEqual(reverseGate({ ...ok, venueSzi: 0.4 }), { ok: true, size: 0.4 }, "never more than the venue held");
  const stops = [
    [{ closeFilled: 0 }, /did not fill/],
    [{ closeResidual: null }, /prove the close flat/],
    [{ closeResidual: 0.1 }, /partial/],
    [{ closeError: "cancel: boom" }, /error/],
    [{ restingOnCoin: null }, /could not confirm/],
    [{ restingOnCoin: 2 }, /still rest/],
    [{ closeFilled: 0.00001 }, /nothing was closed/],
  ];
  for (const [patch, re] of stops) {
    const g = reverseGate({ ...ok, ...patch });
    assert.equal(g.ok, false, JSON.stringify(patch));
    assert.match(g.reason, re);
  }
});

test("fuzz: every reverse open mirrors its close - opposite side, same size, one order, IoC", () => {
  let n = 0;
  for (let szDecimals = 0; szDecimals <= 6; szDecimals++) {
    const asset = { coin: "xyz:X", assetId: assetIdFor(0, 7), szDecimals, dex: "xyz", index: 7 };
    for (const mag of [0.001, 0.05, 1, 12.5, 400, 1e6]) {
      for (const sign of [1, -1]) {
        for (const mid of [0.0123, 1, 97.19, 65846.9]) {
          let c;
          try { c = buildClosePositionOrder({ coin: asset.coin, szi: mag * sign }, asset, mid); } catch (e) { continue; }
          const o = openLeg({ coin: asset.coin, priorSzi: mag * sign, closedSize: c.size }, asset, mid);
          assert.equal(o.wire.r, false);
          assert.equal(o.wire.t.limit.tif, "Ioc");
          assert.equal(o.action.orders.length, 1);
          assert.equal(o.wire.b, c.wire.b, "the open trades the same direction as the close (a sell closes a long and opens the short)");
          assert.equal(o.wire.s, c.wire.s, "same size as the close");
          assertScopedAction(o.action);
          n++;
        }
      }
    }
  }
  assert.ok(n > 200, "fuzz ran " + n);
});

test("fuzz: every built close is reduce-only IoC with string p/s and a permitted type", () => {
  let n = 0;
  for (let szDecimals = 0; szDecimals <= 6; szDecimals++) {
    for (const dex of [null, 0, 3]) {
      const asset = { coin: dex === null ? "BTC" : "xyz:X", assetId: assetIdFor(dex, 7), szDecimals, dex: dex === null ? "" : "xyz", index: 7 };
      for (const mag of [0.001, 0.05, 1, 12.5, 400, 1e6]) {
        for (const sign of [1, -1]) {
          for (const mid of [0.0123, 1, 97.19, 4463.3, 65846.9]) {
            const sz = mag * sign;
            let p;
            try { p = buildClosePositionOrder({ coin: asset.coin, szi: sz }, asset, mid); } catch (e) { continue; } // below a size step is refused, never emitted
            assert.equal(p.wire.r, true); assert.equal(p.wire.t.limit.tif, "Ioc");
            assert.equal(typeof p.wire.p, "string"); assert.equal(typeof p.wire.s, "string");
            assert.ok(["order", "cancel"].includes(p.action.type));
            assert.equal(p.wire.b, sz < 0);
            assert.ok(parseFloat(p.wire.s) <= Math.abs(sz) + 1e-12, "never more than the position");
            assertScopedAction(p.action);
            n++;
          }
        }
      }
    }
  }
  assert.ok(n > 500, "fuzz ran " + n);
});

test("order and cancel responses parse", () => {
  assert.deepEqual(parseOrderResponse({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.42", avgPx: "229.71", oid: 5 } }] } } }), { kind: "filled", totalSz: 0.42, avgPx: 229.71, oid: 5 });
  assert.deepEqual(parseOrderResponse({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 7 } }] } } }), { kind: "resting", oid: 7 });
  assert.deepEqual(parseOrderResponse({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Order must have minimum value of $10." }] } } }), { kind: "error", message: "Order must have minimum value of $10." });
  assert.deepEqual(parseOrderResponse({ status: "err", response: "Invalid nonce" }), { kind: "err", message: "Invalid nonce" });
  assert.equal(parseOrderResponse(null).kind, "malformed");
  assert.equal(parseOrderResponse({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 5 } }] } } }).kind, "malformed");
  assert.equal(parseOrderResponse({ status: "ok", response: {} }).kind, "malformed");
  assert.deepEqual(parseCancelResponse({ status: "ok", response: { type: "cancel", data: { statuses: ["success", { error: "Order was never placed" }] } } }), { ok: 1, errors: ["Order was never placed"] });
  assert.deepEqual(parseCancelResponse({ status: "err", response: "x" }), { kind: "err", message: "x" });
});
