"use strict";

// Webhook delivery abstraction.
// Backends: ntfy (message as POST body), discord ({content}), telegram
// (bot sendMessage). Configuration is env-var ONLY - the repo is public,
// no webhook URLs / topic names / tokens in code or config:
//   ALERT_BACKEND      ntfy | discord | telegram
//   ALERT_WEBHOOK_URL  full URL for ntfy/discord
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   for telegram
//   LOG_ONLY=1         log instead of sending (soak-test mode)
// Sends are SERIALIZED through a queue with a minimum inter-send gap so
// alert bursts (boot re-fires, broad market moves) do not trip webhook rate
// limits, and transient failures (network, HTTP 429, HTTP 5xx) are retried
// with exponential backoff. Config errors (missing env, other 4xx) are not
// retried. Permanent failure is logged and swallowed - delivery must NEVER
// crash the loop.

const TIMEOUT_MS = 10000;
const MAX_TRIES = 4;          // 1 attempt + up to 3 retries (1s/2s/4s backoff)
const MIN_GAP_MS = 500;       // Discord webhook limit is ~30/min; 2/s is safe

// Delivery observability, mirroring src/push.js stats() and surfaced the same
// way in /health. Added 2026-08-08 after this channel failed 100% in
// production while /health read "ok": alertsFired counts alerts that FIRED,
// not alerts that were DELIVERED, so a dead webhook and a healthy one produced
// byte-identical health output and the only evidence lived in stderr. It went
// unnoticed because Expo push is a SEPARATE channel and stayed healthy, so
// notifications kept arriving. Worse, a SUCCESSFUL send logs nothing at all
// (the console.log below is inside the LOG_ONLY branch), so success could only
// ever be inferred from the ABSENCE of a failure line in a short rolling log
// buffer. These counters are the positive signal that did not exist.
const stats = { sent: 0, failed: 0, lastError: null };

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function cfgError(msg) {
  const e = new Error(msg);
  e.permanent = true; // retrying cannot fix a configuration problem
  return e;
}

function retryable(e) {
  if (e && e.permanent) return false;
  if (e && typeof e.status === "number") return e.status === 429 || e.status >= 500;
  return true; // network error / timeout
}

async function postRaw(url, body, contentType) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: body,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!r.ok) {
    const e = new Error("HTTP " + r.status);
    e.status = r.status;
    throw e;
  }
}

async function sendOnce(msg) {
  const backend = (process.env.ALERT_BACKEND || "").toLowerCase();
  const url = process.env.ALERT_WEBHOOK_URL || "";
  if (backend === "ntfy") {
    if (!url) throw cfgError("ALERT_WEBHOOK_URL not set");
    await postRaw(url, msg, "text/plain");
  } else if (backend === "discord") {
    if (!url) throw cfgError("ALERT_WEBHOOK_URL not set");
    await postRaw(url, JSON.stringify({ content: msg }), "application/json");
  } else if (backend === "telegram") {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) throw cfgError("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
    await postRaw("https://api.telegram.org/bot" + token + "/sendMessage",
      JSON.stringify({ chat_id: chat, text: msg }), "application/json");
  } else {
    throw cfgError("unknown ALERT_BACKEND '" + backend
      + "' (use ntfy | discord | telegram, or LOG_ONLY=1)");
  }
}

async function sendWithRetry(msg) {
  for (let tries = 0; ; tries++) {
    try {
      await sendOnce(msg);
      stats.sent++;
      return true;
    } catch (e) {
      if (tries + 1 >= MAX_TRIES || !retryable(e)) {
        stats.failed++;
        stats.lastError = { at: Date.now(), error: (e && e.message) || "unknown" };
        console.error("[deliver] FAILED (" + (tries + 1) + " attempt"
          + (tries ? "s" : "") + "): " + (e && e.message) + " | msg: " + msg);
        return false;
      }
      await sleep(1000 * Math.pow(2, tries));
    }
  }
}

// Serialize + pace all sends. The chain never rejects (sendWithRetry
// resolves false on permanent failure), so one bad message cannot wedge it.
let chain = Promise.resolve();
let lastSend = 0;

function deliver(msg) {
  if (process.env.LOG_ONLY === "1") {
    // Counted as sent: the alert completed the delivery path as configured.
    // stats() reports logOnly so a soak run is never mistaken for real sends.
    console.log("[ALERT " + new Date().toISOString() + "] " + msg);
    stats.sent++;
    return Promise.resolve(true);
  }
  const p = chain.then(async function () {
    const wait = lastSend + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSend = Date.now();
    return sendWithRetry(msg);
  });
  chain = p.then(function () {}, function () {});
  return p;
}

// Shape mirrors push.stats() so /health reads the same for both channels.
// backend is reported because "unknown ALERT_BACKEND" is a real and silent
// misconfiguration (a typo'd value has bitten this project before), and
// logOnly distinguishes a soak run from live delivery.
function deliverStats() {
  return {
    backend: (process.env.ALERT_BACKEND || "").toLowerCase() || null,
    logOnly: process.env.LOG_ONLY === "1",
    sent: stats.sent,
    failed: stats.failed,
    lastError: stats.lastError
  };
}

module.exports = { deliver, deliverStats };
