// A test world for the modules node --test cannot import straight from
// source: venue_store.ts, the venue adapters and the exchange clients import
// platform packages and talk to the network. This loads the REAL source of
// any src/lib module (transpiled in memory, nothing written to disk) with:
//
// - a fake clock (Date.now, setTimeout, setInterval) the test advances, so a
//   15 s payload expiry or a 60 s lookup deadline takes no real time;
// - a fake fetch (unmocked network access throws);
// - platform packages replaced by inert stubs;
// - any src/lib module replaced by a test double (`mocks`), e.g. key access.
//
// Nothing here uses a real key, a real address or a real venue.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const lib = path.join(root, "src", "lib");
const nodeRequire = createRequire(path.join(root, "package.json"));
const ts = nodeRequire("typescript");
const compiled = new Map();

function compile(file) {
  let js = compiled.get(file);
  if (js === undefined) {
    js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
    }).outputText;
    compiled.set(file, js);
  }
  return js;
}

const realImmediate = setImmediate;

// ---- the clock ----------------------------------------------------------------

export function makeClock(start = 1_700_000_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn, every, id }); return id; };
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, null),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms || 1)),
    clearTimeout: (id) => { timers.delete(id); },
    clearInterval: (id) => { timers.delete(id); },
    // timers still waiting (intervals excluded unless asked for)
    pending: (withIntervals = false) => [...timers.values()].filter((t) => withIntervals || t.every === null).length,
    Date: class FakeDate extends Date {
      constructor(...a) { if (a.length) super(...a); else super(now); }
      static now() { return now; }
    },
    // let every promise callback that is ready run
    async flush(rounds = 3) { for (let i = 0; i < rounds; i++) await new Promise((r) => realImmediate(r)); },
    // run the earliest timer due at or before `limit`; false when none is
    step(limit) {
      let first = null;
      for (const t of timers.values()) if (t.at <= limit && (first === null || t.at < first.at || (t.at === first.at && t.id < first.id))) first = t;
      if (!first) return false;
      now = Math.max(now, first.at);
      if (first.every === null) timers.delete(first.id); else first.at = now + first.every;
      first.fn();
      return true;
    },
    async advance(ms) {
      const until = now + ms;
      await clock.flush();
      while (clock.step(until)) await clock.flush();
      now = until;
      await clock.flush();
    },
    // drive time forward until the promise settles; throws if it never does
    async settle(promise, maxMs = 10 * 60_000) {
      let state = "pending", value, error;
      promise.then((v) => { state = "ok"; value = v; }, (e) => { state = "failed"; error = e; });
      const until = now + maxMs;
      await clock.flush();
      while (state === "pending") {
        if (!clock.step(until)) {
          await clock.flush();
          if (state === "pending") throw new Error("the promise did not settle within " + maxMs + " ms of fake time (" + clock.pending(true) + " timers left)");
        }
        await clock.flush();
      }
      if (state === "failed") throw error;
      return value;
    },
  };
  return clock;
}

// ---- the world ----------------------------------------------------------------

const memoryStorage = () => {
  const m = new Map();
  const api = { getItem: async (k) => (m.has(k) ? m.get(k) : null), setItem: async (k, v) => { m.set(k, String(v)); }, removeItem: async (k) => { m.delete(k); } };
  return { __esModule: true, default: api, ...api };
};

export function makeWorld({ mocks = {}, packages = {}, fetch = null, clock = makeClock() } = {}) {
  const cache = new Map();
  const world = {
    clock,
    mocks,
    fetch: fetch ?? (async () => { throw new Error("unmocked network access refused"); }),
    load,
  };
  const pkg = {
    "react-native": { __esModule: true, Platform: { OS: "web" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } },
    "@react-native-async-storage/async-storage": memoryStorage(),
    "expo-secure-store": { __esModule: true },
    react: { __esModule: true, useEffect() {}, useSyncExternalStore: (_s, get) => get() },
    ...packages,
  };
  function load(name) {
    if (Object.prototype.hasOwnProperty.call(world.mocks, name)) return world.mocks[name];
    const hit = cache.get(name);
    if (hit) return hit.exports;
    const module = { exports: {} };
    cache.set(name, module);
    const req = (spec) => {
      if (spec.startsWith("./")) return load(spec.slice(2));
      if (Object.prototype.hasOwnProperty.call(pkg, spec)) return pkg[spec];
      return nodeRequire(spec);
    };
    const run = new Function("require", "module", "exports", "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", compile(path.join(lib, name + ".ts")));
    run(req, module, module.exports, (...a) => world.fetch(...a), clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval, clock.Date);
    return module.exports;
  }
  return world;
}

