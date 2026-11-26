"use strict";

// Expo push channel tests: token registration validation + caps, favorites
// scoping (empty favs = broadcast; non-empty matches coin.name OR sym),
// persistence round-trip, 100-message batching, DeviceNotRegistered pruning
// (tickets AND receipts), per-ticket MessageRateExceeded retry, stats
// counters for permanent failures, LOG_ONLY short-circuit, and the
// HTTP-facing handlers (default-closed PUSH_REGISTER_KEY gate + status codes).
// node builtins only: node --test. fetch is injected - no network.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPushStore } = require("../src/push.js");

const TOK1 = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOK2 = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const TOK3 = "ExpoPushToken[cccccccccccccccccccccc]";

const savedEnv = {};
for (const k of ["LOG_ONLY", "PUSH_REGISTER_KEY", "EXPO_PUSH_ACCESS_TOKEN"]) {
  savedEnv[k] = process.env[k];
}

test.beforeEach(function () {
  delete process.env.LOG_ONLY;
  delete process.env.PUSH_REGISTER_KEY;
  delete process.env.EXPO_PUSH_ACCESS_TOKEN;
});

test.after(function () {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// fetch stub: records each call's parsed body, replays scripted responses
// ({status, tickets} for sends, {status, data} for receipts) in order,
// repeating the last one.
function stubFetch(script) {
  const calls = [];
  let i = 0;
  const fetchFn = async function (url, opts) {
    calls.push({ url: url, messages: JSON.parse(opts.body), headers: opts.headers });
    const step = script[Math.min(i++, script.length - 1)];
    if (step.status === "network") throw new Error("fetch failed");
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async function () {
        return { data: step.data !== undefined ? step.data : (step.tickets || []) };
      }
    };
  };
  return { fetchFn: fetchFn, calls: calls };
}

function okTickets(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ status: "ok", id: "t" + i });
  return out;
}

// ---- registration ----

test("register validates token format (both Expo token shapes)", function () {
  const store = createPushStore({});
  assert.strictEqual(store.register(TOK1, []).ok, true);
  assert.strictEqual(store.register(TOK3, []).ok, true);
  assert.strictEqual(store.register("not-a-token", []).error, "invalid token");
  assert.strictEqual(store.register("ExponentPushToken[]", []).error, "invalid token");
  assert.strictEqual(store.register(123, []).error, "invalid token");
  assert.strictEqual(store.count(), 2);
});

test("register sanitizes favs: omitted -> broadcast; junk rejected", function () {
  const store = createPushStore({});
  assert.strictEqual(store.register(TOK1).ok, true);          // no favs = broadcast
  assert.strictEqual(store.register(TOK1, ["UBTC", " ETH "]).favs, 2);
  assert.ok(store.register(TOK1, "UBTC").error);               // not an array
  assert.ok(store.register(TOK1, [42]).error);                 // non-string entry
  assert.ok(store.register(TOK1, [""]).error);                 // empty symbol
});

test("re-registering the same token updates favs without growing the store", function () {
  const store = createPushStore({});
  store.register(TOK1, ["UBTC"]);
  store.register(TOK1, ["ETH", "SOL"]);
  assert.strictEqual(store.count(), 1);
  assert.deepStrictEqual(store._tokens[TOK1].favs, ["ETH", "SOL"]);
});

test("token store is capped", function () {
  const store = createPushStore({});
  for (let i = 0; i < 500; i++) {
    const pad = ("000000" + i).slice(-6);
    assert.strictEqual(store.register("ExponentPushToken[cap" + pad + "]", []).ok, true);
  }
  const r = store.register("ExponentPushToken[overflow]", []);
  assert.strictEqual(r.error, "token store full");
  assert.strictEqual(r.status, 429);
  // existing tokens can still update
  assert.strictEqual(store.register("ExponentPushToken[cap000000]", ["UBTC"]).ok, true);
});

test("unregister removes a token; unknown token is a 404", function () {
  const store = createPushStore({});
  store.register(TOK1, []);
  assert.strictEqual(store.unregister(TOK1).ok, true);
  assert.strictEqual(store.count(), 0);
  assert.strictEqual(store.unregister(TOK1).status, 404);
});

// ---- persistence ----

