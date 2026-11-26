// scripts/check-exchange-guard.js, run against changed copies of the tree
// held in memory (nothing is written to disk). An external review
// found that the guard passed a second sender with a split host string, a built
// action type, and a commented-out assertion. Each of those, and their
// neighbours, must now fail it; the tree as it stands must pass.
//
// The guard is a tripwire over source text. The boundary that holds whatever
// the source says is the assertion the exchange clients execute before
// signing or sending; the last tests here run that for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { fakeHyperliquid, FAKE_WALLET, makeWorld, TEST_KEY } from "./helpers/world.mjs";

const require = createRequire(import.meta.url);
const { check, loadTree, stripComments } = require("../scripts/check-exchange-guard.js");

const clean = loadTree();
// The guard's verdict on the tree with one file changed.
function withChange(file, change) {
  const tree = new Map(clean);
  const before = tree.get(file) ?? "";
  const after = change(before);
  assert.notEqual(after, before, "the mutation changed nothing in " + file);
  tree.set(file, after);
  return check(tree).errors;
}
const fails = (errors, re) => assert.ok(errors.some((e) => re.test(e)), "expected a violation matching " + re + ", got:\n" + (errors.join("\n") || "(the guard passed)"));

test("the tree as it stands passes the guard", () => {
  assert.deepEqual(check(clean).errors, []);
});

// ---- the first review's three mutations --------------------------------------------------

test("F9: a second sender in another file fails, even with its host split into pieces", () => {
  const errors = withChange("src/lib/venue.ts", (t) => t + '\nexport const leak = (payload: unknown) => fetch(["https://api.hyper", "liquid.xyz", "/exchange"].join(""), { method: "POST", body: JSON.stringify(payload) });\n');
  fails(errors, /src\/lib\/venue\.ts: names fetch/);
});

test("F9: a built action type in hl_orders.ts fails", () => {
  const errors = withChange("src/lib/hl_orders.ts", (t) => t.replace('{ type: "cancel", cancels: list.map', '{ type: ["usd", "Send"].join(""), cancels: list.map'));
  fails(errors, /hl_orders\.ts:\d+: an action type must be one of the four permitted string literals/);
  fails(errors, /hl_orders\.ts: builds a string or a key/);
  // a type read from a variable is no better
  fails(withChange("src/lib/hl_orders.ts", (t) => t.replace('{ type: "cancel", cancels: list.map', "{ type: kind, cancels: list.map")), /an action type must be one of the four/);
  // and a literal that is not one of the four is refused by name
  fails(withChange("src/lib/hl_orders.ts", (t) => t.replace('{ type: "cancel", cancels: list.map', '{ type: "usdSend", cancels: list.map')), /an action type must be one of the four|forbidden Hyperliquid action usdSend/);
});

test("F9: a commented-out assertion does not satisfy the guard", () => {
  fails(withChange("src/lib/hl_exchange.ts", (t) => t.replace("  assertScopedAction(action);", "  // assertScopedAction(action);")), /postExchange must begin by executing assertScopedAction/);
  fails(withChange("src/lib/hl_exchange.ts", (t) => t.replace("  assertScopedAction(action);", "  /* assertScopedAction(action); */")), /postExchange must begin by executing assertScopedAction/);
  fails(withChange("src/lib/mfp_exchange.ts", (t) => t.replace("    assertMfpWrite(req.write);", "    // assertMfpWrite(req.write);")), /call\(\) must execute assertMfpWrite/);
});

// ---- the same boundary, from its other sides ---------------------------------------------

test("the session check is pinned beside the action check, on both venues", () => {
  fails(withChange("src/lib/hl_exchange.ts", (t) => t.replace("  assertSession(s);\n", "").replace("  assertSession(s);\r\n", "")), /postExchange must begin by executing/);
  fails(withChange("src/lib/hl_exchange.ts", (t) => t.replace("  assertSession(s);", "  // assertSession(s);")), /postExchange must begin by executing/);
  fails(withChange("src/lib/mfp_exchange.ts", (t) => t.replace("if (!sessionLive(req.session)) return", "if (false) return")), /refuse a stale session/);
});

test("an assertion moved behind an earlier statement fails", () => {
  const errors = withChange("src/lib/hl_exchange.ts", (t) => t.replace("  assertScopedAction(action);", "  const early = signL1Action(key, action, 1, null, 2, IS_MAINNET);\n  assertScopedAction(action);"));
  fails(errors, /postExchange must begin by executing/);
  fails(errors, /must call signL1Action exactly once/);
});

test("a second fetch, an aliased fetch or another transport fails in a client file too", () => {
  fails(withChange("src/lib/hl_exchange.ts", (t) => t + "\nconst send = fetch;\n"), /hl_exchange\.ts: must name fetch exactly once/);
  fails(withChange("src/lib/hyperliquid.ts", (t) => t + '\nexport const other = () => fetch("https://example.invalid");\n'), /hyperliquid\.ts: must name fetch exactly once/);
  fails(withChange("src/lib/mfp_exchange.ts", (t) => t.replace("fetch(HOSTS[env] + path,", "fetch(other + path,")), /its one fetch must be the call/);
  fails(withChange("src/lib/hl_exchange.ts", (t) => t.replace('const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";', 'const EXCHANGE_URL = ["https://api.hyper", "liquid.xyz/exchange"].join("");')), /EXCHANGE_URL must be the literal exchange URL/);
  fails(withChange("src/lib/order_policy.ts", (t) => t + "\nexport const x = () => new XMLHttpRequest();\n"), /names another transport/);
  fails(withChange("src/lib/venue_store.ts", (t) => t + '\nconst sock = new WebSocket("wss://example.invalid");\n'), /names WebSocket outside hl_stream\.ts/);
  fails(withChange("src/lib/venue_store.ts", (t) => t + "\nnavigator.sendBeacon(u, d);\n"), /names another transport/);
});

test("the session and the agent binding stay import-free (docs/CONTRACT.md: pure modules)", () => {
  fails(withChange("src/lib/session.ts", (t) => 'import { getSettings } from "./settings_store";\n' + t), /src\/lib\/session\.ts must stay import-free/);
  fails(withChange("src/lib/agent_binding.ts", (t) => 'import { Platform } from "react-native";\n' + t), /src\/lib\/agent_binding\.ts must stay import-free/);
});

test("the MFP request count stays import-free: it holds no key store, no client, no platform (docs/CONTRACT.md: pure modules)", () => {
  fails(withChange("src/lib/mfp_rate.ts", (t) => 'import { getMfpKey } from "./agent_store";\n' + t), /src\/lib\/mfp_rate\.ts must stay import-free/);
  fails(withChange("src/lib/mfp_rate.ts", (t) => 'import { Platform } from "react-native";\n' + t), /src\/lib\/mfp_rate\.ts must stay import-free/);
});

