"use strict";

// Expo push delivery channel (push without ntfy).
// A persistent token store + a batched sender against the Expo Push Service
// (https://exp.host/--/api/v2/push/send - FCM/APNs under the hood, no
// credentials needed here; an optional EXPO_PUSH_ACCESS_TOKEN env adds the
// Authorization header if Enhanced Push Security is ever enabled).
//
// This channel is ADDITIVE to the ALERT_BACKEND webhook: server.js composes
// both into the rule engine's deliver callback. Zero registered tokens means
// zero network calls - an undeployed/unused store is byte-for-byte the
// current worker behavior.
//
// Registration is DEFAULT-CLOSED: the worker runs on a public URL and this
// repo is public, so /api/push/register answers 403 until the operator sets
// PUSH_REGISTER_KEY (clients send it as the x-push-key header). An open
// default would let anyone fill the token store (locking out the real
// device) or subscribe their own phone to the alert stream.
//
// Favorites scoping: a registration may carry a `favs` array (the mobile
// app's starred symbols). Alerts for a coin reach a token when its favs list
// is EMPTY (broadcast subscription) or contains the coin's name OR sym -
// clients disagree on the key (dashboard favorites use coin.name, the mobile app
// uses sym), so both match, EXACT string compare (clients must echo values
// from /api/state verbatim). Sharp edge: sym matching is cross-universe -
// if xyz and perps both alert and both carry a coin with sym "BTC", a fav
// "BTC" receives both; clients that care must favorite by coin NAME.
//
// That same matching rule now decides ALERT SCOPE as well as delivery:
// ALERT_FAVS_UNIVERSES (perps) fires only for favorited coins, and rules.js
// asks favUnion()/favMatches() which coins those are. Scope and delivery MUST
// agree - a coin the scope admits but delivery drops is a wasted evaluation,
// and a coin delivery would accept but scope skips is a missing alert - so
// there is exactly ONE comparison, favMatches below, called from both sides.
//
// Persistence caveat: without a persistent volume the filesystem is
// ephemeral (same as rule_state.json) and tokens are lost on redeploy.
// Clients must re-register
// on app foreground - standard Expo practice, documented in the README.
//
// Failure contract mirrors deliver.js: sends are serialized, transient
// failures (network / HTTP 429 / 5xx / MessageRateExceeded tickets) retry
// with exponential backoff, permanent failures are logged, COUNTED (stats()
// feeds /health so a dead channel is visible) and swallowed. Delivery must
// NEVER crash the loop.
//
// Receipts: a ticket only acknowledges that Expo ACCEPTED a message; the
// actual delivery outcome (including most DeviceNotRegistered signals for
// uninstalled apps) arrives via the push-receipts API ~15 minutes later.
// Sent ticket ids are kept in memory and checked on a timer; dead tokens are
// pruned there too. Pending receipt ids do not survive a restart (accepted:
// the next send re-learns a dead token within one receipt cycle).

const fs = require("node:fs");
const path = require("node:path");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
// Expo token shapes: ExponentPushToken[xxx] (current) / ExpoPushToken[xxx].
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,64}\]$/;
const MAX_TOKENS = 500;   // registration cap: this is a single-operator worker
const MAX_FAVS = 300;     // more favorites than tracked coins = broken client
const MAX_FAV_LEN = 64;
const BATCH = 100;        // Expo push API maximum messages per request
const TIMEOUT_MS = 10000;
const MAX_TRIES = 4;      // 1 attempt + up to 3 retries (1s/2s/4s backoff)
const MIN_GAP_MS = 200;   // Expo allows ~600 notifications/s; stay far below
const RECEIPT_DELAY_MS = 15 * 60 * 1000;   // Expo: receipts ready ~15 min
const RECEIPT_MAX_AGE_MS = 24 * 3600 * 1000; // Expo keeps receipts ~24h
const RECEIPT_BATCH = 300;                 // expo-server-sdk receipt chunk size
const RECEIPT_TIMER_MS = 5 * 60 * 1000;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function retryable(e) {
  if (e && typeof e.status === "number") return e.status === 429 || e.status >= 500;
  return true; // network error / timeout
}

// One-line phone-friendly alert -> notification title/body. The rule engine
// formats "[LIVE] SYM D 3-1-2D up | entry >1.234 ..." - the part before the
// first " | " is the signal, the tail is context.
function splitMsg(msg) {
  const i = msg.indexOf(" | ");
  if (i < 0) return { title: msg, body: null };
  return { title: msg.slice(0, i), body: msg.slice(i + 3) };
}

