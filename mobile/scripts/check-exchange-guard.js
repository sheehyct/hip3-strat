"use strict";
// Static guard for the exchange surface (the rules in SECURITY.md).
// Fails when:
// - the exchange URL or signL1Action( appears outside src/lib/hl_exchange.ts
// - expo-secure-store is imported outside src/lib/agent_store.ts
// - src/lib/hl_orders.ts names an action type other than order / cancel
// - an opening wire (the literal `r: false`) is written outside hl_orders.ts,
//   or buildReverseOpenOrder is referenced outside hl_orders.ts /
//   hl_exchange.ts (the reverse's second leg has exactly one builder and
//   one caller)
// - hl_sign.ts / hl_orders.ts import react-native, expo-*, @react-native-* or @/
//   (they must stay node-loadable and storage-free)
// - a console.log / console.warn line in src/ mentions "key" or "priv"
//   (cheap tripwire against logging a secret)
// MyFundedPerps. Fails when:
// - the MFP host appears outside src/lib/mfp_exchange.ts
// - a falsy reduce_only property or assignment (an opening wire) is written
//   outside src/lib/mfp_orders.ts, which must write `reduce_only: false`
//   exactly twice (the OpenWire type + buildMfpReverseOpen)
// - buildMfpReverseOpen is referenced outside mfp_orders.ts / mfp_exchange.ts
// - src/ names a banned MFP endpoint (cancel-all, close-all, exit-orders,
//   attached-exits, isolated-margin, TWAP, scaled, copy trading, CLI auth)
// - mfp_exchange.ts uses an HTTP method other than GET / POST
// - mfp_orders.ts imports anything, or names an order type other than market
// - src/ names an MFP resource other than /v1/accounts, /v1/positions,
//   /v1/orders, /v1/markets (the read list), or the
//   closed-position read (status=closed) appears outside mfp_exchange.ts
// The MFP account stream. Fails when:
// - the stream host, a wss:// URL for it, or the paths /v1/stream and
//   /v1/sandbox/stream appear outside src/lib/mfp_stream.ts (the REST host
//   stays in mfp_exchange.ts only)
// - a code line names WebSocket anywhere but hl_stream.ts / mfp_stream.ts
// - mfp_stream.ts names send or ping at all (it is receive-only), names an
//   HTTP client (fetch, XMLHttpRequest), reads a key slot other than
//   "view", names the trade slot, imports anything from agent_store but
//   getMfpKey, or holds more than one socket URL
// - mfp_stream_core.ts, mfp_rate.ts or read_gate.ts imports anything (they
//   stay node-loadable) or names a host or a path
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "src");
const errors = [];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(src, []);
const rel = (p) => path.relative(root, p).replace(/\\/g, "/");

