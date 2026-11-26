"use strict";

// Minimal network-first service worker: makes the dashboard installable and
// provides an offline shell of the last-served page. Only same-origin
// NAVIGATIONS are handled - data calls (Hyperliquid API, /api/state, /health)
// always go straight to the network, so a stale cache can never serve stale
// market data.
var CACHE = "hip3-shell-v1";

self.addEventListener("install", function () { self.skipWaiting(); });

self.addEventListener("activate", function (e) {
  // Claim clients AND drop any cache generation this version does not own -
  // today only one name ever exists, so this is the latent-hygiene line that
  // makes a future CACHE bump actually shed the old shell.
  e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    })
  ]));
});

self.addEventListener("fetch", function (e) {
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    fetch(e.request).then(function (r) {
      var copy = r.clone();
      caches.open(CACHE).then(function (c) { c.put("/", copy); });
      return r;
    }).catch(function () {
      return caches.match("/").then(function (m) {
        return m || new Response("offline - reconnect and reload", {
          status: 503, headers: { "Content-Type": "text/plain" }
        });
      });
    })
  );
});
