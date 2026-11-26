// src/lib/order_policy.ts: the venue-neutral refusals (max notional,
// slippage above 5 percent, reduce-only on an opening order, a close that
// would increase or flip a position), one-click gating and the helpers.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  capRefusal, checkIntent, closeSize, defaultExitLevel, exitSideOk, oneClickAllowed, pnlAt, reduces, sanitizeMarketSettings, sizeForDollars,
} from "../src/lib/order_policy.ts";

const settings = { slippage: 0.01, maxNotional: 1000, presets: null };
const mk = (over = {}) => ({
  venue: "hl", marketId: "BTC", side: "buy", type: "market", size: 0.01, price: null, reduceOnly: false, postOnly: false,
  slippage: 0.01, tp: null, sl: null, leverage: 5, marginMode: "cross", ...over,
});
const ctx = (over = {}) => ({ mark: 80000, position: null, settings, szDecimals: 5, ...over });

test("an opening order under the cap passes with its notional", () => {
  assert.deepEqual(checkIntent(mk(), ctx()), { ok: true, notional: 800, refPx: 80000 });
});

test("refusal: over max notional", () => {
  const r = checkIntent(mk({ size: 0.02 }), ctx());
  assert.equal(r.ok, false);
  assert.match(r.reason, /above this market's max/);
});

test("refusal: slippage above 5 percent; 5 percent passes", () => {
  assert.match(checkIntent(mk({ slippage: 0.051 }), ctx()).reason, /slippage above 5%/);
  assert.equal(checkIntent(mk({ slippage: 0.05 }), ctx()).ok, true);
  assert.match(checkIntent(mk({ slippage: 0 }), ctx()).reason, /slippage cap/);
});

test("refusal: an opening order flagged reduce-only", () => {
  assert.match(checkIntent(mk({ reduceOnly: true }), ctx()).reason, /no position to reduce/);
  assert.match(checkIntent(mk({ reduceOnly: true, side: "buy" }), ctx({ position: { side: "long", size: 1 } })).reason, /would not reduce/);
});

test("refusal: a close that would increase or flip the position", () => {
  const longPos = { side: "long", size: 0.01 };
  // selling more than the long flips it: not a reduction, so the cap applies and it is over
  assert.match(checkIntent(mk({ side: "sell", size: 0.02, reduceOnly: true }), ctx({ position: longPos })).reason, /would not reduce/);
  // a plain (not reduce-only) sell of the whole long reduces: passes regardless of cap
  assert.equal(checkIntent(mk({ side: "sell", size: 0.01 }), ctx({ position: longPos, settings: { ...settings, maxNotional: 1 } })).ok, true);
  assert.equal(reduces({ side: "sell", size: 0.01 }, longPos), true);
  assert.equal(reduces({ side: "sell", size: 0.011 }, longPos), false);
  assert.equal(reduces({ side: "buy", size: 0.01 }, longPos), false);
  assert.equal(reduces({ side: "buy", size: 0.01 }, { side: "short", size: 0.01 }), true);
});

test("limit orders are sized at the limit price; post-only only on limits", () => {
  assert.deepEqual(checkIntent(mk({ type: "limit", price: 50000, size: 0.02 }), ctx()), { ok: true, notional: 1000, refPx: 50000 });
  assert.match(checkIntent(mk({ type: "limit", price: null }), ctx()).reason, /positive price/);
  assert.match(checkIntent(mk({ postOnly: true }), ctx()).reason, /post-only/);
  assert.match(checkIntent(mk({ type: "market" }), ctx({ mark: null })).reason, /no mark/);
});

test("attached exits must sit on the right side; none on a reducing order", () => {
  assert.equal(checkIntent(mk({ tp: 81000, sl: 79000 }), ctx()).ok, true);
  assert.match(checkIntent(mk({ tp: 79000 }), ctx()).reason, /take profit must be above/);
  assert.match(checkIntent(mk({ sl: 81000 }), ctx()).reason, /stop loss must be below/);
  assert.match(checkIntent(mk({ side: "sell", tp: 81000 }), ctx()).reason, /take profit must be below/);
  assert.match(checkIntent(mk({ side: "sell", size: 0.01, tp: 79000 }), ctx({ position: { side: "long", size: 0.01 } })).reason, /cannot carry attached exits/);
});

test("size step and sizing helpers", () => {
  assert.match(checkIntent(mk({ size: 0.000001 }), ctx()).reason, /size step/);
  assert.equal(closeSize({ size: 0.01 }, 1, 5), 0.01);
  assert.equal(closeSize({ size: 0.01 }, 0.25, 3), 0.002);
  assert.equal(closeSize({ size: 0.01 }, 0.5, 5), 0.005);
  assert.throws(() => closeSize({ size: 1 }, 0, 3));
  assert.equal(sizeForDollars(2500, 80000, 5), 0.03125);
  assert.equal(sizeForDollars(2500, 80000, 3), 0.031);
  assert.equal(sizeForDollars(0, 80000, 3), 0);
});

test("one-click: only with the toggle on and under the cap; closes always", () => {
  assert.equal(oneClickAllowed(false, false, 500, settings), false);
  assert.equal(oneClickAllowed(true, false, 500, settings), true);
  assert.equal(oneClickAllowed(true, false, 1500, settings), false);
  assert.equal(oneClickAllowed(false, true, 1e9, settings), true);
});

test("exit levels and dollar PnL", () => {
  assert.equal(defaultExitLevel("tp", "long", 100), 101);
  assert.equal(defaultExitLevel("sl", "long", 100), 99);
  assert.equal(defaultExitLevel("tp", "short", 100), 99);
  assert.equal(defaultExitLevel("sl", "short", 100), 101);
  assert.equal(exitSideOk("tp", "long", 101, 100), true);
  assert.equal(exitSideOk("tp", "long", 99, 100), false);
  assert.equal(exitSideOk("sl", "short", 101, 100), true);
  assert.equal(pnlAt("long", 2, 100, 110), 20);
  assert.equal(pnlAt("short", 2, 100, 110), -20);
});

test("market settings sanitize", () => {
  assert.deepEqual(sanitizeMarketSettings(null), { slippage: 0.01, maxNotional: 1000, presets: null });
  assert.deepEqual(sanitizeMarketSettings({ slippage: 0.2, maxNotional: -5, presets: [10, "x", 25, 50, 75] }), { slippage: 0.01, maxNotional: 1000, presets: [10, 25, 50] });
  assert.deepEqual(sanitizeMarketSettings({ slippage: 0.02, maxNotional: 5000 }), { slippage: 0.02, maxNotional: 5000, presets: null });
});

// ---- the cap beyond a new order (review F6) and venue limits (review F10) ------

test("capRefusal: a moved order or a reverse's opening leg is bounded at the size and price it becomes", () => {
  assert.equal(capRefusal(10, 90, 1000), null);
  assert.equal(capRefusal(10, 200, 1000), "notional $2,000 is above this market's max $1,000");
  assert.match(capRefusal(20, 90, 1000), /above this market's max/);
  assert.equal(capRefusal(-10, 90, 1000), null);            // a signed size counts by its magnitude
  assert.equal(capRefusal(10, 100, 1000), null);            // exactly at the cap passes
  assert.match(capRefusal(10, 90, 0), /no max notional set/);
  assert.match(capRefusal(10, NaN, 1000), /no size or price/);
  assert.match(capRefusal(NaN, 90, 1000), /no size or price/);
});

test("refusal: TP / SL on a Hyperliquid LIMIT order (the venue cannot attach them); a market order may carry them", () => {
  const lim = mk({ type: "limit", price: 79000, tp: 84000, sl: 77000 });
  assert.match(checkIntent(lim, ctx()).reason, /Hyperliquid cannot attach TP \/ SL to a limit order/);
  assert.equal(checkIntent(mk({ type: "limit", price: 79000 }), ctx()).ok, true);
  assert.equal(checkIntent(mk({ tp: 84000, sl: 77000 }), ctx()).ok, true);
  // MFP attaches exits server-side, on a limit too
  assert.equal(checkIntent(mk({ venue: "mfp", type: "limit", price: 79000, tp: 84000, sl: 77000 }), ctx()).ok, true);
});

test("refusal: post-only on MFP (the venue has no such order); Hyperliquid may post-only a limit", () => {
  assert.match(checkIntent(mk({ venue: "mfp", type: "limit", price: 79000, postOnly: true }), ctx()).reason, /MyFundedPerps has no post-only order/);
  assert.equal(checkIntent(mk({ type: "limit", price: 79000, postOnly: true }), ctx()).ok, true);
});