for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const r = rel(f);
  const lines = text.split(/\r?\n/);
  const isExchange = r === "src/lib/hl_exchange.ts";
  const isSign = r === "src/lib/hl_sign.ts";
  const isOrders = r === "src/lib/hl_orders.ts";
  const isAgentStore = r === "src/lib/agent_store.ts";
  lines.forEach((line, i) => {
    const where = r + ":" + (i + 1);
    // The host may appear only in the info client and the exchange client; a
    // split URL ("https://api.hyperliquid.xyz" + "/exchange") still trips the
    // host check, and the info client may never mention the exchange path.
    const isInfo = r === "src/lib/hyperliquid.ts";
    if (!isExchange && !isSign && !isInfo && line.includes("hyperliquid.xyz")) errors.push(where + ": hyperliquid host outside hyperliquid.ts / hl_exchange.ts");
    if (isInfo && line.includes("/exchange")) errors.push(where + ": the info client must not reference the exchange path");
    // The bare identifier, not just a call: an aliased import
    // (`signL1Action as sign`) is caught on its import line.
    if (!isExchange && !isSign && /\bsignL1Action\b/.test(line)) errors.push(where + ": signL1Action referenced outside hl_exchange.ts");
    if (!isAgentStore && /from\s+["']expo-secure-store["']/.test(line)) errors.push(where + ": expo-secure-store imported outside agent_store.ts");
    // Any spelling of a falsy reduce-only flag as a PROPERTY: r: false,
    // "r": false, 'r':false, ["r"]: false, r: !1, r: 0, r: Boolean(...), or an
    // assignment to one (x.r = false, x["r"] = 0). A plain `let r = 0` is
    // not a wire and does not trip it. (The runtime guard is the real lock:
    // it accepts only buildReverseOpenOrder's frozen output.)
    const FALSY = "(false\\b|!|0\\b|Boolean\\s*\\()";
    const asProp = new RegExp("(^|[^\\w$.])\\[?[\"']?r[\"']?\\]?\\s*:\\s*" + FALSY);
    const asAssign = new RegExp("(\\.r|\\[[\"']r[\"']\\])\\s*=(?!=)\\s*" + FALSY);
    if (!isOrders && (asProp.test(line) || asAssign.test(line))) errors.push(where + ": an opening order wire (a falsy r) written outside hl_orders.ts");
    if (!isOrders && !isExchange && /\bbuildReverseOpenOrder\b/.test(line)) errors.push(where + ": buildReverseOpenOrder referenced outside hl_orders.ts / hl_exchange.ts");
    if ((isSign || isOrders) && /from\s+["'](react-native|expo-|@react-native-|@\/)/.test(line)) errors.push(where + ": pure module imports a platform package");
    if (/console\.(log|warn|error)\(/.test(line) && /key|priv/i.test(line)) errors.push(where + ": console output mentions a key");
    // The Hyperliquid WebSocket also accepts signed actions ({"method":
    // "post", "request": {"type": "action"}}): only hl_stream.ts may hold the
    // socket URL, and it may send nothing but subscribe / unsubscribe / ping.
    const isStream = r === "src/lib/hl_stream.ts";
    if (!isStream && !isInfo && /\bHL_WS_URL\b/.test(line)) errors.push(where + ": HL_WS_URL used outside hl_stream.ts");
    const isMfpStream = r === "src/lib/mfp_stream.ts";
    if (!isStream && !isInfo && !isExchange && !isSign && !isMfpStream && /wss:\/\//.test(line)) errors.push(where + ": a WebSocket URL outside hl_stream.ts / hyperliquid.ts / mfp_stream.ts");
    // A socket is opened in two files only: no other CODE line may name
    // WebSocket at all (so no alias, no globalThis.WebSocket). A comment
    // line may.
    const isComment = /^\s*(\/\/|\/?\*)/.test(line);
    if (!isStream && !isMfpStream && !isComment && /\bWebSocket\b/.test(line)) errors.push(where + ": WebSocket named outside hl_stream.ts / mfp_stream.ts");
    // The MFP account stream is receive-only and view-key-only: the words
    // themselves are banned in its file, comments included, so no spelling
    // of a call (send?.(, .send.call(, a destructured send, ws.ping()) and
    // no second way out (an HTTP client) can pass.
    if (isMfpStream && /\b(send|ping)\b/.test(line)) errors.push(where + ": mfp_stream.ts may not send (the account stream is receive-only)");
    if (isMfpStream && /\bfetch\b|XMLHttpRequest|\baxios\b/.test(line)) errors.push(where + ": mfp_stream.ts names an HTTP client");
    if (isMfpStream && /from\s+["']\.\/agent_store["']/.test(line) && !/^import\s+\{\s*getMfpKey\s*\}\s+from/.test(line)) errors.push(where + ": mfp_stream.ts may import only getMfpKey from agent_store");
    if (isMfpStream && /getMfpKey\s*\((?!\s*"view"\s*\))/.test(line)) errors.push(where + ": mfp_stream.ts may read the view key only");
    if (isMfpStream && /["'`]trade["'`]/.test(line)) errors.push(where + ": mfp_stream.ts names the trade key slot");
    // The key and the socket's address are pinned to their exact lines: the
    // key may be named only where it is read, checked and placed in the
    // upgrade's Authorization header (so never in a URL or anywhere else),
    // the address is the pinned origin + path + the checked resume query,
    // and no property may be reached by a built name (sock["se" + "nd"]).
    if (isMfpStream && /\bviewKey\b/.test(line) && ![
      /^getMfpKey\("view"(, c\.profile)?\)\.then\(\(viewKey\) => \{$/,
      /^const env = viewKey \? mfpEnvForKey\(viewKey\) : null;$/,
      /^if \(!viewKey \|\| !env\) \{ setStatus\(c, "off"\); return; \}$/,
      /^sock = new Ctor\(STREAM_ORIGIN \+ STREAM_PATH\[env\] \+ resume, null, \{ headers: \{ Authorization: "Bearer " \+ viewKey \} \}\);$/,
    ].some((re) => re.test(line.trim()))) errors.push(where + ": mfp_stream.ts names the key outside its pinned lines");
    if (isMfpStream && /\bnew\s+Ctor\b/.test(line) && !/^sock = new Ctor\(STREAM_ORIGIN \+ STREAM_PATH\[env\] \+ resume, null, \{ headers: \{ Authorization: "Bearer " \+ viewKey \} \}\);$/.test(line.trim())) errors.push(where + ": mfp_stream.ts builds its socket from something other than the pinned address and header");
    if (isMfpStream && /\bresume\s*=/.test(line) && !/^const resume = mfpResumeQuery\(c\.cursor, c\.heardAt > 0 \? Date\.now\(\) - c\.heardAt : 0\);$/.test(line.trim())) errors.push(where + ": mfp_stream.ts sets the resume query from something other than mfpResumeQuery");
    if (isMfpStream && !isComment && /\[[^\]\n]*["'`+][^\]\n]*\]/.test(line)) errors.push(where + ": mfp_stream.ts reaches a property by a built or quoted name");
    if (isMfpStream && /\bAuthorization\b/.test(line) && !/\bnew\s+Ctor\b/.test(line) && !isComment) errors.push(where + ": mfp_stream.ts names the Authorization header outside the socket line");
    if (isStream && /["'`](post|action|order|cancel)["'`]/.test(line)) errors.push(where + ": hl_stream.ts may only subscribe / unsubscribe / ping");
    if (isStream && /method\s*:?\s*["'`](?!subscribe|unsubscribe|ping)\w+/.test(line)) errors.push(where + ": hl_stream.ts names a socket method other than subscribe / unsubscribe / ping");

    // MyFundedPerps: one file holding the host, one opening-wire writer, banned
    // routes.
    const isMfpExchange = r === "src/lib/mfp_exchange.ts";
    const isMfpOrders = r === "src/lib/mfp_orders.ts";
    // "perpetuals", not the full host: a split string ("...myfunded" +
    // "perpetuals.com") still trips it. UI copy says "MyFundedPerps".
    if (!isMfpExchange && !isMfpStream && /perpetuals/i.test(line)) errors.push(where + ": MFP host (or a piece of it) outside mfp_exchange.ts / mfp_stream.ts");
    // Each file keeps to its own host: REST in the client, the stream host
    // in the stream.
    if (isMfpExchange && /account-stream/i.test(line)) errors.push(where + ": the stream host inside mfp_exchange.ts");
    if (isMfpStream && /(developers|sandbox)\.my/i.test(line)) errors.push(where + ": the REST host inside mfp_stream.ts");
    const mfpProp = new RegExp("(^|[^\\w$.])\\[?[\"']?reduce_only[\"']?\\]?\\s*:\\s*" + FALSY);
    const mfpAssign = new RegExp("(\\.reduce_only|\\[[\"']reduce_only[\"']\\])\\s*=(?!=)\\s*" + FALSY);
    if (!isMfpOrders && (mfpProp.test(line) || mfpAssign.test(line))) errors.push(where + ": an MFP opening wire (a falsy reduce_only) written outside mfp_orders.ts");
    if (!isMfpOrders && !isMfpExchange && /\bbuildMfpReverseOpen\b/.test(line)) errors.push(where + ": buildMfpReverseOpen referenced outside mfp_orders.ts / mfp_exchange.ts");
    const banned = line.match(/(cancel-all-orders|close-all-positions|exit-orders|attached-exits|isolated-margin|twap-orders|scaled-orders|copy-trading|acknowledge-copy-stop|\/v1\/auth\/)/);
    if (banned) errors.push(where + ": banned MFP endpoint " + banned[1]);
    for (const hit of line.match(/\/v1\/[a-z][a-z-]*/g) || []) {
      const res = hit.slice("/v1/".length);
      // The stream's two paths (/v1/stream, /v1/sandbox/stream) exist in
      // mfp_stream.ts only, and that file names no REST resource.
      const allowed = isMfpStream ? ["stream", "sandbox"] : ["accounts", "positions", "orders", "markets"];
      if (!allowed.includes(res)) errors.push(where + ": MFP resource /v1/" + res + (isMfpStream ? " inside mfp_stream.ts" : " is not on the SECURITY.md read list"));
    }
    if (!isMfpExchange && /status=closed/.test(line)) errors.push(where + ": the closed-position read (status=closed) outside mfp_exchange.ts");
    if (isMfpExchange && /method\s*:\s*["'`](DELETE|PATCH|PUT)/i.test(line)) errors.push(where + ": mfp_exchange.ts may only GET or POST");
    if (isMfpOrders) {
      const m = line.match(/type:\s*"([A-Za-z0-9_]+)"/g) || [];
      for (const hit of m) {
        const t = hit.replace(/type:\s*"/, "").replace(/"$/, "");
        if (t !== "market") errors.push(where + ": mfp_orders.ts names order type " + t);
      }
    }
    if (isOrders) {
      const m = line.match(/type:\s*"([A-Za-z0-9_]+)"/g) || [];
      for (const hit of m) {
        const t = hit.replace(/type:\s*"/, "").replace(/"$/, "");
        if (t !== "order" && t !== "cancel") errors.push(where + ": hl_orders.ts names action type " + t);
      }
    }
  });
}

// The hl_sign module must not depend on anything but noble + msgpack.
const signText = fs.readFileSync(path.join(src, "lib", "hl_sign.ts"), "utf8");
for (const m of signText.matchAll(/from\s+["']([^"']+)["']/g)) {
  const dep = m[1];
  if (!/^@noble\/(curves|hashes)\//.test(dep) && dep !== "@msgpack/msgpack") errors.push("src/lib/hl_sign.ts imports " + dep);
}
const ordersText = fs.readFileSync(path.join(src, "lib", "hl_orders.ts"), "utf8");
if (/^\s*import\s/m.test(ordersText)) errors.push("src/lib/hl_orders.ts must stay import-free");
// Inside hl_orders.ts the opening literal appears exactly twice: the OpenWire
// type and the one wire buildReverseOpenOrder builds.
const openLiterals = (ordersText.match(/\br\s*:\s*false\b/g) || []).length;
if (openLiterals !== 2) errors.push("src/lib/hl_orders.ts must write `r: false` exactly twice (OpenWire type + buildReverseOpenOrder), found " + openLiterals);

// MFP client: exactly one fetch (inside call()), and call() asserts every
// POST as a builder-made write - so no raw body can be posted from this file
// without either a second fetch or removing the assert, both of which fail here.
const mfpExchangePath = path.join(src, "lib", "mfp_exchange.ts");
if (fs.existsSync(mfpExchangePath)) {
  const exText = fs.readFileSync(mfpExchangePath, "utf8");
  const fetches = (exText.match(/\bfetch\s*\(/g) || []).length;
  if (fetches !== 1) errors.push("src/lib/mfp_exchange.ts must call fetch exactly once (in call()), found " + fetches);
  if (!/assertMfpWrite\(req\.write\)/.test(exText)) errors.push("src/lib/mfp_exchange.ts: call() must assert every POST (assertMfpWrite(req.write))");
}

// MFP pure module: import-free, and its opening literal appears exactly twice
// (the OpenWire type + buildMfpReverseOpen). Checked once the file exists.
const mfpOrdersPath = path.join(src, "lib", "mfp_orders.ts");
if (fs.existsSync(mfpOrdersPath)) {
  const mfpText = fs.readFileSync(mfpOrdersPath, "utf8");
  if (/^\s*import\s/m.test(mfpText)) errors.push("src/lib/mfp_orders.ts must stay import-free");
  const mfpOpen = (mfpText.match(/\breduce_only\s*:\s*false\b/g) || []).length;
  if (mfpOpen !== 2) errors.push("src/lib/mfp_orders.ts must write `reduce_only: false` exactly twice (OpenWire type + buildMfpReverseOpen), found " + mfpOpen);
}

// MFP account stream: one socket URL, and the two pure modules beside it
// import nothing and name no host or path.
const mfpStreamPath = path.join(src, "lib", "mfp_stream.ts");
if (fs.existsSync(mfpStreamPath)) {
  const stText = fs.readFileSync(mfpStreamPath, "utf8");
  const urls = (stText.match(/wss:\/\//g) || []).length;
  if (urls !== 1) errors.push("src/lib/mfp_stream.ts must hold exactly one socket URL, found " + urls);
  const sockets = (stText.match(/\bnew\s+\w+\s*\(/g) || []).filter((m) => !/new\s+(Set|Map|Error)\b/.test(m)).length;
  if (sockets !== 1) errors.push("src/lib/mfp_stream.ts must construct exactly one socket, found " + sockets);
}
for (const pure of ["mfp_stream_core.ts", "mfp_rate.ts", "read_gate.ts"]) {
  const pp = path.join(src, "lib", pure);
  if (!fs.existsSync(pp)) continue;
  const text = fs.readFileSync(pp, "utf8");
  if (/^\s*import\s/m.test(text)) errors.push("src/lib/" + pure + " must stay import-free");
  if (/wss?:\/\/|https?:\/\/|\/v1\//.test(text)) errors.push("src/lib/" + pure + " names a host or a path");
}

// MFP account stream: exactly one socket line and one resume line (each is
// pinned to its exact text above; here, that neither was simply removed).
{
  const p = path.join(src, "lib", "mfp_stream.ts");
  if (fs.existsSync(p)) {
    const t = fs.readFileSync(p, "utf8");
    const socketLines = (t.match(/\bnew\s+Ctor\b/g) || []).length;
    const resumeLines = (t.match(/\bresume\s*=/g) || []).length;
    if (socketLines !== 1) errors.push("src/lib/mfp_stream.ts must build its socket exactly once, found " + socketLines);
    if (resumeLines !== 1) errors.push("src/lib/mfp_stream.ts must set the resume query exactly once, found " + resumeLines);
  }
}

if (errors.length) {
  console.error("exchange guard FAILED:");
  for (const e of errors) console.error("- " + e);
  process.exit(1);
}
console.log("exchange guard OK: " + files.length + " source files scanned");