test("the word fetch in a comment or a message is not a use of fetch", () => {
  const tree = new Map(clean);
  tree.set("src/lib/order_policy.ts", tree.get("src/lib/order_policy.ts") + '\n// the store will fetch the mark\nexport const note = "fetch failed";\n');
  assert.deepEqual(check(tree).errors, []);
});

test("stripComments: comments go, strings and regex literals stay, line breaks are kept", () => {
  const src = 'const u = "https://x.invalid/a"; // gone\nconst r = /["\']\\/\\//.test(s); /* gone\n too */ const k = 1;\n';
  const out = stripComments(src);
  assert.ok(out.includes('"https://x.invalid/a"'));
  assert.ok(out.includes('/["\']\\/\\//.test(s);'));
  assert.ok(!out.includes("gone") && !out.includes("too"));
  assert.ok(out.includes("const k = 1;"));
  assert.equal(out.split("\n").length, src.split("\n").length);
  // with strings blanked, only identifiers and syntax are left
  assert.ok(!stripComments('log("fetch failed"); fetch(API, x);', true).includes("failed"));
  assert.equal((stripComments('log("fetch failed"); fetch(API, x);', true).match(/\bfetch\b/g) || []).length, 1);
});

// ---- T6: a second review's four mutations, and their neighbours ---------------------------
// Each passed the lexical guard with zero errors. The guard now reads the
// TypeScript syntax tree, so none of these can hide a sender or skip an
// assertion. Every case must produce at least one error.

const PROBE = "src/lib/probe.ts";
const mfpBase = clean.get("src/lib/mfp_exchange.ts");
const T6 = {
  alias: [PROBE, /probe\.ts: names fetch/, () => 'export const probe = (url: string, body: string) => globalThis["fetch"](url, {method: "POST", body});'],
  template: [PROBE, /probe\.ts: names fetch/, () => "export const probe = (url: string) => `reply: ${fetch(url)}`;"],
  regex: [PROBE, /probe\.ts: names fetch/, () => "export function quote(s: string) { return /[\"']/.test(s); }\nexport const probe = (url: string) => fetch(url);"],
  deadAssertion: ["src/lib/mfp_exchange.ts", /call\(\) must execute assertMfpWrite/, () => mfpBase.replace("    assertMfpWrite(req.write);", "    if (false) {\n    assertMfpWrite(req.write);").replace("    path = req.write.path;", "    }\n    path = req.write.path;")],
};
for (const [name, [file, why, make]] of Object.entries(T6)) {
  test("T6 (" + name + "): the audit's mutation fails the guard", () => {
    const errors = withChange(file, make);
    assert.ok(errors.length > 0, "the guard passed the " + name + " mutation");
    fails(errors, why);
  });
}

test("T6: hidden senders in another file fail (global aliases, computed keys, templates, regex, eval)", () => {
  const probe = (src) => withChange(PROBE, () => src);
  fails(probe("export const p = (u: string) => window.fetch(u);"), /probe\.ts: names fetch/);
  fails(probe("export const p = (u: string) => self.fetch(u);"), /probe\.ts: names fetch/);
  fails(probe("export const p = (u: string) => globalThis.window.fetch(u);"), /probe\.ts: names fetch/);
  fails(probe('export const p = (u: string) => (self as any)["fe" + "tch"](u);'), /uses a global object/);
  fails(probe('export const p = (u: string) => self["fe" + "tch"](u);'), /uses a global object/);
  fails(probe('const k = "fe" + "tch";\nexport const p = (u: string) => globalThis[k](u);'), /uses a global object/);
  fails(probe("const g: any = globalThis;\nexport const p = (u: string) => g.send(u);"), /uses a global object/);
  fails(probe('export const p = (u: string) => Reflect.get(window, "x")(u);'), /uses a global object/);
  fails(probe("export const { fetch: f } = globalThis;"), /names fetch/);
  fails(probe("export const p = (u: string) => `a ${`b ${window.fetch(u)}`}`;"), /names fetch/);
  fails(probe('export const p = (u: string) => eval("fe" + "tch")(u);'), /names eval/);
  fails(probe('export const p = new Function("u", "return fe" + "tch(u)");'), /names Function/);
  fails(probe('export const p = (() => 0).constructor("return 1");'), /constructor/);
  fails(probe('export const p = () => import("./hl_exchange");'), /dynamic import/);
  fails(probe("const m = \"./x\";\nexport const p = () => require(m);"), /require is only allowed/);
  fails(probe('setTimeout("send()", 1);'), /setTimeout given a string/);
  fails(probe('import axios from "axios";\nexport const p = axios;'), /HTTP \/ socket client package/);
  fails(probe('export const p = () => new (globalThis["XMLHttpRequest"])();'), /names another transport/);
  fails(probe("export const p = (u: string) => { if (u) { return 1; } else { return fetch(u); } };"), /names fetch/);
  fails(probe("export const p = (u: string) => fetch(u)\nexport const q = 1 +"), /does not parse|names fetch/);
});

test("T6: a second hidden fetch in a client file fails, behind a regex or inside a template", () => {
  fails(withChange("src/lib/hl_exchange.ts", (t) => t + "\nconst q = (x: string) => { return /[\"']/.test(x); };\nexport const g = () => fetch(EXCHANGE_URL, {});\n"), /hl_exchange\.ts: must name fetch exactly once/);
  fails(withChange("src/lib/hyperliquid.ts", (t) => t + "\nexport const g = () => `${fetch(API, {})}`;\n"), /hyperliquid\.ts: must name fetch exactly once/);
  fails(withChange("src/lib/mfp_market_list.ts", (t) => t + '\nexport const g = () => globalThis["fetch"](LIST_URL, {});\n'), /mfp_market_list\.ts: must name fetch exactly once/);
});

test("T6: the Hyperliquid assertions cannot be skipped (if, try, &&, early return, dead branch)", () => {
  const re = /postExchange must begin by executing/;
  const hl = (from, to) => withChange("src/lib/hl_exchange.ts", (t) => t.replace(from, to));
  fails(hl("  assertScopedAction(action);", "  try { assertScopedAction(action); } catch { /* swallowed */ }"), re);
  fails(hl("  assertScopedAction(action);", "  if (!key) return null as never;\n  assertScopedAction(action);"), re);
  fails(hl("  assertScopedAction(action);", "  action && assertScopedAction(action);"), re);
  fails(hl("  assertScopedAction(action);", "  if (false) assertScopedAction(action);"), re);
  fails(hl("  assertSession(s);", "  if (Date.now() < 0) { assertSession(s); }"), re);
  fails(hl("  assertSession(s);", "  for (const _ of []) assertSession(s);"), re);
  fails(hl("  assertSession(s);", "  void (s && assertSession(s));"), re);
});

