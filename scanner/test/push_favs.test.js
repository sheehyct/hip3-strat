"use strict";

// The favorites UNION (alert scope) and the SHARED matcher.
//
// Two distinct questions get answered by one comparison on purpose:
//   delivery - "should this token receive this alert?"  (recipients)
//   scope    - "should this coin be evaluated at all?"  (rules.js)
// If those two ever disagreed the worker would either evaluate coins nobody
// receives or drop alerts a phone asked for, so both call favMatches. These
// tests pin the union math AND the agreement. node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { createPushStore, favMatches } = require("../src/push.js");

const TOK1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOK2 = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const TOK3 = "ExponentPushToken[cccccccccccccccccccccc]";

// Minimal Expo transport stub (mirrors push.test.js) so send() can be observed
// without touching the network.
function stubFetch(n) {
  const calls = [];
  return {
    calls: calls,
    fetchFn: async function (url, opts) {
      const messages = JSON.parse(opts.body);
      calls.push({ messages: messages });
      const data = [];
      for (let i = 0; i < (n || messages.length); i++) data.push({ status: "ok", id: "t" + i });
      return { ok: true, status: 200, json: async function () { return { data: data }; } };
    }
  };
}

// ---- the shared matcher ----

test("favMatches: coin NAME or SYM, exact string compare", function () {
  assert.strictEqual(favMatches(["xyz:NVDA"], "xyz:NVDA", "NVDA"), true);  // dashboard convention
  assert.strictEqual(favMatches(["NVDA"], "xyz:NVDA", "NVDA"), true);      // the mobile app convention
  assert.strictEqual(favMatches(["ETH"], "BTC", "BTC"), false);
  assert.strictEqual(favMatches(["btc"], "BTC", "BTC"), false, "case sensitive");
  assert.strictEqual(favMatches([" BTC"], "BTC", "BTC"), false, "no trimming at match time");
  assert.strictEqual(favMatches(["NVD"], "xyz:NVDA", "NVDA"), false, "not a prefix match");
});

test("favMatches: an EMPTY or non-array favs list matches nothing", function () {
  // An empty favs list is a broadcast DELIVERY subscription, which is a
  // statement about delivery only - it never puts a coin into alert SCOPE.
  assert.strictEqual(favMatches([], "BTC", "BTC"), false);
  assert.strictEqual(favMatches(null, "BTC", "BTC"), false);
  assert.strictEqual(favMatches(undefined, "BTC", "BTC"), false);
  assert.strictEqual(favMatches("BTC", "BTC", "BTC"), false);
});

// ---- the union ----

test("favUnion: empty store yields []", function () {
  const store = createPushStore({});
  assert.deepStrictEqual(store.favUnion(), []);
});

test("favUnion: unions across registrations and de-duplicates", function () {
  const store = createPushStore({});
  store.register(TOK1, ["BTC", "ETH"]);
  store.register(TOK2, ["ETH", "SOL"]);
  assert.deepStrictEqual(store.favUnion().sort(), ["BTC", "ETH", "SOL"]);
});

test("favUnion: registrations with EMPTY favs contribute NOTHING", function () {
  // THE defeat condition for favorites-only alerting: if a broadcast
  // registration meant "everything", one phone would put all ~176 main-dex
  // perps into alert scope and the feature would be indistinguishable from
  // adding perps to ALERT_UNIVERSES.
  const store = createPushStore({});
  store.register(TOK1, []);            // broadcast delivery subscription
  store.register(TOK2);                // favs omitted -> also broadcast
  assert.deepStrictEqual(store.favUnion(), []);
  store.register(TOK3, ["BTC"]);
  assert.deepStrictEqual(store.favUnion(), ["BTC"],
    "the broadcast registrations still add nothing to SCOPE");
});

test("favUnion: values are sanitized the same way registration sanitizes them", function () {
  const store = createPushStore({});
  store.register(TOK1, [" BTC ", "ETH"]);
  assert.deepStrictEqual(store.favUnion().sort(), ["BTC", "ETH"],
    "trimmed at registration, so scope and delivery compare identical strings");
});

test("favUnion: a coin named like an Object property is not swallowed", function () {
  // Null-prototype accumulator: "constructor" in {} is true, which would
  // silently drop such a favorite from scope.
  const store = createPushStore({});
  store.register(TOK1, ["constructor", "toString", "__proto__"]);
  assert.deepStrictEqual(store.favUnion().sort(), ["__proto__", "constructor", "toString"]);
});

test("favUnion: reflects unregister and re-register (scope changes at runtime)", function () {
  const store = createPushStore({});
  store.register(TOK1, ["BTC"]);
  store.register(TOK2, ["SOL"]);
  assert.deepStrictEqual(store.favUnion().sort(), ["BTC", "SOL"]);
  store.unregister(TOK2);
  assert.deepStrictEqual(store.favUnion(), ["BTC"]);
  store.register(TOK1, ["ETH"]);        // re-register REPLACES the list
  assert.deepStrictEqual(store.favUnion(), ["ETH"]);
});

// ---- scope and delivery agree ----

test("every coin the union admits is also a delivery recipient", async function () {
  const s = stubFetch();
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, ["xyz:NVDA"]);   // by name
  store.register(TOK2, ["BTC"]);        // by sym
  const union = store.favUnion();
  const coins = [
    { name: "xyz:NVDA", sym: "NVDA" },
    { name: "UBTC", sym: "BTC" },
    { name: "SOL", sym: "SOL" }         // nobody favorited this one
  ];
  for (const c of coins) {
    const inScope = favMatches(union, c.name, c.sym);
    s.calls.length = 0;
    await store.send("[LIVE] " + c.sym + " D 3-2U up", { coin: c.name, sym: c.sym });
    const delivered = s.calls.length > 0;
    assert.strictEqual(inScope, delivered,
      c.name + ": scope says " + inScope + " but delivery says " + delivered);
  }
});

test("a broadcast registration receives favs-scoped alerts without widening scope", async function () {
  const s = stubFetch();
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);             // broadcast: wants everything that fires
  store.register(TOK2, ["BTC"]);        // the only registration that sets scope
  assert.deepStrictEqual(store.favUnion(), ["BTC"], "scope is BTC only");
  await store.send("[LIVE] BTC D 3-2U up", { coin: "BTC", sym: "BTC" });
  const to = s.calls[0].messages.map(function (m) { return m.to; }).sort();
  assert.deepStrictEqual(to, [TOK1, TOK2].sort(),
    "once an alert fires, the broadcast phone still receives it");
});