test("tokens persist across store instances (atomic JSON round-trip)", function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hip3-push-"));
  const p = path.join(dir, "push_tokens.json");
  const a = createPushStore({ statePath: p });
  a.register(TOK1, ["UBTC"]);
  a.register(TOK2, []);
  const b = createPushStore({ statePath: p });
  assert.strictEqual(b.count(), 2);
  assert.deepStrictEqual(b._tokens[TOK1].favs, ["UBTC"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("corrupted state file starts empty with a LOUD log; missing file is quiet", function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hip3-push-"));
  const p = path.join(dir, "push_tokens.json");
  fs.writeFileSync(p, "{not json");
  const lines = [];
  const store = createPushStore({ statePath: p, log: function (m) { lines.push(m); } });
  assert.strictEqual(store.count(), 0);
  assert.ok(lines.some(function (l) { return /UNREADABLE/.test(l) && /lost/.test(l); }),
    "corrupt file must be distinguishable from a fresh start in the logs");
  const lines2 = [];
  createPushStore({ statePath: path.join(dir, "missing.json"),
    log: function (m) { lines2.push(m); } });
  assert.ok(lines2.some(function (l) { return /no prior push tokens/.test(l); }));
  assert.ok(!lines2.some(function (l) { return /UNREADABLE/.test(l); }));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- recipient scoping ----

test("favorites scoping: empty favs = broadcast; favs match coin name OR sym", async function () {
  const s = stubFetch([{ status: 200, tickets: okTickets(2) }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);            // broadcast
  store.register(TOK2, ["UBTC"]);      // matches by coin name
  store.register(TOK3, ["OTHER"]);     // no match
  const ok = await store.send("[LIVE] BTC D 3-2U up | entry >100", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(ok, true);
  assert.strictEqual(s.calls.length, 1);
  const to = s.calls[0].messages.map(function (m) { return m.to; }).sort();
  assert.deepStrictEqual(to, [TOK1, TOK2].sort());
});

test("favs matching the sym (the mobile app convention) also receive", async function () {
  const s = stubFetch([{ status: 200, tickets: okTickets(1) }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK2, ["BTC"]);       // sym, not coin name
  await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(s.calls[0].messages[0].to, TOK2);
});

test("meta-less alerts reach only broadcast subscriptions", async function () {
  const s = stubFetch([{ status: 200, tickets: okTickets(1) }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  store.register(TOK2, ["UBTC"]);
  await store.send("[SCORE] BTC +62");
  assert.strictEqual(s.calls.length, 1);
  assert.strictEqual(s.calls[0].messages.length, 1);
  assert.strictEqual(s.calls[0].messages[0].to, TOK1);
});

test("zero recipients: resolves true with no network call", async function () {
  const s = stubFetch([{ status: 200 }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  assert.strictEqual(await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" }), true);
  store.register(TOK2, ["OTHER"]);
  assert.strictEqual(await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" }), true);
  assert.strictEqual(s.calls.length, 0);
});

// ---- message shape + batching ----

test("notification splits on ' | ': head = title, tail = body; data carries coin", async function () {
  const s = stubFetch([{ status: 200, tickets: okTickets(1) }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  await store.send("[LIVE] BTC D 3-2U up | entry >100 stop 95", { coin: "UBTC", sym: "BTC" });
  const m = s.calls[0].messages[0];
  assert.strictEqual(m.title, "[LIVE] BTC D 3-2U up");
  assert.strictEqual(m.body, "entry >100 stop 95");
  assert.strictEqual(m.sound, "default");
  assert.deepStrictEqual(m.data, { coin: "UBTC", sym: "BTC" });
});

test("more than 100 recipients are batched into 100-message requests", async function () {
  const s = stubFetch([{ status: 200, tickets: okTickets(100) }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  for (let i = 0; i < 150; i++) {
    const pad = ("000000" + i).slice(-6);
    store.register("ExponentPushToken[batch" + pad + "]", []);
  }
  const ok = await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(ok, true);
  assert.strictEqual(s.calls.length, 2);
  assert.strictEqual(s.calls[0].messages.length, 100);
  assert.strictEqual(s.calls[1].messages.length, 50);
});

// ---- ticket handling + retries ----

test("DeviceNotRegistered ticket prunes that token from the store", async function () {
  const s = stubFetch([{
    status: 200,
    tickets: [
      { status: "ok", id: "t0" },
      { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
    ]
  }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  store.register(TOK2, []);
  await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(store.count(), 1);
  const pruned = s.calls[0].messages[1].to;
  assert.strictEqual(pruned in store._tokens, false);
});

test("transient 429 is retried through to success", async function () {
  const s = stubFetch([{ status: 429 }, { status: 200, tickets: okTickets(1) }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  const ok = await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(ok, true);
  assert.strictEqual(s.calls.length, 2);
});

test("non-retryable 4xx fails after a single attempt and is COUNTED in stats", async function () {
  const s = stubFetch([{ status: 400 }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  const ok = await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(ok, false);
  assert.strictEqual(s.calls.length, 1);
  const st = store.stats();
  assert.strictEqual(st.failed, 1);
  assert.ok(st.lastError && /HTTP 400/.test(st.lastError.error),
    "a dead channel must be visible via stats(), not just a log line");
});

test("MessageRateExceeded tickets are retried - and ONLY the throttled messages", async function () {
  const s = stubFetch([
    { status: 200, tickets: [
      { status: "ok", id: "t0" },
      { status: "error", message: "rate", details: { error: "MessageRateExceeded" } }
    ] },
    { status: 200, tickets: okTickets(1) }
  ]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  store.register(TOK2, []);
  const ok = await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(ok, true);
  assert.strictEqual(s.calls.length, 2);
  assert.strictEqual(s.calls[1].messages.length, 1);
  assert.strictEqual(s.calls[1].messages[0].to, s.calls[0].messages[1].to);
  assert.strictEqual(store.stats().failed, 0);
});

test("permanent ticket errors (MessageTooBig) are counted, never retried", async function () {
  const s = stubFetch([{
    status: 200,
    tickets: [{ status: "error", message: "too big", details: { error: "MessageTooBig" } }]
  }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  const ok = await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(ok, true); // the chunk was accepted; the loss is in stats
  assert.strictEqual(s.calls.length, 1);
  const st = store.stats();
  assert.strictEqual(st.failed, 1);
  assert.ok(/MessageTooBig/.test(st.lastError.error));
});

test("LOG_ONLY=1 logs and never touches fetch", async function () {
  const s = stubFetch([{ status: 200 }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  process.env.LOG_ONLY = "1";
  const ok = await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(ok, true);
  assert.strictEqual(s.calls.length, 0);
});

// ---- receipts (tickets only mean "Expo accepted it") ----

test("receipt DeviceNotRegistered prunes the token ~15 min after the send", async function () {
  const s = stubFetch([
    { status: 200, tickets: [{ status: "ok", id: "r1" }] },
    { status: 200, data: { r1: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } } }
  ]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(store._pendingReceipts().length, 1);
  await store.checkReceipts(Date.now() + 16 * 60 * 1000);
  assert.strictEqual(store.count(), 0);
  assert.strictEqual(store._pendingReceipts().length, 0);
  assert.strictEqual(s.calls.length, 2);
  assert.deepStrictEqual(s.calls[1].messages, { ids: ["r1"] });
});

test("not-yet-ready receipts stay pending; 24h age-out caps the list", async function () {
  const s = stubFetch([
    { status: 200, tickets: [{ status: "ok", id: "r1" }] },
    { status: 200, data: {} } // receipt not ready yet
  ]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  await store.checkReceipts(Date.now() + 16 * 60 * 1000);
  assert.strictEqual(store._pendingReceipts().length, 1, "kept for a later check");
  await store.checkReceipts(Date.now() + 25 * 3600 * 1000);
  assert.strictEqual(store._pendingReceipts().length, 0, "aged out after 24h");
  assert.strictEqual(s.calls.length, 2, "age-out happens without a receipts request");
});

test("a failing receipts endpoint leaves everything pending (retried next tick)", async function () {
  const s = stubFetch([
    { status: 200, tickets: [{ status: "ok", id: "r1" }] },
    { status: 503 }
  ]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  await store.checkReceipts(Date.now() + 16 * 60 * 1000);
  assert.strictEqual(store._pendingReceipts().length, 1);
  assert.strictEqual(store.count(), 1, "no token pruned on a transport failure");
});

test("EXPO_PUSH_ACCESS_TOKEN adds the Authorization header", async function () {
  const s = stubFetch([{ status: 200, tickets: okTickets(1) }]);
  const store = createPushStore({ fetchFn: s.fetchFn });
  store.register(TOK1, []);
  process.env.EXPO_PUSH_ACCESS_TOKEN = "secret-token";
  await store.send("[LIVE] BTC D 3-2U up", { coin: "UBTC", sym: "BTC" });
  assert.strictEqual(s.calls[0].headers["Authorization"], "Bearer secret-token");
});

// ---- HTTP-facing handlers ----

test("handleRegister: bad json 400, bad token 400, success 200 with counts", function () {
  const store = createPushStore({});
  process.env.PUSH_REGISTER_KEY = "k";
  assert.strictEqual(store.handleRegister("{nope", "k").status, 400);
  assert.strictEqual(store.handleRegister("[1,2]", "k").status, 400);
  assert.strictEqual(store.handleRegister(JSON.stringify({ token: "junk" }), "k").status, 400);
  const ok = store.handleRegister(JSON.stringify({ token: TOK1, favs: ["UBTC"] }), "k");
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.body, { ok: true, tokens: 1, favs: 1 });
});

test("handleUnregister: unknown 404, known 200", function () {
  const store = createPushStore({});
  process.env.PUSH_REGISTER_KEY = "k";
  store.register(TOK1, []);
  assert.strictEqual(store.handleUnregister(JSON.stringify({ token: TOK2 }), "k").status, 404);
  const ok = store.handleUnregister(JSON.stringify({ token: TOK1 }), "k");
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.body, { ok: true, tokens: 0 });
});

test("registration is DEFAULT-CLOSED: 403 until PUSH_REGISTER_KEY is set", function () {
  const store = createPushStore({});
  const body = JSON.stringify({ token: TOK1 });
  // unset (public URL, public repo): everything refused
  assert.strictEqual(store.handleRegister(body).status, 403);
  assert.strictEqual(store.handleUnregister(body).status, 403);
  assert.strictEqual(store.count(), 0);
  // set: wrong/missing key 401, right key 200
  process.env.PUSH_REGISTER_KEY = "hunter2";
  assert.strictEqual(store.handleRegister(body, undefined).status, 401);
  assert.strictEqual(store.handleRegister(body, "wrong").status, 401);
  assert.strictEqual(store.handleRegister(body, "hunter2").status, 200);
  assert.strictEqual(store.handleUnregister(body, "wrong").status, 401);
  assert.strictEqual(store.handleUnregister(body, "hunter2").status, 200);
});