test("T6: the Hyperliquid boundary is the imported assertion, on the same action, ahead of the one signature and send", () => {
  const hl = (change) => withChange("src/lib/hl_exchange.ts", change);
  // a local stand-in, or a parameter that shadows the import
  fails(hl((t) => t + "\nfunction assertScopedAction(_a: unknown) { return; }\n"), /assertScopedAction is declared 2 times/);
  fails(hl((t) => t.replace("async function postExchange(s: Session, key: string, action: ExchangeAction,", "async function postExchange(s: Session, key: string, action: ExchangeAction, assertSession: (x: unknown) => void,")), /assertSession is declared 2 times/);
  // the action is changed after it was asserted
  fails(hl((t) => t.replace("  assertSession(s);", '  assertSession(s);\n  (action as { grouping?: string }).grouping = "na";')), /postExchange assigns to s or action/);
  // the signature or the send moved into a closure
  fails(hl((t) => t.replace("const signature = signL1Action(key, action,", "const later = () => signL1Action(key, action,").replace("const body = JSON.stringify({ action, nonce, signature,", "const signature = later();\n  const body = JSON.stringify({ action, nonce, signature,")), /signL1Action must be called inside postExchange/);
  fails(hl((t) => t.replace("Promise.race([fetch(EXCHANGE_URL,", "Promise.race([(() => fetch(EXCHANGE_URL,").replace("signal: ctl.signal }), deadline]);", "signal: ctl.signal }))(), deadline]);")), /its fetch must sit inside postExchange/);
});

test("T6: the MFP assertions cannot be skipped, and a write cannot ride the read branch", () => {
  const mfp = (from, to) => withChange("src/lib/mfp_exchange.ts", (t) => t.replace(from, to));
  const re = /call\(\) must execute assertMfpWrite/;
  fails(mfp("    assertMfpWrite(req.write);", "    try { assertMfpWrite(req.write); } catch { /* swallowed */ }"), re);
  fails(mfp("    assertMfpWrite(req.write);", "    if (!key) return { kind: \"transport\", message: \"x\" };\n    assertMfpWrite(req.write);"), re);
  fails(mfp("    assertMfpWrite(req.write);", "    req.write && assertMfpWrite(req.write);"), re);
  fails(mfp("if (!sessionLive(req.session)) return", "if (!sessionLive(req.session) && false) return"), /refuse a stale session/);
  fails(mfp('if (req.method === "WRITE") {', 'if (req.method === "WRITE" && false) {'), re);
  fails(mfp('method = "GET";', 'method = "POST";'), /sets method to something other than/);
  fails(mfp("    path = req.write.path;", "    path = req.write.path;\n    (req as { write: unknown }).write = null;"), /call\(\) assigns to req/);
  fails(withChange("src/lib/mfp_exchange.ts", (t) => t + "\nfunction sessionLive(_s: unknown) { return true; }\n"), /sessionLive is declared 2 times/);
  fails(mfp("{ method, headers, body, signal: ctl.signal }", '{ method: "POST", headers, body, signal: ctl.signal }'), /must send \{ method, \.\.\. \}/);
});

test("T6: the URL constants are const literals in the syntax tree", () => {
  fails(withChange("src/lib/hl_exchange.ts", (t) => t.replace('const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";', '// const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";\nlet EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";')), /EXCHANGE_URL must be the literal exchange URL/);
});

// ---- the MFP hosts and the pass-through -------------------------------------

test("the MFP hosts are pinned: the app's own origin on the web, MFP's two API hosts otherwise", () => {
  const F = "src/lib/mfp_exchange.ts";
  const pin = /HOSTS must be the pinned declaration/;
  fails(withChange(F, (t) => t.replace('{ live: "/mfp/live", sandbox: "/mfp/sandbox" }', '{ live: "https://relay.example/mfp/live", sandbox: "/mfp/sandbox" }')), pin);
  fails(withChange(F, (t) => t.replace('{ live: "/mfp/live", sandbox: "/mfp/sandbox" }', '{ live: "/mfp/sandbox", sandbox: "/mfp/live" }')), pin);
  fails(withChange(F, (t) => t.replace('sandbox: "https://sandbox.myfundedperpetuals.com" }', 'sandbox: "https://sandbox.myfundedperpetuals.com", other: "https://elsewhere.example" }')), pin);
  fails(withChange(F, (t) => t.replace('Object.freeze(Platform.OS === "web"', 'Object.freeze(Platform.OS !== "android"')), pin);
  fails(withChange(F, (t) => t.replace("const HOSTS: Readonly<Record<MfpEnv, string>> =", "let HOSTS: Readonly<Record<MfpEnv, string>> =")), pin);
  // a second HOSTS nearer the fetch
  fails(withChange(F, (t) => t.replace("const ctl = new AbortController();", 'const HOSTS = { live: "https://elsewhere.example", sandbox: "https://elsewhere.example" };\n  const ctl = new AbortController();')), pin);
  // Platform must be the platform package's, not a local stand-in
  fails(withChange(F, (t) => t.replace('import { Platform } from "react-native";', 'const Platform = { OS: "web" };')), /Platform must be imported from react-native/);
});

test("the market list's URL is pinned the same way", () => {
  const F = "src/lib/mfp_market_list.ts";
  fails(withChange(F, (t) => t.replace('"/mfp/live/v1/markets?venues=all"', '"/elsewhere/v1/markets?venues=all"')), /LIST_URL as the pinned declaration/);
  fails(withChange(F, (t) => t.replace('Platform.OS === "web" ? "/mfp/live/v1/markets?venues=all" :', 'Platform.OS === "web" ? "/mfp/live/v1/markets?venues=all" : Platform.OS === "ios" ? "/x" :')), /LIST_URL as the pinned declaration/);
  fails(withChange(F, (t) => t.replace('import { Platform } from "react-native";', 'const Platform = { OS: "android" };')), /Platform must be imported from react-native/);
});