// ---- common doubles ---------------------------------------------------------------

export const json = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

// The SDK's published test key (docs/CONTRACT.md: the only key tests may use).
export const TEST_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
// An obviously fake wallet address (never a real one).
export const FAKE_WALLET = "0x" + "1".repeat(40);

// settings_store double: just the pieces the venue layer reads.
export function fakeSettings(over = {}) {
  let s = { wallet: FAKE_WALLET, demo: false, oneClick: true, closePcts: [25, 50, 100], markets: {}, ...over };
  const listeners = new Set();
  return {
    getSettings: () => s,
    settingsReady: async () => undefined,
    subscribeSettings: (l) => { listeners.add(l); return () => listeners.delete(l); },
    marketSettings: (key) => ({ slippage: 0.01, maxNotional: 1_000_000, presets: null, ...(s.markets[key] ?? {}) }),
    updateSettings: (patch) => { s = { ...s, ...patch }; for (const l of [...listeners]) l(); },
  };
}

// A scripted Hyperliquid: the info reads the app makes and the exchange
// endpoint. Every exchange post is recorded in `sends` (the parsed body).
// Override a read with `info.<type> = (body) => value`, the exchange with
// `exchange = (action, body) => value` (throw = a transport failure).
export function fakeHyperliquid() {
  const hl = {
    sends: [],
    infoCalls: [],
    positions: [],        // [{ coin, szi }]
    orders: [],           // frontendOpenOrders rows
    statuses: {},         // cloid -> orderStatus answer
    info: {
      perpDexs: () => [null],
      metaAndAssetCtxs: () => [{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [{ markPx: "100", midPx: "100", prevDayPx: "99" }]],
      allMids: () => ({ BTC: "100" }),
      clearinghouseState: () => ({
        marginSummary: { accountValue: "10000", totalMarginUsed: "0" }, withdrawable: "10000",
        assetPositions: hl.positions.map((p) => ({ position: { coin: p.coin, szi: String(p.szi), entryPx: "100", positionValue: String(Math.abs(p.szi) * 100), unrealizedPnl: "0", marginUsed: "0", leverage: { type: "cross", value: 10 } } })),
      }),
      frontendOpenOrders: () => hl.orders,
      orderStatus: (b) => hl.statuses[b.oid] ?? { status: "unknownOid" },
      userFills: () => [],
      historicalOrders: () => [],
      activeAssetData: (b) => ({ user: b.user, coin: b.coin, leverage: { type: "cross", value: 10 }, maxTradeSzs: ["0", "0"], availableToTrade: ["0", "0"], markPx: "100" }),
    },
    exchange: () => ({ status: "ok", response: { type: "default" } }),
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      if (String(url).endsWith("/exchange")) {
        hl.sends.push(body);
        return json(await hl.exchange(body.action, body));
      }
      hl.infoCalls.push(body);
      const h = hl.info[body.type];
      if (!h) throw new Error("unscripted info read: " + body.type);
      return json(await h(body));
    },
  };
  return hl;
}

export const filled = (totalSz, avgPx = 100, oid = 1) => ({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: String(totalSz), avgPx: String(avgPx), oid } }] } } });
export const cancelled = (n = 1) => ({ status: "ok", response: { type: "cancel", data: { statuses: Array.from({ length: n }, () => "success") } } });
export const openOrder = (oid, px, over = {}) => ({ coin: "BTC", oid, side: "B", limitPx: String(px), sz: "1", origSz: "1", reduceOnly: false, isTrigger: false, orderType: "Limit", timestamp: 1, ...over });

// A promise the test resolves by hand (key access behind a prompt).
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