// THE favorites matching rule, shared by delivery scoping (recipients below)
// and alert scoping (rules.js). Name OR sym, exact string compare. Callers
// pass the coin's two identities explicitly because the two call sites hold
// different shapes - rules.js has a coin object, delivery has the {coin, sym}
// meta that rides each alert.
function favMatches(favs, name, sym) {
  if (!Array.isArray(favs) || favs.length === 0) return false;
  return favs.indexOf(name) >= 0 || favs.indexOf(sym) >= 0;
}

function createPushStore(opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const statePath = opts.statePath || null;
  const fetchFn = opts.fetchFn || fetch;

  let tokens = {}; // token -> { favs: string[], updatedAt: ms }
  // Delivery observability (surfaced via stats() -> /health): a push channel
  // that is failing permanently must not look identical to one that works.
  const stats = { sent: 0, failed: 0, receiptErrors: 0, lastError: null };
  let pendingReceipts = []; // { id, token, at } - in-memory only

  if (statePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (parsed && parsed.tokens && typeof parsed.tokens === "object") {
        for (const t of Object.keys(parsed.tokens)) {
          const e = parsed.tokens[t];
          if (TOKEN_RE.test(t) && e && Array.isArray(e.favs)) {
            tokens[t] = { favs: e.favs, updatedAt: e.updatedAt || 0 };
          }
        }
      }
      log("push tokens reloaded from " + statePath
        + " (" + Object.keys(tokens).length + ")");
    } catch (e) {
      // ENOENT is the normal first boot; anything else means a state file
      // EXISTED and its registrations were just lost - say so loudly.
      if (e.code === "ENOENT") {
        log("no prior push tokens - starting empty");
      } else {
        log("push token state UNREADABLE (" + (e.message || e.code)
          + ") - starting empty; prior registrations were lost");
      }
    }
  }

  // Atomic JSON dump (tmp then rename), same discipline as rule state.
  function persist() {
    if (!statePath) return;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ tokens: tokens }));
    fs.renameSync(tmp, statePath);
  }

  function persistSafe() {
    try { persist(); }
    catch (e) { log("push token persist failed: " + (e && e.message)); }
  }

  function dropToken(token, why) {
    if (!(token in tokens)) return false;
    delete tokens[token];
    log("pruned dead push token (" + why + "), total " + Object.keys(tokens).length);
    return true;
  }

  // favs -> trimmed non-empty strings, length-capped; anything else -> null
  // (null = validation error; [] = valid broadcast subscription).
  function sanitizeFavs(favs) {
    if (favs === undefined || favs === null) return [];
    if (!Array.isArray(favs) || favs.length > MAX_FAVS) return null;
    const out = [];
    for (const f of favs) {
      if (typeof f !== "string") return null;
      const s = f.trim();
      if (!s || s.length > MAX_FAV_LEN) return null;
      out.push(s);
    }
    return out;
  }

  function register(token, favs) {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) {
      return { error: "invalid token", status: 400 };
    }
    const clean = sanitizeFavs(favs);
    if (clean === null) {
      return { error: "favs must be an array of coin symbols", status: 400 };
    }
    if (!(token in tokens) && Object.keys(tokens).length >= MAX_TOKENS) {
      return { error: "token store full", status: 429 };
    }
    tokens[token] = { favs: clean, updatedAt: Date.now() };
    persistSafe();
    log("push token registered (favs " + clean.length + ", total "
      + Object.keys(tokens).length + ")");
    return { ok: true, tokens: Object.keys(tokens).length, favs: clean.length };
  }

  function unregister(token) {
    if (typeof token !== "string" || !(token in tokens)) {
      return { error: "unknown token", status: 404 };
    }
    delete tokens[token];
    persistSafe();
    log("push token unregistered (total " + Object.keys(tokens).length + ")");
    return { ok: true, tokens: Object.keys(tokens).length };
  }

  function count() { return Object.keys(tokens).length; }

  // De-duplicated union of `favs` across every registration that HAS
  // favorites, for ALERT SCOPE (ALERT_FAVS_UNIVERSES; see rules.js).
  //
  // Registrations with an EMPTY favs list are deliberately EXCLUDED. An empty
  // list means "broadcast DELIVERY subscription" - send me whatever fires -
  // and that is a statement about delivery, not about which coins deserve to
  // be evaluated. Folding one such registration into the union as "everything"
  // would put all ~176 main-dex perps into alert scope and defeat the entire
  // favorites-only design, silently, from a single phone.
  //
  // Recomputed per evaluation pass rather than cached: registrations change at
  // runtime (a phone re-registers on foreground, a dead token is pruned mid-
  // pass), and a stale union would alert on un-favorited coins. Cost is a few
  // hundred string appends. Null-prototype accumulator so a coin literally
  // named "constructor" or "toString" is not silently swallowed by Object.
  function favUnion() {
    const seen = Object.create(null);
    const out = [];
    for (const t of Object.keys(tokens)) {
      const favs = tokens[t].favs;
      if (!Array.isArray(favs) || favs.length === 0) continue;
      for (const f of favs) {
        if (seen[f]) continue;
        seen[f] = true;
        out.push(f);
      }
    }
    return out;
  }

  // ---- HTTP-facing handlers (server.js stays a thin router) ----
  // body: raw request body string; key: x-push-key header value (or undefined).
  // Returns { status, body } where body is the JSON-serializable response.
  // DEFAULT-CLOSED: no PUSH_REGISTER_KEY configured -> 403 for every request.
  function gate(key) {
    const required = process.env.PUSH_REGISTER_KEY;
    if (!required) {
      return { status: 403, body: { error: "push registration disabled (PUSH_REGISTER_KEY not set)" } };
    }
    if (key !== required) return { status: 401, body: { error: "unauthorized" } };
    return null;
  }

  function parseBody(body) {
    try {
      const p = JSON.parse(body);
      return (p && typeof p === "object" && !Array.isArray(p)) ? p : null;
    } catch (e) { return null; }
  }

  function handleRegister(body, key) {
    const denied = gate(key);
    if (denied) return denied;
    const p = parseBody(body);
    if (!p) return { status: 400, body: { error: "invalid json body" } };
    const r = register(p.token, p.favs);
    if (r.error) return { status: r.status, body: { error: r.error } };
    return { status: 200, body: { ok: true, tokens: r.tokens, favs: r.favs } };
  }

  function handleUnregister(body, key) {
    const denied = gate(key);
    if (denied) return denied;
    const p = parseBody(body);
    if (!p) return { status: 400, body: { error: "invalid json body" } };
    const r = unregister(p.token);
    if (r.error) return { status: r.status, body: { error: r.error } };
    return { status: 200, body: { ok: true, tokens: r.tokens } };
  }

  // ---- sending ----
  function recipients(meta) {
    const out = [];
    for (const t of Object.keys(tokens)) {
      const favs = tokens[t].favs;
      if (favs.length === 0
          || (meta && favMatches(favs, meta.coin, meta.sym))) {
        out.push(t);
      }
    }
    return out;
  }

  function expoHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (process.env.EXPO_PUSH_ACCESS_TOKEN) {
      headers["Authorization"] = "Bearer " + process.env.EXPO_PUSH_ACCESS_TOKEN;
    }
    return headers;
  }

  // POST one chunk. Throws on HTTP-level failure (caller decides retry).
  // On 200, walks the tickets (aligned with the request order):
  //   ok                  -> queue the ticket id for the receipt check
  //   DeviceNotRegistered -> prune the token now
  //   MessageRateExceeded -> RETRYABLE per Expo docs: returned for re-send
  //   anything else       -> permanent: log + count, do not retry
  // Returns the list of messages to retry (throttled ones only).
  async function postChunk(messages, now) {
    const r = await fetchFn(EXPO_PUSH_URL, {
      method: "POST",
      headers: expoHeaders(),
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) {
      const e = new Error("HTTP " + r.status);
      e.status = r.status;
      throw e;
    }
    let parsed = null;
    try { parsed = await r.json(); } catch (e) { /* body optional */ }
    const tickets = parsed && Array.isArray(parsed.data) ? parsed.data : [];
    const retry = [];
    let dropped = 0;
    for (let i = 0; i < messages.length; i++) {
      const t = tickets[i];
      if (!t || t.status === "ok") {
        stats.sent++;
        if (t && t.id) pendingReceipts.push({ id: t.id, token: messages[i].to, at: now });
        continue;
      }
      const code = t.details && t.details.error;
      if (code === "DeviceNotRegistered") {
        if (dropToken(messages[i].to, "ticket DeviceNotRegistered")) dropped++;
      } else if (code === "MessageRateExceeded") {
        retry.push(messages[i]);
      } else {
        stats.failed++;
        stats.lastError = { at: now, error: "ticket " + (code || t.message || "unknown") };
        log("push ticket error (permanent): " + (code || t.message || "unknown"));
      }
    }
    if (dropped > 0) persistSafe();
    return retry;
  }

  async function sendChunkWithRetry(messages, now) {
    let pending = messages;
    for (let tries = 0; ; tries++) {
      let transportError = null;
      try {
        pending = await postChunk(pending, now);
        if (pending.length === 0) return true;
      } catch (e) {
        transportError = e;
        if (!retryable(e)) {
          stats.failed += pending.length;
          stats.lastError = { at: now, error: e.message };
          log("push send FAILED (permanent): " + (e && e.message)
            + " | " + pending.length + " message(s)");
          return false;
        }
      }
      if (tries + 1 >= MAX_TRIES) {
        stats.failed += pending.length;
        stats.lastError = { at: now, error: transportError ? transportError.message : "MessageRateExceeded" };
        log("push send FAILED (" + MAX_TRIES + " attempts): "
          + (transportError ? transportError.message : "still rate-limited")
          + " | " + pending.length + " message(s)");
        return false;
      }
      await sleep(1000 * Math.pow(2, tries));
    }
  }

  // Serialize + pace all sends; the chain never rejects, so one bad batch
  // cannot wedge it (same contract as deliver.js).
  let chain = Promise.resolve();
  let lastSend = 0;

  function send(msg, meta) {
    const to = recipients(meta);
    if (to.length === 0) return Promise.resolve(true);
    if (process.env.LOG_ONLY === "1") {
      log("[push LOG_ONLY] " + to.length + " token(s): " + msg);
      return Promise.resolve(true);
    }
    const parts = splitMsg(msg);
    const messages = to.map(function (t) {
      const m = { to: t, title: parts.title, sound: "default", priority: "high" };
      if (parts.body) m.body = parts.body;
      if (meta) m.data = { coin: meta.coin, sym: meta.sym };
      return m;
    });
    const p = chain.then(async function () {
      let ok = true;
      for (let i = 0; i < messages.length; i += BATCH) {
        const wait = lastSend + MIN_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastSend = Date.now();
        if (!(await sendChunkWithRetry(messages.slice(i, i + BATCH), Date.now()))) ok = false;
      }
      return ok;
    });
    chain = p.then(function () {}, function () {});
    return p;
  }

  // ---- receipts ----
  // Tickets only mean "Expo accepted it"; the delivery outcome - including
  // most DeviceNotRegistered signals - arrives via getReceipts later. Ids
  // missing from a response are kept (receipt not ready yet) until 24h old.
  async function checkReceipts(now) {
    now = now || Date.now();
    // Age out first so a permanently-failing receipts endpoint cannot grow
    // the pending list without bound.
    pendingReceipts = pendingReceipts.filter(function (p) {
      return now - p.at < RECEIPT_MAX_AGE_MS;
    });
    const due = pendingReceipts.filter(function (p) { return now - p.at >= RECEIPT_DELAY_MS; });
    if (due.length === 0) return;
    const batch = due.slice(0, RECEIPT_BATCH);
    let parsed = null;
    try {
      const r = await fetchFn(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: expoHeaders(),
        body: JSON.stringify({ ids: batch.map(function (b) { return b.id; }) }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      parsed = await r.json();
    } catch (e) {
      log("push receipt check failed (will retry): " + (e && e.message));
      return; // transient: everything stays pending for the next timer tick
    }
    const receipts = (parsed && parsed.data && typeof parsed.data === "object") ? parsed.data : {};
    const resolved = new Set();
    let dropped = 0;
    for (const b of batch) {
      const rc = receipts[b.id];
      if (!rc) continue; // not ready yet - keep pending until age-out
      resolved.add(b.id);
      if (rc.status === "error") {
        const code = rc.details && rc.details.error;
        if (code === "DeviceNotRegistered") {
          if (dropToken(b.token, "receipt DeviceNotRegistered")) dropped++;
        } else {
          stats.receiptErrors++;
          stats.lastError = { at: now, error: "receipt " + (code || rc.message || "unknown") };
          log("push receipt error: " + (code || rc.message || "unknown"));
        }
      }
    }
    if (dropped > 0) persistSafe();
    pendingReceipts = pendingReceipts.filter(function (p) { return !resolved.has(p.id); });
  }

  const receiptTimer = setInterval(function () {
    checkReceipts().catch(function (e) {
      log("push receipt check threw: " + (e && e.message));
    });
  }, RECEIPT_TIMER_MS);
  receiptTimer.unref();

  return {
    register: register,
    unregister: unregister,
    count: count,
    favUnion: favUnion,
    stats: function () {
      return {
        sent: stats.sent,
        failed: stats.failed,
        receiptErrors: stats.receiptErrors,
        lastError: stats.lastError,
        pendingReceipts: pendingReceipts.length
      };
    },
    handleRegister: handleRegister,
    handleUnregister: handleUnregister,
    send: send,
    checkReceipts: checkReceipts,
    _tokens: tokens,             // exposed for tests
    _pendingReceipts: function () { return pendingReceipts; } // exposed for tests
  };
}

module.exports = { createPushStore: createPushStore, favMatches: favMatches };