test("the pass-through can reach MFP's two hosts only, sends once, and answers its own origin only", () => {
  const P = "server/mfp_passthrough.mjs", R = "server/mfp_route.mjs", S = "server/serve.mjs", A = "server/app.mjs";
  // a retry
  fails(withChange(P, (t) => t.replace("upstream = await send(route.upstream,", "upstream = (await send(route.upstream, {}).catch(() => null)) ?? await send(route.upstream,")), /must call its sender exactly once/);
  // an address of its own
  fails(withChange(P, (t) => t + '\nexport const ALT = "https://elsewhere.example/v1";\n'), /mfp_passthrough\.mjs: names a URL/);
  // another upstream
  const other = withChange(R, (t) => t.replace('"https://sandbox.myfundedperpetuals.com"', '"https://sandbox.elsewhere.example"'));
  fails(other, /mfp_route\.mjs: names a URL other than MFP's two API hosts/);
  fails(other, /mfp_route\.mjs: must name https:\/\/sandbox\.myfundedperpetuals\.com/);
  // CORS
  fails(withChange(P, (t) => t.replace('const out = { "Cache-Control": "no-store",', 'const out = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store",')), /names a CORS header/);
  // a second sender, a second fetch, another way out
  fails(withChange(S, (t) => t + '\nawait fetch("/x");\n'), /serve\.mjs: names fetch/);
  fails(withChange(P, (t) => t + "\nexport const again = (u) => fetch(u);\n"), /must name fetch exactly once/);
  fails(withChange(S, (t) => t + '\nhttp.request({ host: "elsewhere.example" }).end();\n'), /client request through node:http/);
  fails(withChange(A, (t) => t.replace('import http from "node:http";', 'import http from "node:http";\nimport https from "node:https";')), /imports node:https/);
  fails(withChange(A, (t) => t.replace('import http from "node:http";', 'import http from "node:http";\nimport { spawn } from "node:child_process";')), /imports node:child_process/);
  fails(withChange(A, (t) => t + '\nawait fetch("/x");\n'), /app\.mjs: names fetch/);
  fails(withChange(P, (t) => t + '\nconst ws = new WebSocket("x");\n'), /names another transport/);
});

// ---- the MFP account stream (added 2026-11-26) -------------------------------

test("the account stream is receive-only: the words send and ping are banned from its file and from the relay", () => {
  const F = "src/lib/mfp_stream.ts", R = "server/mfp_stream_relay.mjs";
  const word = /mfp_stream\.ts holds the word send or ping/;
  // every way of writing a frame names the word
  fails(withChange(F, (t) => t + '\nexport const a = (w: WebSocket) => w.send("x");\n'), word);
  fails(withChange(F, (t) => t + '\nexport const b = (w: WebSocket) => w.send?.("x");\n'), word);
  fails(withChange(F, (t) => t + "\nexport const c = (w: WebSocket) => { const { send } = w; return send; };\n"), word);
  fails(withChange(F, (t) => t + '\nexport const d = (w: WebSocket) => w["send"].call(w, "x");\n'), word);
  fails(withChange(F, (t) => t + "\nexport const e = (w: { ping: () => void }) => w.ping();\n"), word);
  fails(withChange(F, (t) => t.replace("sock.onerror = () => undefined;", 'sock.onerror = () => undefined;\n  sock.onopen = () => { sock.send(JSON.stringify({ op: "ping" })); };')), word);
  // a comment is no place for it either: the ban is on the words
  fails(withChange(F, (t) => t + "\n// TODO: send a ping every 20 s\n"), word);
  const relay = /mfp_stream_relay\.mjs:\d+: holds the word send or ping/;
  fails(withChange(R, (t) => t.replace("    upstream.onopen = () => {", '    upstream.onopen = () => {\n      upstream.send("{}");')), relay);
  fails(withChange(R, (t) => t.replace("    upstream.onopen = () => {", "    upstream.onopen = () => {\n      upstream.ping?.();")), relay);
  fails(withChange(R, (t) => t + "\n// keep the socket warm: ping it\n"), relay);
});

test("the account stream's addresses are pinned: one host, two paths, in two files", () => {
  const F = "src/lib/mfp_stream.ts", R = "server/mfp_stream_relay.mjs";
  // the app's side
  fails(withChange(F, (t) => t.replace('live: "wss://account-stream.myfundedperpetuals.com/v1/stream", sandbox:', 'live: "wss://stream.elsewhere.example/v1/stream", sandbox:')), /DIRECT must be the pinned declaration/);
  fails(withChange(F, (t) => t.replace('{ live: "/mfp/live/v1/stream", sandbox: "/mfp/sandbox/v1/stream" }', '{ live: "https://relay.elsewhere.example/mfp/live/v1/stream", sandbox: "/mfp/sandbox/v1/stream" }')), /RELAY must be the pinned declaration/);
  fails(withChange(F, (t) => t.replace('{ live: "/mfp/live/v1/stream", sandbox: "/mfp/sandbox/v1/stream" }', '{ live: "/mfp/sandbox/v1/stream", sandbox: "/mfp/live/v1/stream" }')), /RELAY must be the pinned declaration/);
  fails(withChange(F, (t) => t.replace("const DIRECT: Readonly<Record<MfpEnv, string>> = Object.freeze(", "const DIRECT: Record<MfpEnv, string> = (")), /DIRECT must be the pinned declaration/);
  fails(withChange(F, (t) => t + '\nconst other = "wss://elsewhere.example/v1/stream";\n'), /names an address other than the stream host's two paths/);
  // the file is exempt from the REST host rule, so it is held to its own: no way to the REST host from here
  fails(withChange(F, (t) => t + '\nconst rest = "https://developers.myfundedperpetuals.com/v1/accounts";\n'), /names the MFP host other than in its two pinned stream addresses/);
  fails(withChange(F, (t) => t + '\nconst piece = "developers.myfundedperpetuals";\n'), /names the MFP host other than in its two pinned stream addresses/);
  fails(withChange(F, (t) => t + '\nconst rest = "/v1/positions";\n'), /MFP resource \/v1\/positions is not on the docs\/CONTRACT\.md list for the stream/);
  // the fetch goes to the app's own origin and nowhere else; the socket to the stream host
  fails(withChange(F, (t) => t.replace("await fetch(RELAY[env] + query,", "await fetch(DIRECT[env] + query,")), /its one fetch must be the call fetch\(RELAY\[env\] \+ query/);
  fails(withChange(F, (t) => t.replace("await fetch(RELAY[env] + query,", 'await fetch("https://elsewhere.example" + RELAY[env] + query,')), /its one fetch must be the call|names an address other than/);
  fails(withChange(F, (t) => t + "\nexport const again = (u: string) => fetch(u);\n"), /mfp_stream\.ts: must name fetch exactly once/);
  fails(withChange(F, (t) => t.replace('{ method: "GET", headers: { Authorization: "Bearer " + key, Accept: "application/x-ndjson" }, signal: ctl.signal }', '{ method: "POST", headers: { Authorization: "Bearer " + key }, signal: ctl.signal }')), /its fetch must pass exactly \{ method: "GET", headers, signal \}/);
  fails(withChange(F, (t) => t.replace("signal: ctl.signal });", 'signal: ctl.signal, body: "{}" });')), /its fetch must pass exactly \{ method: "GET", headers, signal \}/);
  fails(withChange(F, (t) => t.replace("(DIRECT[env] + query, null,", "(other + query, null,")), /must build ONE WebSocket, on DIRECT\[env\] \+ query/);
  fails(withChange(F, (t) => t + '\nexport const second = () => new WebSocket("wss://account-stream.myfundedperpetuals.com/v1/stream");\n'), /must build ONE WebSocket|names an address other than/);
  fails(withChange(F, (t) => t + "\nconst Alias = WebSocket;\n"), /must build ONE WebSocket/);
  fails(withChange(F, (t) => t.replace('(Platform.OS === "web" ? openRelayed : openDirect)(', '(Platform.OS !== "android" ? openRelayed : openDirect)(')), /the transport must be chosen once, by \(Platform\.OS === "web"/);
  // it cannot reach the key store or the REST client
  fails(withChange(F, (t) => 'import { getMfpKey } from "./agent_store";\n' + t), /imports \.\/agent_store - the stream may import/);
  fails(withChange(F, (t) => 'import { fetchMfpBook } from "./mfp_exchange";\n' + t), /imports \.\/mfp_exchange - the stream may import/);
  // the pure half stays pure
  fails(withChange("src/lib/mfp_stream_core.ts", (t) => 'import { Platform } from "react-native";\n' + t), /src\/lib\/mfp_stream_core\.ts must stay import-free/);
  // the stream's host, addresses, paths and transport stay out of every other file
  fails(withChange("src/lib/mfp_exchange.ts", (t) => t + '\nconst s = "account-stream";\n'), /the MFP stream host outside mfp_stream\.ts/);
  fails(withChange("src/lib/mfp_exchange.ts", (t) => t + '\nconst s = "/v1/stream";\n'), /MFP resource \/v1\/stream is not on the docs\/CONTRACT\.md list/);
  fails(withChange("src/lib/venue_store.ts", (t) => t + '\nconst s = "wss://example.invalid/v1/accounts";\n'), /a WebSocket URL outside/);
  fails(withChange("src/lib/mfp_venue.ts", (t) => t + "\nconst Sock = globalThis.WebSocket;\n"), /a line of code names WebSocket outside|names WebSocket outside/);
  fails(withChange("src/lib/mfp_venue.ts", (t) => t + '\nconst Sock = (globalThis as Record<string, unknown>)["Web" + "Socket"];\n'), /uses a global object/);
  fails(withChange("src/components/status-bar.tsx", (t) => t + "\nconst Alias = WebSocket;\n"), /names WebSocket outside/);
  // the relay's side
  fails(withChange(R, (t) => t.replace('sandbox: "wss://account-stream.myfundedperpetuals.com/v1/sandbox/stream" });', 'sandbox: "wss://stream.elsewhere.example/v1/sandbox/stream" });')), /MFP_STREAM_UPSTREAM must be the pinned declaration/);
  fails(withChange(R, (t) => t + '\nexport const ALT = "wss://elsewhere.example/v1/stream";\n'), /mfp_stream_relay\.mjs: names an address other than the stream host's two paths/);
  fails(withChange("server/mfp_route.mjs", (t) => t + '\nexport const S = "/v1/sandbox/stream";\n'), /mfp_route\.mjs: names the MFP stream host or a stream path/);
  fails(withChange("server/app.mjs", (t) => t + '\nconst host = "account-stream.example";\n'), /app\.mjs: names the MFP stream host or a stream path/);
  fails(withChange("server/app.mjs", (t) => t + '\nconst ws = new WebSocket("x");\n'), /names another transport/);
});

test("the relay opens ONE upstream socket per request, on the checked address, and never again", () => {
  const R = "server/mfp_stream_relay.mjs", A = "server/app.mjs", S = "server/serve.mjs";
  const lf = (t) => t.replace(/\r\n/g, "\n");
  const once = /must build its upstream socket exactly once/;
  const MAKE = "      upstream = new Socket(route.upstream, { headers: { Authorization: authorization } });";
  // a reconnect: a second socket, a loop, a catch
  fails(withChange(R, (t) => lf(t).replace(MAKE, MAKE + "\n      const second = new Socket(route.upstream, { headers: { Authorization: authorization } });")), once);
  fails(withChange(R, (t) => lf(t).replace("    try {\n" + MAKE, "    for (let i = 0; i < 3 && !upstream; i++) try {\n" + MAKE)), /found inside a loop - the relay never reconnects/);
  fails(withChange(R, (t) => lf(t).replace("    } catch {\n      finish(1006);\n      return;\n    }", "    } catch {\n      upstream = new Socket(route.upstream, { headers: { Authorization: authorization } });\n    }")), once);
  fails(withChange(R, (t) => lf(t).replace("    upstream.onerror = () => finish(1006);", "    upstream.onerror = () => { upstream = new Socket(route.upstream, { headers: { Authorization: authorization } }); };")), once);
  // another address
  fails(withChange(R, (t) => lf(t).replace(MAKE, MAKE.replace("route.upstream", "other"))), once);
  // an alias of the socket class is a second socket
  fails(withChange(R, (t) => lf(t).replace(MAKE, "      const Again = Socket;\n" + MAKE)), /the socket class is named 4 times/);
  fails(withChange(R, (t) => t + "\nexport const again = (u) => new globalThis.WebSocket(u);\n"), /WebSocket must be named once/);
  // the address check comes first
  fails(withChange(R, (t) => lf(t).replace('    if (!mfpStreamUpstreamOk(route.upstream)) return answer(400, "passthrough_refused", "not an MFP stream address");\n', "")), /the address must be checked before the socket is built/);
  // the handler is mounted once and called once per request
  const mount = /app\.mjs: the stream relay's handler is called \d+ times/;
  fails(withChange(A, (t) => t.replace("{ handleMfpStream(req, res); return; }", "{ handleMfpStream(req, res); handleMfpStream(req, res); return; }")), mount);
  fails(withChange(A, (t) => t.replace("{ handleMfpStream(req, res); return; }", "{ for (let i = 0; i < 2; i++) handleMfpStream(req, res); return; }")), mount);
  fails(withChange(S, (t) => t.replace("makeApp({ dist, handleMfp, handleMfpStream }).listen(", 'makeApp({ dist, handleMfp, handleMfpStream }).on("request", handleMfpStream).listen(')), /serve\.mjs: names the stream relay's handler 3 times/);
  fails(withChange(S, (t) => t + "\nconst other = makeMfpStreamRelay({ hosts, log });\n"), /makeMfpStreamRelay is named 3 times/);
  fails(withChange("server/mfp_route.mjs", (t) => t + "\nexport const replay = (handleMfpStream, q, s) => handleMfpStream(q, s);\n"), /mfp_route\.mjs: names the stream relay's handler/);
});

test("the pass-through's one send cannot be looped, replayed, redirected or re-addressed (independent review)", () => {
  const P = "server/mfp_passthrough.mjs", R = "server/mfp_route.mjs";
  const SEND = "    let upstream;\n    try {\n      upstream = await send(route.upstream,";
  // one textual send(, inside a retry loop
  fails(withChange(P, (t) => t.replace(/\r\n/g, "\n").replace(SEND, "    let upstream;\n    for (let i = 0; i < 2 && !upstream; i++) try {\n      upstream = await send(route.upstream,")), /the send sits inside a loop/);
  fails(withChange(P, (t) => t.replace(/\r\n/g, "\n").replace(SEND, "    let upstream;\n    while (!upstream) try {\n      upstream = await send(route.upstream,")), /the send sits inside a loop/);
  // moved into a helper that something else could call again
  fails(withChange(P, (t) => t.replace("upstream = await send(route.upstream,", "upstream = await (async () => send(route.upstream,").replace("signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });", "signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }))();")), /the send must be a direct statement of handleMfp/);
  // the handler calling itself after a failure
  fails(withChange(P, (t) => t.replace('return done(timedOut ? 504 : 502,', "if (!timedOut) return handleMfp(req, res);\n      return done(timedOut ? 504 : 502,")), /handleMfp is named 2 times/);
  // a redirect followed (a 307 would replay the write)
  fails(withChange(P, (t) => t.replace('redirect: "manual", ', "")), /must pass \{ redirect: "manual" \}/);
  fails(withChange(P, (t) => t.replace('redirect: "manual"', 'redirect: "follow"')), /must pass \{ redirect: "manual" \}/);
  fails(withChange(P, (t) => t.replace("{ method: req.method, headers, body, redirect:", "{ ...extra, method: req.method, headers, body, redirect:")), /must pass \{ redirect: "manual" \}/);
  // another address
  fails(withChange(P, (t) => t.replace("await send(route.upstream,", "await send(req.headers.forward || route.upstream,")), /the send's address must be route\.upstream/);
  // a URL built from pieces: a bare scheme is an address too
  fails(withChange(R, (t) => t + '\nexport const alt = (h) => "https://" + h + "/v1";\n'), /mfp_route\.mjs: names a URL other than MFP's two API hosts \(3 schemes/);
  fails(withChange(P, (t) => t + '\nexport const alt = (h) => "https://" + h;\n'), /mfp_passthrough\.mjs: names a URL/);
});

// ---- an external review: R2 (the effective destination), R3 (the effective send) --

test("R2: a host joined from pieces, an unfrozen or a second upstream table fails", () => {
  const R = "server/mfp_route.mjs";
  const pin = /MFP_UPSTREAM must be the pinned declaration/;
  // the review's mutation: every URL in the text is still MFP's, the host is not
  fails(withChange(R, (t) => t.replace('live: "https://developers.myfundedperpetuals.com",', 'live: "https://developers.myfundedperpetuals.com" + ".example.org",')), pin);
  fails(withChange(R, (t) => t.replace('sandbox: "https://sandbox.myfundedperpetuals.com" });', 'sandbox: "https://sandbox.myfundedperpetuals.com" + suffix });')), pin);
  fails(withChange(R, (t) => t.replace('live: "https://developers.myfundedperpetuals.com",', 'live: `https://developers.myfundedperpetuals.com${tail}`,')), pin);
  // not frozen: something could write to it
  fails(withChange(R, (t) => t.replace("export const MFP_UPSTREAM = Object.freeze({", "export const MFP_UPSTREAM = ({")), pin);
  fails(withChange(R, (t) => t.replace("export const MFP_UPSTREAM =", "export let MFP_UPSTREAM =")), pin);
  // the two swapped, a third entry, a second table nearer its use
  fails(withChange(R, (t) => t.replace('{ live: "https://developers.myfundedperpetuals.com", sandbox: "https://sandbox.myfundedperpetuals.com" }', '{ live: "https://sandbox.myfundedperpetuals.com", sandbox: "https://developers.myfundedperpetuals.com" }')), pin);
  fails(withChange(R, (t) => t.replace('sandbox: "https://sandbox.myfundedperpetuals.com" });', 'sandbox: "https://sandbox.myfundedperpetuals.com", other: "/x" });')), pin);
  fails(withChange(R, (t) => t.replace("  const q = target.indexOf(\"?\");", '  const MFP_UPSTREAM = { live: "/x", sandbox: "/x" };\n  const q = target.indexOf("?");')), pin);
});

test("R2: HOSTS in the app is frozen and named once more only - no assignment to it, no alias of it", () => {
  const F = "src/lib/mfp_exchange.ts";
  const once = /HOSTS must be named once beside its declaration/;
  // the review's mutation: a direct write to the declared object
  fails(withChange(F, (t) => t + '\nHOSTS.live = "https://relay.example.org";\n'), once);
  fails(withChange(F, (t) => t + '\nObject.assign(HOSTS, { live: "/elsewhere" });\n'), once);
  fails(withChange(F, (t) => t + "\nconst other = HOSTS;\n"), once);
  fails(withChange(F, (t) => t.replace("fetch(HOSTS[env] + path,", "fetch((req.method === \"GET\" ? HOSTS[env] : ALT) + path,")), once);
  fails(withChange(F, (t) => t.replace("fetch(HOSTS[env] + path,", "fetch(HOSTS[other] + path,")), once);
  fails(withChange(F, (t) => t.replace("fetch(HOSTS[env] + path,", "fetch(HOSTS[env] + suffix + path,")), once);
  // and not frozen
  fails(withChange(F, (t) => t.replace('= Object.freeze(Platform.OS === "web"', '= (Platform.OS === "web"')), /HOSTS must be the pinned declaration/);
});

test("R2: the address is checked on the line before the send", () => {
  const P = "server/mfp_passthrough.mjs";
  const gate = /the address must be checked on the line before the send/;
  const GATE = '    if (!mfpUpstreamOk(route.upstream)) return refuse(400, "not an MFP address");\n';
  const lf = (t) => t.replace(/\r\n/g, "\n");
  fails(withChange(P, (t) => lf(t).replace(GATE, "")), gate);
  fails(withChange(P, (t) => lf(t).replace(GATE, GATE.replace("!mfpUpstreamOk(route.upstream)", "!mfpUpstreamOk(route.upstream) && false"))), gate);
  fails(withChange(P, (t) => lf(t).replace(GATE, GATE.replace("mfpUpstreamOk(route.upstream)", "mfpUpstreamOk(other)"))), gate);
  // something between the check and the send
  fails(withChange(P, (t) => lf(t).replace(GATE, GATE + "    route.upstream = req.headers.forward;\n")), gate);
  // the check must be mfp_route.mjs's own
  fails(withChange(P, (t) => lf(t).replace("import { mfpRoute, mfpUpstreamOk, mfpWriteBody, refusalBody }", "const mfpUpstreamOk = () => true;\nimport { mfpRoute, mfpWriteBody, refusalBody }")), /mfpUpstreamOk must be imported from \.\/mfp_route\.mjs/);
});

test("R3: an alias of the sender, a second effective redirect option or a second handler call fails", () => {
  const P = "server/mfp_passthrough.mjs", A = "server/app.mjs";
  const lf = (t) => t.replace(/\r\n/g, "\n");
  const named = /the sender is named \d+ times/;
  // the review's mutation: an alias, called again after a lost answer
  fails(withChange(P, (t) => lf(t).replace("    let upstream;\n", "    const retrySend = send;\n    let upstream;\n").replace("    } catch (e) {\n      const timedOut", '    } catch (e) {\n      await retrySend(route.upstream, { method: req.method, headers, body, redirect: "manual" });\n      const timedOut')), named);
  fails(withChange(P, (t) => lf(t).replace("    let upstream;\n", "    const again = send;\n    let upstream;\n")), named);
  fails(withChange(P, (t) => lf(t).replace("    let upstream;\n", "    const senders = [send, send];\n    let upstream;\n")), named);
  fails(withChange(P, (t) => lf(t).replace("    let upstream;\n", "    replay(send, route);\n    let upstream;\n")), named);
  fails(withChange(P, (t) => lf(t).replace("export function makeMfpHandler({ hosts, send = globalThis.fetch, log = null }) {", "export function makeMfpHandler({ hosts, send = globalThis.fetch, log = null }) {\n  const second = send;")), named);
  // the review's mutation: the last property of a name wins
  const opts = /must pass \{ redirect: "manual" \}/;
  fails(withChange(P, (t) => t.replace('redirect: "manual", ', 'redirect: "manual", redirect: "follow", ')), opts);
  fails(withChange(P, (t) => t.replace('redirect: "manual", ', 'redirect: "manual", ["redirect"]: "follow", ')), opts);
  fails(withChange(P, (t) => t.replace('redirect: "manual", ', 'redirect: "manual", "redirect": "follow", ')), opts);
  fails(withChange(P, (t) => t.replace('redirect: "manual", ', 'redirect: "manual", duplex: "half", ')), opts);
  fails(withChange(P, (t) => t.replace('redirect: "manual", ', "redirect: mode, ")), opts);
  // the review's mutation: the mounting site calls the handler twice
  const mount = /app\.mjs: the handler is named \d+ times and called \d+/;
  fails(withChange(A, (t) => t.replace("handleMfp(req, res).catch(", "handleMfp(req, res); handleMfp(req, res).catch(")), mount);
  fails(withChange(A, (t) => t.replace("handleMfp(req, res).catch(", "for (let i = 0; i < 2; i++) handleMfp(req, res).catch(")), mount);
  fails(withChange(A, (t) => t.replace("handleMfp(req, res).catch(", "[req, req].forEach((q) => handleMfp(q, res)); handleMfp(req, res).catch(")), mount);
  fails(withChange(A, (t) => t.replace("  const index = path.join(dist, \"index.html\");", '  const again = handleMfp;\n  const index = path.join(dist, "index.html");')), mount);
  // the same, one file over (a later review): a second mount in serve.mjs
  const S = "server/serve.mjs";
  const serve = /serve\.mjs: names the pass-through's handler \d+ times/;
  fails(withChange(S, (t) => t.replace("makeApp({ dist, handleMfp, handleMfpStream }).listen(", 'makeApp({ dist, handleMfp, handleMfpStream }).on("request", (req, res) => { if (String(req.url).startsWith("/mfp/")) handleMfp(req, res); }).listen(')), serve);
  fails(withChange(S, (t) => t.replace("makeApp({ dist, handleMfp, handleMfpStream }).listen(", 'makeApp({ dist, handleMfp, handleMfpStream }).on("request", handleMfp).listen(')), serve);
  fails(withChange(S, (t) => t.replace("makeApp({ dist, handleMfp, handleMfpStream }).listen(", "makeApp({ dist, handleMfp: (q, s) => { handleMfp(q, s); return handleMfp(q, s); } }).listen(")), serve);
  // a second handler, or a second app, under another name
  fails(withChange(S, (t) => t.replace("makeApp({ dist, handleMfp, handleMfpStream }).listen(", 'const other = makeMfpHandler({ hosts: ["x"] });\nmakeApp({ dist, handleMfp, handleMfpStream }).on("request", other).listen(')), /makeMfpHandler is named 3 times/);
  fails(withChange(S, (t) => t + "\nmakeApp({ dist, handleMfp, handleMfpStream }).listen(port + 1);\n"), /makeApp is named 3 times|names the pass-through's handler 3 times/);
  // any other file in server/ calling it
  fails(withChange("server/mfp_route.mjs", (t) => t + "\nexport const replay = (handleMfp, q, s) => handleMfp(q, s);\n"), /mfp_route\.mjs: names the pass-through's handler/);
  // and the rule does not go away with the file it reads
  const gone = new Map(clean);
  gone.delete(A);
  fails(check(gone).errors, /app\.mjs: missing/);
});

// ---- the boundary that executes ---------------------------------------------------------

test("the Hyperliquid send boundary refuses a forbidden or malformed action before it signs or sends", async () => {
  const hl = fakeHyperliquid();
  const w = makeWorld({ fetch: (url, init) => hl.fetch(url, init) });
  const ex = w.load("hl_exchange");
  const { currentSession } = w.load("session");
  const s = currentSession();
  const preview = (action) => ({ action, cloid: "0x0123456789abcdef0123456789abcdef", size: 1, px: 1, side: "buy", wire: {}, label: "" });
  for (const action of [
    { type: "usdSend", destination: FAKE_WALLET, amount: "1", time: 1 },
    { type: ["usd", "Send"].join(""), destination: FAKE_WALLET, amount: "1", time: 1 },   // a built type is just as refused
    { type: "withdraw3", destination: FAKE_WALLET, amount: "1", time: 1 },
    { type: "approveAgent", agentAddress: FAKE_WALLET },
    { type: "order", orders: [], grouping: "normalTpsl" },
    { type: "cancel", cancels: [{ a: 0, o: 1 }], extra: true },
    null,
  ]) {
    await assert.rejects(w.clock.settle(ex.sendOrder(s, FAKE_WALLET, TEST_KEY, preview(action))), /not permitted|unexpected keys|must be na|not an object|exactly one order/);
  }
  assert.equal(hl.sends.length, 0);
});

test("the MFP send boundary refuses a write no builder made", () => {
  const w = makeWorld();
  const { assertMfpWrite } = w.load("mfp_orders");
  for (const write of [
    { kind: "order", method: "POST", path: "/v1/accounts/acct_1/withdraw", body: {}, idempotencyKey: "tt-open-1-k" },
    { kind: "cancel", method: "DELETE", path: "/v1/orders", body: null, idempotencyKey: "tt-cancel-1-k" },
    { kind: "close", method: "POST", path: "/v1/positions/pos_1/close", body: {}, idempotencyKey: "" },
    null,
  ]) {
    assert.throws(() => assertMfpWrite(write));
  }
});

// ---- the MFP account stream: the independent review of 2026-11-26 (seven mutations that passed) ----

test("review: nothing but the three checked resume fields can reach the stream's address - no path, no key", () => {
  const F = "src/lib/mfp_stream.ts";
  const pinned = /query must be ONE const, resumeQuery\(core\)/;
  const call = /the transport must be chosen once, by \(Platform\.OS === "web" \? openRelayed : openDirect\)\(env, query, key, handlers\)/;
  // the review's: the one fetch re-aimed at a REST read through the pass-through (the browser normalises /../)
  fails(withChange(F, (t) => t.replace("const query = resumeQuery(core);", 'const query = "/../orders?account_id=" + accountId + "&status=working";')), pinned);
  fails(withChange(F, (t) => t.replace("const query = resumeQuery(core);", 'const query = resumeQuery(core) + "&k=" + key;')), pinned);
  fails(withChange(F, (t) => t.replace("const query = resumeQuery(core);", "let query = resumeQuery(core);")), pinned);
  fails(withChange(F, (t) => t.replace("const query = resumeQuery(core);", 'const query = resumeQuery(core);\n  const other = query + "/x";')), pinned);
  // the review's: the key placed in the address at the call site
  fails(withChange(F, (t) => t.replace("(env, query, key, handlers);", '(env, query + "?k=" + key, key, handlers);')), call);
  fails(withChange(F, (t) => t.replace("(env, query, key, handlers);", '(env, "/../orders", key, handlers);')), call);
  // inside a transport: the parameter re-pointed, or the key used a second time
  fails(withChange(F, (t) => t.replace("  const ctl = new AbortController();", '  query = "/../orders";\n  const ctl = new AbortController();')), pinned);
  fails(withChange(F, (t) => t.replace("  const ctl = new AbortController();", '  query += "&k=" + key;\n  const ctl = new AbortController();')), /query must be ONE const|openRelayed must name key exactly once/);
  fails(withChange(F, (t) => t.replace('Accept: "application/x-ndjson" }, signal: ctl.signal });', 'Accept: "application/x-ndjson", "X-Copy": key }, signal: ctl.signal });')), /its fetch headers must be exactly/);
  fails(withChange(F, (t) => t.replace('null, { headers: { Authorization: "Bearer " + key } });', 'null, { headers: { Authorization: "Bearer " + key, "X-Copy": key } });')), /its socket must be built as/);
  fails(withChange(F, (t) => t.replace('null, { headers: { Authorization: "Bearer " + key } });', '["k." + key], { headers: { Authorization: "Bearer " + key } });')), /its socket must be built as/);
});

test("review: a write that names neither banned word (a built property name) fails in both stream files", () => {
  const F = "src/lib/mfp_stream.ts", R = "server/mfp_stream_relay.mjs";
  // the review's two
  fails(withChange(F, (t) => t.replace("sock.onerror = () => undefined;", 'sock.onerror = () => undefined;\n  sock.onopen = () => { (sock as any)["se" + "nd"]("{}"); };')), /mfp_stream\.ts:\d+: indexes .* only RELAY\[env\] and DIRECT\[env\] may be indexed/);
  fails(withChange(R, (t) => t.replace("upstream.onerror = () => finish(1006);", 'upstream.onerror = () => finish(1006);\n    upstream.addEventListener("open", () => upstream["se" + "nd"]("{}"));')), /mfp_stream_relay\.mjs:\d+: indexes .* only its tables/);
  // their neighbours: a name held in a variable, a template, a method reached without naming it
  fails(withChange(F, (t) => t.replace("sock.onerror = () => undefined;", 'sock.onerror = () => undefined;\n  const m = ["s", "e", "n", "d"].join("");\n  (sock as any)[m]("{}");')), /only RELAY\[env\] and DIRECT\[env\] may be indexed/);
  fails(withChange(F, (t) => t.replace("sock.onerror = () => undefined;", "sock.onerror = () => undefined;\n  (sock as any)[`s${\"e\"}nd`](\"{}\");")), /only RELAY\[env\] and DIRECT\[env\] may be indexed/);
  fails(withChange(F, (t) => t.replace("sock.onerror = () => undefined;", 'sock.onerror = () => undefined;\n  Reflect.get(sock, "se" + "nd").call(sock, "{}");')), /names Reflect/);
  fails(withChange(R, (t) => t.replace("upstream.onerror = () => finish(1006);", 'upstream.onerror = () => finish(1006);\n    const m = "se" + "nd";\n    upstream[m]("{}");')), /mfp_stream_relay\.mjs:\d+: indexes .* only its tables/);
  fails(withChange(R, (t) => t.replace("upstream.onerror = () => finish(1006);", 'upstream.onerror = () => finish(1006);\n    Reflect.apply(Reflect.get(upstream, "se" + "nd"), upstream, ["{}"]);')), /names Reflect/);
  fails(withChange(R, (t) => t.replace("upstream.onerror = () => finish(1006);", 'upstream.onerror = () => finish(1006);\n    req.headers["x-" + "y"];')), /only its tables \(by a plain name\) and req\.headers \(by a string literal\)/);
});

test("review: the relay's socket gets the address that was checked and the key in one header, and the key is never logged", () => {
  const R = "server/mfp_stream_relay.mjs";
  const lf = (t) => t.replace(/\r\n/g, "\n");
  const route = /route must be ONE const, mfpStreamRoute\(req\.method, req\.url, authorization\)/;
  const socket = /the socket must be built as new Socket\(route\.upstream, \{ headers: \{ Authorization: authorization \} \}\)/;
  const auth = /authorization must be named only as its one declaration/;
  // the review's: the address re-pointed between its check and the socket, with a built string
  fails(withChange(R, (t) => lf(t).replace("running++;\n    let upstream = null;", 'running++;\n    route.upstream = ["ws", "s:/", "/example.invalid/"].join("");\n    let upstream = null;')), route);
  fails(withChange(R, (t) => lf(t).replace("running++;\n    let upstream = null;", 'running++;\n    Object.assign(route, { upstream: other });\n    let upstream = null;')), route);
  fails(withChange(R, (t) => lf(t).replace("const route = mfpStreamRoute(req.method, req.url, authorization);", "let route = mfpStreamRoute(req.method, req.url, authorization);")), route);
  fails(withChange(R, (t) => lf(t).replace("const route = mfpStreamRoute(req.method, req.url, authorization);", 'const route = mfpStreamRoute(req.method, "/mfp/live/v1/stream", authorization);')), route);
  // the review's: the key handed to a second header
  fails(withChange(R, (t) => t.replace("{ headers: { Authorization: authorization } }", '{ headers: { Authorization: authorization, "X-Copy": authorization } }')), socket);
  fails(withChange(R, (t) => t.replace("{ headers: { Authorization: authorization } }", "{ headers: { Authorization: authorization }, protocols: [authorization] }")), socket);
  // the review's: the key in a log line
  fails(withChange(R, (t) => t.replace('say("200");', 'say("200 " + authorization);')), auth);
  fails(withChange(R, (t) => t.replace('say("200");', 'say("200 " + req.headers.authorization);')), auth);
  fails(withChange(R, (t) => t.replace('say("200");', 'say("200 " + JSON.stringify(req.headers));')), /req\.headers is read whole/);
  fails(withChange(R, (t) => t.replace('say("200");', 'say("200 " + req.url);')), /req\.url is read 3 times/);
  fails(withChange(R, (t) => lf(t).replace("    const authorization = req.headers.authorization;", "    const authorization = req.headers.authorization;\n    const copy = authorization;")), auth);
});
