"use strict";
// Static guard for the venue write surface (docs/CONTRACT.md "Allowed venue
// writes" and "Keys and privacy"): order / cancel / modify / updateLeverage
// on Hyperliquid; create / modify / cancel / close / exit-orders on MFP;
// nothing else. Fails when:
//
// Hyperliquid
// - the hyperliquid host appears outside hyperliquid.ts / hl_exchange.ts /
//   hl_stream.ts, or the info client references the exchange path
// - signL1Action is referenced outside hl_exchange.ts / hl_sign.ts
// - hl_exchange.ts calls fetch other than exactly once (postExchange)
// - hl_orders.ts names an action type other than order / cancel / modify /
//   updateLeverage, or imports anything
// - hl_sign.ts imports anything but noble + msgpack
// - any file in src/ names a forbidden action (usdSend, spotSend,
//   usdClassTransfer, vaultTransfer, approveAgent, approveBuilderFee,
//   withdraw3, twapOrder, batchModify, scheduleCancel, createSubAccount,
//   subAccountTransfer, updateIsolatedMargin, ...) or a grouping other
//   than "na"
// - the WebSocket URL is used outside hl_stream.ts / hyperliquid.ts, or
//   hl_stream.ts sends anything but subscribe / unsubscribe / ping
//
// MyFundedPerps
// - the MFP host (any piece of "perpetuals") appears outside
//   mfp_exchange.ts / mfp_market_list.ts
// - mfp_exchange.ts calls fetch other than exactly once (call()), or call()
//   does not assert every write (assertMfpWrite(req.write))
// - mfp_orders.ts imports anything, or names an order type other than
//   market / limit
// - src/ names a banned MFP endpoint (cancel-all, close-all, attached-exits,
//   isolated-margin, twap, scaled, chase, copy trading, price alerts, CLI
//   auth) or a /v1/ resource outside accounts / positions / orders /
//   markets / fills; exit-orders may appear only in mfp_orders.ts /
//   mfp_exchange.ts
// - mfp_market_list.ts does anything but ONE keyless GET of ONE URL
// - the hosts are anything but the pinned declarations: HOSTS in
//   mfp_exchange.ts and LIST_URL in mfp_market_list.ts each choose, by
//   Platform.OS === "web" and nothing else, between the app's own origin
//   (/mfp/<env>, the pass-through in server/) and MFP's two API hosts;
//   HOSTS is frozen and named once more only, as the fetch's address
//   (HOSTS[env] + path): no assignment to it, no alias of it
//
// The pass-through (server/, docs/CONTRACT.md "The MFP pass-through")
// - mfp_route.mjs names a URL other than MFP's two API hosts, declares
//   MFP_UPSTREAM as anything but the pinned frozen pair (a host built by
//   joining strings is another host), or mfp_passthrough.mjs names any URL
// - server/ names fetch other than once (the default sender in
//   mfp_passthrough.mjs), calls the sender other than once, or makes a
//   client request through node:http
// - the one send (read from the syntax tree) is not a direct statement of
//   handleMfp on route.upstream, sits inside a loop, a catch clause or a
//   nested function, or handleMfp calls itself (one request out per request
//   in: never a retry, never a redirect); the sender is named anywhere but
//   its parameter and that one call (an alias is a second sender); the
//   send's options are anything but method, headers, body,
//   redirect: "manual" and signal, each once (a second redirect would win);
//   the address is not checked (mfpUpstreamOk) on the line before the send
// - app.mjs, which mounts the handler, is missing, names the handler other
//   than once as its parameter and once as the call, or calls it inside a
//   loop; any other server/ file calls it; serve.mjs makes the handler or
//   the app other than once (a second mount sends every write twice)
// - server/ names a CORS response header (same origin only), or imports
//   anything but node:fs / http / path / url and its own files
//
// The MFP account stream (docs/CONTRACT.md "The MFP account stream")
// - the stream host (any "account-stream"), a wss:// address for it, or the
//   stream paths (/v1/stream, /v1/sandbox/stream) appear in src/ outside
//   mfp_stream.ts, or in server/ outside mfp_stream_relay.mjs
// - mfp_stream.ts holds the word "send" or "ping" ANYWHERE, comments
//   included (the stream is receive-only: no frame and no keep-alive is
//   ever written; a word ban cannot be talked around by send?.(), a
//   destructured send or .send.call)
// - mfp_stream.ts declares RELAY as anything but the pinned frozen pair of
//   RELATIVE paths (/mfp/<env>/v1/stream: its one HTTP call cannot leave the
//   app's own origin) or DIRECT as anything but the pinned frozen pair of
//   stream addresses; names any other address, or the MFP host anywhere but
//   inside those two (the file is exempt from the host rule above, so it
//   must not become a second way to the REST host); names RELAY other than
//   as its one fetch's address (RELAY[env] + query) or DIRECT other than as
//   its one socket's (DIRECT[env] + query); gives the fetch anything but
//   method "GET", headers and signal (no body); builds a WebSocket other
//   than once, or names WebSocket other than as that constructor; picks the
//   transport by anything but Platform.OS === "web"; or imports anything
//   but react-native, ./mfp_orders and ./mfp_stream_core (so it cannot
//   reach the key store or the REST client)
// - (from an independent review) the address's one variable part, `query`, is
//   anything but ONE const whose value is resumeQuery(core), is assigned to,
//   or is used other than as the fetch's and the socket's address and the
//   one transport call, whose arguments are exactly (env, query, key,
//   handlers): so no path ("/../orders?...") and no key can be put in the
//   address. The fetch's headers and the socket's options are pinned whole,
//   and each transport names `key` once, in its Authorization header
// - either stream file indexes anything by a built name: mfp_stream.ts may
//   index RELAY[env] and DIRECT[env] only; the relay its five tables by a
//   plain name and req.headers by a string literal (sock["se" + "nd"] is a
//   write that names neither banned word); or names Reflect
// - the relay assigns to `route`, or names it other than to read a property
//   of it; builds its socket as anything but the whole text
//   new Socket(route.upstream, { headers: { Authorization: authorization } });
//   names `authorization` other than its one declaration (from
//   req.headers.authorization), the route decision and that header - never
//   in a log line; reads req.headers bare; or reads req.url other than for
//   the logged path and the route decision
//
// What the word ban and these pins do NOT cover (a static check cannot): a
// write reached through an alias of the socket handed to code outside these
// two files, or built without an index or a named method inside a
// dependency. The stream files import nothing that could do that.
// - any line of code in src/ names WebSocket outside hl_stream.ts /
//   mfp_stream.ts (an alias, globalThis.WebSocket, a string key)
// - mfp_stream_core.ts imports anything (it is pure)
// - mfp_stream_relay.mjs holds the word "send" or "ping" anywhere, declares
//   MFP_STREAM_UPSTREAM as anything but the pinned frozen pair, names any
//   other address, builds its upstream socket other than ONCE - a direct
//   statement of handleMfpStream on route.upstream, outside any loop or
//   catch, after the address check (mfpStreamUpstreamOk) - or names
//   WebSocket other than as that socket class's default; any other server/
//   file names WebSocket, the stream host or a stream path
// - app.mjs calls the relay's handler other than once, or inside a loop;
//   serve.mjs makes the relay other than once
//
// Structure, read from the TypeScript syntax tree (two external reviews
// showed why: a lexical scan could be talked around by a computed
// global key, a template interpolation, a regex literal that confused the
// scanner, or an assertion inside dead control flow; a parser cannot)
// - every executable reference to fetch is counted: a bare identifier, a
//   property name (globalThis.fetch, window.fetch, x.fetch, { fetch }), and
//   an element access with a literal key (self["fetch"]), wherever it sits
//   (template interpolations, default parameters, closures). Only ONE such
//   reference may exist in each of hyperliquid.ts (fetch(API, ...)),
//   hl_exchange.ts (fetch(EXCHANGE_URL, ...)), mfp_exchange.ts
//   (fetch(HOSTS[env] + path, ...)) and mfp_market_list.ts
//   (fetch(LIST_URL, ...)), as a direct call; none anywhere else in src/
// - the same for the other transports (XMLHttpRequest, sendBeacon,
//   EventSource, and WebSocket outside hl_stream.ts)
// - a global object (globalThis / window / self / global, bare or as a
//   property such as globalThis.window) may only be read through a
//   written-out property name, a literal element key, or typeof: aliasing
//   it, passing it, casting it or indexing it with a computed key fails
// - eval, Function (so also new Function), a .constructor access, dynamic
//   import(), require() of anything but one string literal, a timer given
//   a string to evaluate, and an import of an HTTP / socket client package
//   all fail anywhere in src/
// - a src/ file that does not parse fails
// - postExchange's first two statements are assertScopedAction(action); and
//   assertSession(s); - top-level expression statements, so no if / try /
//   loop / && / early return can skip them - and its one signL1Action call
//   and its one fetch sit inside postExchange (not in a closure or a
//   default parameter), after them. Neither s nor action is assigned to
//   (or has a property assigned) in postExchange.
// - MFP's call() holds exactly one top-level if (req.method === "WRITE")
//   whose first two statements are assertMfpWrite(req.write); and
//   if (!sessionLive(req.session)) return ...; the one fetch sits in call()
//   after that if; req is never assigned to; method is only ever
//   req.write.method (after the assertions) or "GET", and fetch sends it
// - assertScopedAction, assertSession, signL1Action, assertMfpWrite and
//   sessionLive are each declared once in their client file, as a value
//   import from the module that defines them (no local stand-in, no
//   shadowing parameter)
// - EXCHANGE_URL and API are const declarations of the literal URL; HOSTS
//   and LIST_URL are const declarations of the exact pinned expression
// - hl_orders.ts gives `type:` anything but one of the four permitted string
//   literals (a built or computed action type), or builds strings by joining
//
// Still lexical, on purpose (they scan for names and endpoints inside
// strings, which is where they live): the forbidden action names, banned
// endpoints, /v1/ resources, hosts, grouping, hl_stream methods, the
// console-line key check, web storage, the pure-module import rules and the
// hex / key-shaped string scan.
//
// What this does NOT enforce (it is a static check of source text): a fetch
// reached through an object the scan cannot name (document.defaultView, an
// iframe's contentWindow, a value handed in from outside src/), an alias of
// an action or request object mutated through another name after its
// assertion, or anything done by a dependency in node_modules. The
// boundary that holds whatever the source says is the runtime assertion the
// exchange clients execute (assertScopedAction / assertMfpWrite); this
// guard pins that those assertions are on the path and cannot be skipped.
//
// Keys
// - expo-secure-store is imported outside agent_store.ts
// - localStorage / sessionStorage / indexedDB / document.cookie are touched
//   directly anywhere in src/ (a trade key must never persist on web; the
//   wallet address goes through AsyncStorage)
// - a console.log / warn / error line mentions "key" or "priv"
// - a 40-hex address or 64-hex private key appears in src/, test/ or docs/
//   other than the SDK's published test vector and obviously fake patterns
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|md|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(root, p).replace(/\\/g, "/");

// Every file the guard reads (src/, server/, test/, docs/), by repo-relative path.
// check() works on this map alone, so a test can hand it a changed copy.
function loadTree() {
  const tree = new Map();
  for (const dir of ["src", "server", "test", "docs"]) {
    for (const p of walk(path.join(root, dir), [])) tree.set(rel(p), fs.readFileSync(p, "utf8"));
  }
  return tree;
}

// The same text with comments blanked out (line breaks kept, so positions
// still point at the right line). Strings and template literals are left
// alone: "https://..." is not a comment. With `strings` the contents of
// string literals are blanked too.
//
// A regex literal is copied through whole when it can be recognised. This
// is a scanner for the remaining lexical tripwires (hl_orders.ts action
// types), whose failure mode is to keep MORE text, never less; nothing that
// asks "is this executable statement there" or "is fetch named" uses it any
// more - those questions go to the syntax tree below.
function stripComments(text, strings = false) {
  let out = "";
  let i = 0;
  let quote = null;
  let last = "";   // the last character of code that was not white space
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (quote) {
      if (c === "\\") { out += strings ? "  " : c + (d ?? ""); i += 2; continue; }
      if (c === quote) { quote = null; out += c; last = c; i++; continue; }
      out += strings && c !== "\n" ? " " : c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && d === "/") { while (i < text.length && text[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") {
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
      continue;
    }
    if (c === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last))) {
      // a regex literal: up to its closing slash on this line
      let j = i + 1, cls = false;
      while (j < text.length && text[j] !== "\n" && (cls || text[j] !== "/")) {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") cls = true;
        else if (text[j] === "]") cls = false;
        j++;
      }
      if (text[j] === "/") { out += text.slice(i, j + 1); last = "/"; i = j + 1; continue; }
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return out;
}

// ---- the syntax tree ----------------------------------------------------------------------

// Parsed source files, by path and text: the in-memory test suite hands
// check() many trees that differ in one file, so the rest are parsed once.
const astCache = new Map();
function parse(r, text) {
  const k = r + "\0" + text;
  let sf = astCache.get(k);
  if (!sf) {
    const kind = r.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(js|mjs)$/.test(r) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    sf = ts.createSourceFile(r, text, ts.ScriptTarget.Latest, true, kind);
    if (astCache.size > 2000) astCache.clear();
    astCache.set(k, sf);
  }
  return sf;
}
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

// Pre-order walk over every node that can execute. Type annotations,
// interfaces and type aliases carry no code (typeof window.open in a type
// position is not a read of window) and are skipped.
function visit(node, fn) {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
  if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
  fn(node);
  ts.forEachChild(node, (c) => visit(c, fn));
}

// The identifier is the name a declaration introduces.
function isDeclName(id) {
  const p = id.parent;
  if (!p || p.name !== id) return false;
  return ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)
    || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isBindingElement(p) || ts.isImportSpecifier(p)
    || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p) || ts.isEnumDeclaration(p)
    || ts.isModuleDeclaration(p);
}
// The identifier is a property's name (obj.NAME, { NAME: v }, class member NAME).
function isPropName(id) {
  const p = id.parent;
  if (!p || p.name !== id) return false;
  return ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)
    || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
    || ts.isEnumMember(p) || ts.isJsxAttribute(p);
}
// The identifier reads a binding (it is not a declaration, a property name,
// an import / export specifier's name or a label).
function isValueRef(id) {
  const p = id.parent;
  if (isDeclName(id) || isPropName(id)) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}
const isLiteralKey = (e) => !!e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e));
const isStringish = (e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken);

const GLOBALS = new Set(["globalThis", "window", "self", "global"]);
const TRANSPORTS = ["XMLHttpRequest", "sendBeacon", "EventSource"];
const NET_PACKAGES = /^(axios|ky|got|node-fetch|cross-fetch|isomorphic-fetch|whatwg-fetch|superagent|undici|ws|socket\.io-client|ccxt|@nktkas\/hyperliquid|hyperliquid|expo\/fetch)(\/|$)/;

// Every name a file reads, and every construct it may not use at all.
// refs: { name, node, line } for each identifier (in any position: obj.fetch
// counts as much as fetch) and each literal element key (x["fetch"]).
function scanSource(r, sf) {
  const refs = [];
  const problems = [];
  const bad = (node, what) => problems.push(r + ":" + lineOf(sf, node) + ": " + what);
  visit(sf, (n) => {
    if (ts.isIdentifier(n)) {
      refs.push({ name: n.text, node: n, line: lineOf(sf, n) });
      if (n.text === "eval" || n.text === "Function") bad(n, "names " + n.text + " - code built from strings is not allowed in src/");
      if (n.text === "constructor") bad(n, "reads .constructor - a way to reach Function without naming it");
      if (n.text === "require" && isValueRef(n)) {
        const p = n.parent;
        const ok = ts.isCallExpression(p) && p.expression === n && p.arguments.length === 1 && ts.isStringLiteral(p.arguments[0]);
        if (!ok) bad(n, "require is only allowed as require(\"one literal path\")");
      }
    }
    // A global object, bare (window) or as a property (globalThis.window).
    const globalRef = (ts.isIdentifier(n) && GLOBALS.has(n.text) && isValueRef(n))
      || (ts.isPropertyAccessExpression(n) && GLOBALS.has(n.name.text));
    if (globalRef) {
      const p = n.parent;
      const ok = (ts.isPropertyAccessExpression(p) && p.expression === n)
        || (ts.isElementAccessExpression(p) && p.expression === n && isLiteralKey(p.argumentExpression))
        || ts.isTypeOfExpression(p);
      if (!ok) bad(n, "uses a global object (" + n.getText(sf) + ") other than by a written-out property name - no alias, no cast, no computed key");
    }
    if (ts.isElementAccessExpression(n) && isLiteralKey(n.argumentExpression)) {
      const name = n.argumentExpression.text;
      refs.push({ name, node: n, line: lineOf(sf, n) });
      if (name === "constructor") bad(n, "reads [\"constructor\"] - a way to reach Function without naming it");
    }
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) bad(n, "dynamic import() - modules are imported statically");
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
      if ((callee === "setTimeout" || callee === "setInterval") && n.arguments[0] && isStringish(n.arguments[0])) bad(n, callee + " given a string to evaluate");
    }
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && NET_PACKAGES.test(n.moduleSpecifier.text)) {
      bad(n, "imports an HTTP / socket client package (" + n.moduleSpecifier.text + ")");
    }
  });
  const diags = sf.parseDiagnostics || [];
  if (diags.length) problems.push(r + ": does not parse (" + ts.flattenDiagnosticMessageText(diags[0].messageText, " ") + ")");
  return { refs, problems };
}

// The nearest function that contains `node` (null at module level).
function enclosingFn(node) {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return null;
}
function topLevelFunctions(sf, name) {
  return sf.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name && s.name.text === name);
}
// `stmt` is exactly the statement NAME(ARGTEXT);
function isCallStatement(sf, stmt, name, argText) {
  if (!stmt || !ts.isExpressionStatement(stmt)) return false;
  const e = stmt.expression;
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === name
    && e.arguments.length === 1 && e.arguments[0].getText(sf) === argText;
}
// Every declaration of `name` in the file must be ONE value import of it
// from `from`: no local function or variable of that name, no parameter
// that shadows it, no rename.
function importedOnce(sf, name, from) {
  const decls = [];
  visit(sf, (n) => { if (ts.isIdentifier(n) && n.text === name && isDeclName(n)) decls.push(n); });
  if (decls.length !== 1) return name + " is declared " + decls.length + " times - it must be one import from " + from;
  const spec = decls[0].parent;
  if (!ts.isImportSpecifier(spec)) return name + " must be imported from " + from + ", not defined locally";
  const decl = spec.parent.parent.parent;
  if ((spec.propertyName || spec.name).text !== name) return name + " is a renamed import";
  if (spec.isTypeOnly || decl.importClause.isTypeOnly) return name + " is a type-only import";
  if (!ts.isStringLiteral(decl.moduleSpecifier) || decl.moduleSpecifier.text !== from) return name + " must be imported from " + from;
  return null;
}
// Assignments (=, +=, ++, --, destructuring) inside `fn` whose target
// mentions one of `names` (x = ..., x.y = ..., [x] = ...).
function assignmentsTo(fn, names) {
  const hits = [];
  const mentions = (target) => {
    let found = false;
    visit(target, (n) => { if (ts.isIdentifier(n) && names.includes(n.text) && isValueRef(n)) found = true; });
    return found;
  };
  visit(fn.body, (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && mentions(n.left)) hits.push(n);
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && mentions(n.operand)) hits.push(n);
  });
  return hits;
}
// `const NAME = "VALUE";` at module level, and NAME declared nowhere else.
function constLiteral(sf, name, value) {
  let decls = 0, ok = false;
  visit(sf, (n) => { if (ts.isIdentifier(n) && n.text === name && isDeclName(n)) decls++; });
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s) || !(s.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && ts.isStringLiteral(d.initializer) && d.initializer.text === value) ok = true;
    }
  }
  return ok && decls === 1;
}

// `name` is declared once, as a top-level const whose initializer is exactly
// `source` (white space aside). For a declaration that is an expression, not
// one literal: any other shape of it fails.
function constText(sf, name, source) {
  let decls = 0, ok = false;
  const flat = (t) => t.replace(/\s+/g, "");
  visit(sf, (n) => { if (ts.isIdentifier(n) && n.text === name && isDeclName(n)) decls++; });
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s) || !(s.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of s.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer && flat(d.initializer.getText(sf)) === flat(source)) ok = true;
    }
  }
  return ok && decls === 1;
}

// The one fetch each client file may hold, by its first argument.
const FETCH_FILES = {
  "src/lib/hyperliquid.ts": "API",
  "src/lib/hl_exchange.ts": "EXCHANGE_URL",
  "src/lib/mfp_exchange.ts": "HOSTS[env] + path",
  "src/lib/mfp_market_list.ts": "LIST_URL",
  "src/lib/mfp_stream.ts": "RELAY[env] + query",
};
const HL_ACTION_TYPES = ["order", "cancel", "modify", "updateLeverage"];

const HL_FORBIDDEN = [
  "usdSend", "spotSend", "usdClassTransfer", "vaultTransfer", "approveAgent", "approveBuilderFee", "withdraw3",
  "twapOrder", "twapCancel", "batchModify", "scheduleCancel", "createSubAccount", "subAccountTransfer",
  "subAccountSpotTransfer", "updateIsolatedMargin", "topUpIsolatedOnlyMargin", "setReferrer", "registerReferrer",
  "createVault", "vaultModify", "vaultDistribute", "cDeposit", "cWithdraw", "tokenDelegate", "spotUser",
  "setDisplayName", "evmUserModify", "convertToMultiSigUser", "perpDeploy", "spotDeploy", "cancelByCloid",
  "reserveRequestWeight", "noop",
];
const MFP_BANNED = /(cancel-all-orders|close-all-positions|attached-exits|isolated-margin|twap-orders|scaled-orders|copy-trading|acknowledge-copy-stop|price-alerts|\/v1\/auth\/)/;
const MFP_RESOURCES = ["accounts", "positions", "orders", "markets", "fills"];
const MFP_MARKET_LIST = "src/lib/mfp_market_list.ts";
const MFP_LIST_URL = "https://developers.myfundedperpetuals.com/v1/markets?venues=all";
// The two host declarations, exactly: the app's own origin on the web (the
// pass-through), MFP's API hosts everywhere else.
const MFP_HOSTS_SOURCE = 'Object.freeze(Platform.OS === "web" ? { live: "/mfp/live", sandbox: "/mfp/sandbox" } : { live: "https://developers.myfundedperpetuals.com", sandbox: "https://sandbox.myfundedperpetuals.com" })';
const MFP_UPSTREAM_SOURCE = 'Object.freeze({ live: "https://developers.myfundedperpetuals.com", sandbox: "https://sandbox.myfundedperpetuals.com" })';
const SEND_OPTIONS = ["method", "headers", "body", "redirect", "signal"];
const MFP_LIST_URL_SOURCE = 'Platform.OS === "web" ? "/mfp/live/v1/markets?venues=all" : "' + MFP_LIST_URL + '"';
const MFP_API_HOSTS = ["https://developers.myfundedperpetuals.com", "https://sandbox.myfundedperpetuals.com"];
const SERVER_IMPORTS = ["node:fs", "node:http", "node:path", "node:url"];
// The account stream: one host, two paths (the sandbox is chosen by path).
const MFP_STREAM = "src/lib/mfp_stream.ts";
const MFP_STREAM_RELAY = "server/mfp_stream_relay.mjs";
const MFP_STREAM_URLS = ["wss://account-stream.myfundedperpetuals.com/v1/stream", "wss://account-stream.myfundedperpetuals.com/v1/sandbox/stream"];
const MFP_STREAM_RELAY_SOURCE = 'Object.freeze({ live: "/mfp/live/v1/stream", sandbox: "/mfp/sandbox/v1/stream" })';
const MFP_STREAM_UPSTREAM_SOURCE = 'Object.freeze({ live: "' + MFP_STREAM_URLS[0] + '", sandbox: "' + MFP_STREAM_URLS[1] + '" })';
// "send" and "ping" as words (sends, sending, pings ... too), any case.
const STREAM_WORDS = /\b(send|ping)/i;
const STREAM_FETCH_OPTIONS = ["method", "headers", "signal"];
const MFP_STREAM_IMPORTS = ["react-native", "./mfp_orders", "./mfp_stream_core"];
const MFP_STREAM_RESOURCES = ["stream", "sandbox"];
const inLoop = (node) => {
  for (let a = node.parent; a && !ts.isFunctionLike(a); a = a.parent) {
    if (ts.isForStatement(a) || ts.isForOfStatement(a) || ts.isForInStatement(a) || ts.isWhileStatement(a) || ts.isDoStatement(a)) return true;
  }
  return false;
};
// The callee of a `new`, through any parentheses and `as` casts.
const newCallee = (n) => {
  let e = n.expression;
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e))) e = e.expression;
  return e;
};

// Every rule, over one file map. Returns the list of violations (empty = OK).
function check(tree) {
  const errors = [];
  const files = [...tree.keys()].filter((k) => k.startsWith("src/"));
  const fetchRefs = new Map();   // client file -> its fetch references

  for (const r of files) {
    const text = tree.get(r);
    const lines = text.split(/\r?\n/);
    const isExchange = r === "src/lib/hl_exchange.ts";
    const isSign = r === "src/lib/hl_sign.ts";
    const isOrders = r === "src/lib/hl_orders.ts";
    const isInfo = r === "src/lib/hyperliquid.ts";
    const isStream = r === "src/lib/hl_stream.ts";
    const isAgentStore = r === "src/lib/agent_store.ts";
    const isMfpExchange = r === "src/lib/mfp_exchange.ts";
    const isMfpOrders = r === "src/lib/mfp_orders.ts";
    const isMfpMarketList = r === MFP_MARKET_LIST;
    const isMfpStream = r === MFP_STREAM;
    // Transport, from the syntax tree: only the five client files may name
    // fetch, each exactly once, as a direct call on its own URL. Everything
    // else in src/ has no way to send, whatever it builds its URL from.
    if (/\.(ts|tsx|js|mjs)$/.test(r)) {
      const sf = parse(r, text);
      const { refs, problems } = scanSource(r, sf);
      errors.push(...problems);
      const fetches = refs.filter((x) => x.name === "fetch");
      const want = FETCH_FILES[r];
      if (!want) {
        if (fetches.length) errors.push(r + ": names fetch - only hyperliquid.ts, hl_exchange.ts, mfp_exchange.ts, mfp_market_list.ts and mfp_stream.ts may send (line " + fetches.map((x) => x.line).join(", ") + ")");
      } else {
        fetchRefs.set(r, { sf, fetches });
        if (fetches.length !== 1) errors.push(r + ": must name fetch exactly once (its one call), found " + fetches.length);
        const call = fetches.length === 1 ? fetches[0].node.parent : null;
        const direct = call && ts.isIdentifier(fetches[0].node) && ts.isCallExpression(call) && call.expression === fetches[0].node
          && call.arguments.length >= 2 && call.arguments[0].getText(sf).replace(/\s+/g, " ") === want;
        if (!direct) errors.push(r + ": its one fetch must be the call fetch(" + want + ", ...) on the URL constant");
      }
      for (const x of refs) {
        if (TRANSPORTS.includes(x.name)) errors.push(r + ":" + x.line + ": names another transport (XMLHttpRequest / sendBeacon / EventSource)");
        if (x.name === "WebSocket" && !isStream && !isMfpStream) errors.push(r + ":" + x.line + ": names WebSocket outside hl_stream.ts / mfp_stream.ts");
      }
      // A line of CODE that names WebSocket (comments aside, strings kept):
      // an alias, globalThis.WebSocket or a string key is caught here even
      // where the syntax-tree scan above would be talked around.
      if (!isStream && !isMfpStream) {
        stripComments(text).split(/\r?\n/).forEach((line, i) => {
          if (/WebSocket/.test(line)) errors.push(r + ":" + (i + 1) + ": a line of code names WebSocket outside hl_stream.ts / mfp_stream.ts");
        });
      }
    }
    lines.forEach((line, i) => {
      const where = r + ":" + (i + 1);
      if (!isExchange && !isSign && !isInfo && !isStream && line.includes("hyperliquid.xyz")) errors.push(where + ": hyperliquid host outside hyperliquid.ts / hl_exchange.ts / hl_stream.ts");
      if (isInfo && line.includes("/exchange")) errors.push(where + ": the info client must not reference the exchange path");
      if (!isExchange && !isSign && /\bsignL1Action\b/.test(line)) errors.push(where + ": signL1Action referenced outside hl_exchange.ts");
      if (!isAgentStore && /from\s+["']expo-secure-store["']/.test(line)) errors.push(where + ": expo-secure-store imported outside agent_store.ts");
      if ((isSign || isOrders || isMfpOrders) && /from\s+["'](react-native|expo-|expo$|@react-native-|@\/)/.test(line)) errors.push(where + ": pure module imports a platform package");
      if (/console\.(log|warn|error|info|debug)\(/.test(line) && /key|priv/i.test(line)) errors.push(where + ": console output mentions a key");
      for (const name of HL_FORBIDDEN) {
        if (new RegExp("[\"'`]" + name + "[\"'`]").test(line)) errors.push(where + ": forbidden Hyperliquid action " + name);
      }
      if (/grouping\s*:\s*["'`](?!na["'`])/.test(line)) errors.push(where + ": order grouping other than na");
      if (!isStream && !isInfo && /\bHL_WS_URL\b/.test(line)) errors.push(where + ": HL_WS_URL used outside hl_stream.ts");
      if (!isStream && !isInfo && !isMfpStream && /wss:\/\//.test(line)) errors.push(where + ": a WebSocket URL outside hl_stream.ts / hyperliquid.ts / mfp_stream.ts");
      if (!isMfpStream && /account-stream/i.test(line)) errors.push(where + ": the MFP stream host outside mfp_stream.ts");
      // Receive-only, held by the words themselves, comments included.
      if (isMfpStream && STREAM_WORDS.test(line)) errors.push(where + ": mfp_stream.ts holds the word send or ping - the account stream is receive-only (no frame, no keep-alive; the words are banned from the whole file)");
      if (isStream && /["'`](post|action|order|cancel|modify)["'`]/.test(line)) errors.push(where + ": hl_stream.ts may only subscribe / unsubscribe / ping");
      if (isStream && /method\s*:?\s*["'`](?!subscribe|unsubscribe|ping)\w+/.test(line)) errors.push(where + ": hl_stream.ts names a socket method other than subscribe / unsubscribe / ping");

      if (!isMfpExchange && !isMfpMarketList && !isMfpStream && /perpetuals/i.test(line)) errors.push(where + ": MFP host (or a piece of it) outside mfp_exchange.ts / mfp_market_list.ts / mfp_stream.ts");
      const banned = line.match(MFP_BANNED);
      if (banned) errors.push(where + ": banned MFP endpoint " + banned[1]);
      if (!isMfpOrders && !isMfpExchange && /exit-orders/.test(line)) errors.push(where + ": exit-orders outside mfp_orders.ts / mfp_exchange.ts");
      for (const hit of line.match(/\/v1\/[a-z][a-z-]*/g) || []) {
        const res = hit.slice("/v1/".length);
        // The stream's file names the stream's two paths and no REST
        // resource; every other file names REST resources and no stream path.
        if (isMfpStream ? !MFP_STREAM_RESOURCES.includes(res) : !MFP_RESOURCES.includes(res)) errors.push(where + ": MFP resource /v1/" + res + " is not on the docs/CONTRACT.md list" + (isMfpStream ? " for the stream" : ""));
      }
      if (isMfpOrders) {
        for (const hit of line.match(/\btype:\s*"([A-Za-z0-9_]+)"/g) || []) {
          const t = hit.replace(/type:\s*"/, "").replace(/"$/, "");
          if (t !== "market" && t !== "limit") errors.push(where + ": mfp_orders.ts names order type " + t);
        }
      }
      if (isOrders) {
        for (const hit of line.match(/\btype:\s*"([A-Za-z0-9_]+)"/g) || []) {
          const t = hit.replace(/type:\s*"/, "").replace(/"$/, "");
          if (!["order", "cancel", "modify", "updateLeverage"].includes(t)) errors.push(where + ": hl_orders.ts names action type " + t);
        }
      }
      if (/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(line) && !/^\s*\/\//.test(line)) errors.push(where + ": direct web storage access (keys must never persist on web)");
    });
  }

  // hl_sign: noble + msgpack only.
  if (tree.has("src/lib/hl_sign.ts")) {
    for (const m of tree.get("src/lib/hl_sign.ts").matchAll(/from\s+["']([^"']+)["']/g)) {
      const dep = m[1];
      if (!/^@noble\/(curves|hashes)\//.test(dep) && dep !== "@msgpack/msgpack") errors.push("src/lib/hl_sign.ts imports " + dep);
    }
  }
  for (const pure of ["hl_orders.ts", "mfp_orders.ts", "order_policy.ts", "candles.ts", "drawings.ts", "mfp_markets.ts", "session.ts", "agent_binding.ts", "mfp_rate.ts", "mfp_stream_core.ts"]) {
    const p = "src/lib/" + pure;
    if (tree.has(p) && /^\s*import\s/m.test(tree.get(p))) errors.push("src/lib/" + pure + " must stay import-free");
  }

  // Exchange clients, from the syntax tree: the assertions are top-level
  // statements of the sending function (nothing can skip them), they come
  // first, and the signature / the request come after them, in that same
  // function body (not a closure, not a default parameter).
  if (tree.has("src/lib/hl_exchange.ts")) {
    const F = "src/lib/hl_exchange.ts";
    const sf = parse(F, tree.get(F));
    for (const [name, from] of [["assertScopedAction", "./hl_orders"], ["assertSession", "./session"], ["signL1Action", "./hl_sign"]]) {
      const why = importedOnce(sf, name, from);
      if (why) errors.push(F + ": " + why);
    }
    const posts = topLevelFunctions(sf, "postExchange");
    const post = posts.length === 1 ? posts[0] : null;
    const body = post && post.body ? post.body.statements : [];
    const params = post ? post.parameters.map((p) => p.name.getText(sf)) : [];
    if (!post || !post.body || !params.includes("s") || !params.includes("action")
      || !isCallStatement(sf, body[0], "assertScopedAction", "action") || !isCallStatement(sf, body[1], "assertSession", "s")) {
      errors.push(F + ": postExchange must begin by executing assertScopedAction(action); then assertSession(s); (as its first two top-level statements)");
    }
    if (post && post.body) {
      for (const a of assignmentsTo(post, ["s", "action"])) errors.push(F + ":" + lineOf(sf, a) + ": postExchange assigns to s or action after asserting it");
    }
    const signs = [];
    visit(sf, (n) => { if (ts.isIdentifier(n) && n.text === "signL1Action" && isValueRef(n)) signs.push(n); });
    if (signs.length !== 1) errors.push(F + " must call signL1Action exactly once (in postExchange), found " + signs.length);
    const after = body[1] ? body[1].end : Infinity;
    const inPost = (node) => post && enclosingFn(node) === post && node.getStart(sf) >= after;
    const sign = signs[0];
    const signCall = sign && ts.isCallExpression(sign.parent) && sign.parent.expression === sign ? sign.parent : null;
    if (!signCall || !inPost(signCall) || !signCall.arguments[1] || signCall.arguments[1].getText(sf) !== "action") {
      errors.push(F + ": signL1Action must be called inside postExchange, after its assertions, on action");
    }
    const f = fetchRefs.get(F);
    if (f && f.fetches.length === 1 && !inPost(f.fetches[0].node)) errors.push(F + ": its fetch must sit inside postExchange, after its assertions");
    if (!constLiteral(sf, "EXCHANGE_URL", "https://api.hyperliquid.xyz/exchange")) errors.push(F + ": EXCHANGE_URL must be the literal exchange URL");
  }
  if (tree.has("src/lib/hyperliquid.ts")) {
    const sf = parse("src/lib/hyperliquid.ts", tree.get("src/lib/hyperliquid.ts"));
    if (!constLiteral(sf, "API", "https://api.hyperliquid.xyz/info")) errors.push("src/lib/hyperliquid.ts: API must be the literal info URL");
  }
  if (tree.has("src/lib/mfp_exchange.ts")) {
    const F = "src/lib/mfp_exchange.ts";
    const sf = parse(F, tree.get(F));
    for (const [name, from] of [["assertMfpWrite", "./mfp_orders"], ["sessionLive", "./session"], ["Platform", "react-native"]]) {
      const why = importedOnce(sf, name, from);
      if (why) errors.push(F + ": " + why);
    }
    if (!constText(sf, "HOSTS", MFP_HOSTS_SOURCE)) errors.push(F + ": HOSTS must be the pinned declaration (the app's own /mfp/<env> on the web, MFP's two API hosts otherwise)");
    const calls = topLevelFunctions(sf, "call");
    const fn = calls.length === 1 ? calls[0] : null;
    const stmts = fn && fn.body ? fn.body.statements : [];
    const writeIfs = stmts.filter((s) => ts.isIfStatement(s) && s.expression.getText(sf).replace(/\s+/g, " ") === 'req.method === "WRITE"');
    const writeIf = writeIfs.length === 1 ? writeIfs[0] : null;
    const then = writeIf && ts.isBlock(writeIf.thenStatement) ? writeIf.thenStatement.statements : [];
    const refuse = then[1];
    const refuses = refuse && ts.isIfStatement(refuse) && !refuse.elseStatement
      && refuse.expression.getText(sf).replace(/\s+/g, "") === "!sessionLive(req.session)"
      && (ts.isReturnStatement(refuse.thenStatement) || (ts.isBlock(refuse.thenStatement) && refuse.thenStatement.statements.length === 1 && ts.isReturnStatement(refuse.thenStatement.statements[0])));
    if (!fn || !fn.body || !writeIf || !isCallStatement(sf, then[0], "assertMfpWrite", "req.write") || !refuses) {
      errors.push(F + ": call() must execute assertMfpWrite(req.write); and then refuse a stale session, before the request (the first two statements of its one top-level if (req.method === \"WRITE\"))");
    }
    if (fn && fn.body) {
      for (const a of assignmentsTo(fn, ["req"])) errors.push(F + ":" + lineOf(sf, a) + ": call() assigns to req");
      // method is the write's own (after its assertions) or GET, nothing else.
      const afterAsserts = refuse ? refuse.end : Infinity;
      for (const a of assignmentsTo(fn, ["method"])) {
        const okWrite = writeIf && ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(a.left)
          && a.right.getText(sf) === "req.write.method" && a.getStart(sf) >= afterAsserts && a.end <= writeIf.thenStatement.end;
        const okGet = ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(a.left)
          && ts.isStringLiteral(a.right) && a.right.text === "GET";
        if (!okWrite && !okGet) errors.push(F + ":" + lineOf(sf, a) + ": call() sets method to something other than req.write.method (after the assertions) or \"GET\"");
      }
      visit(fn.body, (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "method" && n.initializer) errors.push(F + ":" + lineOf(sf, n) + ": call() must declare method without a value");
      });
    }
    const f = fetchRefs.get(F);
    if (!writeIf || !f || f.fetches.length !== 1 || enclosingFn(f.fetches[0].node) !== fn || f.fetches[0].node.getStart(sf) < writeIf.end) {
      errors.push(F + ": the write assertion must come before the fetch (the fetch sits in call(), after the WRITE branch)");
    } else {
      const opts = f.fetches[0].node.parent.arguments[1];
      const sendsMethod = opts && ts.isObjectLiteralExpression(opts) && !opts.properties.some(ts.isSpreadAssignment)
        && opts.properties.some((p) => p.name && p.name.getText(sf) === "method" && (ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer.getText(sf) === "method")));
      if (!sendsMethod) errors.push(F + ": the fetch must send { method, ... } - the pinned method variable, no spread");
    }
    // HOSTS is named once beside its declaration: the fetch's address. A
    // direct write (HOSTS.live = ...), an alias or Object.assign(HOSTS, ...)
    // is a second mention, whatever it does.
    const hostRefs = [];
    visit(sf, (n) => { if (ts.isIdentifier(n) && n.text === "HOSTS" && !isDeclName(n)) hostRefs.push(n); });
    const addr = f && f.fetches.length === 1 && ts.isCallExpression(f.fetches[0].node.parent) ? f.fetches[0].node.parent.arguments[0] : null;
    if (hostRefs.length !== 1 || !addr || addr.getText(sf).replace(/\s+/g, "") !== "HOSTS[env]+path" || hostRefs[0].getStart(sf) < addr.getStart(sf) || hostRefs[0].end > addr.end) {
      errors.push(F + ": HOSTS must be named once beside its declaration, as the fetch's address (HOSTS[env] + path) - no assignment to it, no alias of it");
    }
  }
  // The MFP account stream's one file: two pinned address tables, each
  // used once (the fetch to the app's OWN origin; the socket to the stream
  // host), nothing else that could carry a request anywhere.
  if (tree.has(MFP_STREAM)) {
    const F = MFP_STREAM;
    const text = tree.get(F);
    const sf = parse(F, text);
    const code = stripComments(text);
    const flat = (n) => n.getText(sf).replace(/\s+/g, "");
    if (!constText(sf, "RELAY", MFP_STREAM_RELAY_SOURCE)) errors.push(F + ": RELAY must be the pinned declaration (the app's own two stream paths, relative: its one HTTP call cannot leave the app's origin)");
    if (!constText(sf, "DIRECT", MFP_STREAM_UPSTREAM_SOURCE)) errors.push(F + ": DIRECT must be the pinned declaration (the stream host's two paths, frozen)");
    const platform = importedOnce(sf, "Platform", "react-native");
    if (platform) errors.push(F + ": " + platform);
    for (const m of code.matchAll(/\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      const spec = m[1] || m[2];
      if (!MFP_STREAM_IMPORTS.includes(spec)) errors.push(F + ": imports " + spec + " - the stream may import " + MFP_STREAM_IMPORTS.join(", ") + " only (it cannot reach the key store or the REST client)");
    }
    const urls = code.match(/(?:https?|wss?):\/\/[^\s"'`;]+/g) || [];
    const schemes = (code.match(/:\/\//g) || []).length;
    if (urls.length !== 2 || urls[0] !== MFP_STREAM_URLS[0] || urls[1] !== MFP_STREAM_URLS[1] || schemes !== 2) errors.push(F + ": names an address other than the stream host's two paths, found " + JSON.stringify(urls));
    // Exempt from the host rule above, so held to this instead: the MFP
    // host appears in the two pinned addresses and nowhere else in the file.
    if ((text.match(/perpetuals/gi) || []).length !== 2) errors.push(F + ": names the MFP host other than in its two pinned stream addresses - it must not become a second way to the REST host");
    const named = (name) => {
      const out = [];
      visit(sf, (n) => { if (ts.isIdentifier(n) && n.text === name && !isDeclName(n)) out.push(n); });
      return out;
    };
    const within = (node, outer) => !!outer && node.getStart(sf) >= outer.getStart(sf) && node.end <= outer.end;
    // The one fetch: RELAY[env] + query, method "GET", headers and signal.
    const f = fetchRefs.get(F);
    const fetchCall = f && f.fetches.length === 1 && ts.isCallExpression(f.fetches[0].node.parent) ? f.fetches[0].node.parent : null;
    const relayRefs = named("RELAY");
    if (!fetchCall || relayRefs.length !== 1 || flat(fetchCall.arguments[0]) !== "RELAY[env]+query" || !within(relayRefs[0], fetchCall.arguments[0])) {
      errors.push(F + ": RELAY must be named once beside its declaration, as the fetch's address (RELAY[env] + query)");
    }
    const opts = fetchCall ? fetchCall.arguments[1] : null;
    const props = opts && ts.isObjectLiteralExpression(opts) ? opts.properties : null;
    const plain = props && props.every((q) => ts.isPropertyAssignment(q) && ts.isIdentifier(q.name));
    const okOpts = plain && props.length === STREAM_FETCH_OPTIONS.length && STREAM_FETCH_OPTIONS.every((x) => props.some((q) => q.name.text === x))
      && props.some((q) => q.name.text === "method" && ts.isStringLiteral(q.initializer) && q.initializer.text === "GET");
    if (!okOpts) errors.push(F + ': its fetch must pass exactly { method: "GET", headers, signal } - no body, no spread');
    // The one socket: new WebSocket(DIRECT[env] + query, ...).
    const news = [];
    visit(sf, (n) => { if (ts.isNewExpression(n)) { const c = newCallee(n); if (c && ts.isIdentifier(c) && c.text === "WebSocket") news.push(n); } });
    const wsRefs = named("WebSocket");
    const directRefs = named("DIRECT");
    const sock = news.length === 1 ? news[0] : null;
    if (!sock || wsRefs.length !== 1 || !sock.arguments || !sock.arguments[0] || flat(sock.arguments[0]) !== "DIRECT[env]+query" || inLoop(sock)
      || directRefs.length !== 1 || !within(directRefs[0], sock.arguments[0])) {
      errors.push(F + ": must build ONE WebSocket, on DIRECT[env] + query, and name WebSocket and DIRECT nowhere else");
    }
    // The transport is chosen by the platform, in one place, and is handed
    // exactly (env, query, key, handlers).
    const choice = (code.match(/\(Platform\.OS === "web" \? openRelayed : openDirect\)\(/g) || []).length;
    const call = (code.match(/\(Platform\.OS === "web" \? openRelayed : openDirect\)\(env, query, key, handlers\)/g) || []).length;
    if (choice !== 1 || call !== 1 || named("openRelayed").length !== 1 || named("openDirect").length !== 1) errors.push(F + ': the transport must be chosen once, by (Platform.OS === "web" ? openRelayed : openDirect)(env, query, key, handlers), and neither named anywhere else');
    // `query` is the address's only variable part. It is ONE const, the
    // value of resumeQuery(core); it is never assigned to; and it is used
    // three times: the fetch's address, the socket's, the transport call.
    const queryDecls = [];
    visit(sf, (n) => { if (ts.isIdentifier(n) && n.text === "query" && isDeclName(n)) queryDecls.push(n.parent); });
    const queryVars = queryDecls.filter(ts.isVariableDeclaration);
    const queryParams = queryDecls.filter(ts.isParameter);
    const queryOk = queryVars.length === 1 && queryParams.length === 2 && queryDecls.length === 3
      && queryVars[0].initializer && flat(queryVars[0].initializer) === "resumeQuery(core)"
      && (queryVars[0].parent.flags & ts.NodeFlags.Const) !== 0;
    let queryAssigned = false;
    visit(sf, (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && /\bquery\b/.test(n.left.getText(sf))) queryAssigned = true;
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && /\bquery\b/.test(n.operand.getText(sf))) queryAssigned = true;
    });
    // Whole texts are compared with their white space brought to one space
    // (not removed: the space in "Bearer " is part of the header).
    const spaced = (n) => n.getText(sf).replace(/\s+/g, " ");
    if (!queryOk || queryAssigned || named("query").length !== 3) errors.push(F + ": query must be ONE const, resumeQuery(core), never assigned to, and used only as the fetch's address, the socket's address and the transport call's argument - nothing else may reach the address");
    // The request's headers and the socket's options, whole: the key is in
    // the Authorization header and nowhere else.
    const headersProp = props ? props.find((q) => ts.isPropertyAssignment(q) && ts.isIdentifier(q.name) && q.name.text === "headers") : null;
    if (!headersProp || spaced(headersProp.initializer) !== '{ Authorization: "Bearer " + key, Accept: "application/x-ndjson" }') errors.push(F + ': its fetch headers must be exactly { Authorization: "Bearer " + key, Accept: "application/x-ndjson" }');
    if (sock && (!sock.arguments || sock.arguments.length !== 3 || flat(sock.arguments[1]) !== "null" || spaced(sock.arguments[2]) !== '{ headers: { Authorization: "Bearer " + key } }')) errors.push(F + ': its socket must be built as (DIRECT[env] + query, null, { headers: { Authorization: "Bearer " + key } }) - nothing else may travel with it');
    for (const name of ["openRelayed", "openDirect"]) {
      const fn = topLevelFunctions(sf, name)[0];
      let uses = 0;
      if (fn && fn.body) visit(fn.body, (n) => { if (ts.isIdentifier(n) && n.text === "key" && isValueRef(n)) uses++; });
      if (!fn || uses !== 1) errors.push(F + ": " + name + " must name key exactly once, in its Authorization header (found " + uses + ")");
    }
    // Nothing is indexed by a built name: RELAY[env] and DIRECT[env] only.
    visit(sf, (n) => {
      if (ts.isElementAccessExpression(n) && !/^(RELAY|DIRECT)\[env\]$/.test(flat(n))) errors.push(F + ":" + lineOf(sf, n) + ": indexes " + flat(n).slice(0, 40) + " - only RELAY[env] and DIRECT[env] may be indexed here (a built name is a way round the word ban)");
      if (ts.isIdentifier(n) && n.text === "Reflect") errors.push(F + ":" + lineOf(sf, n) + ": names Reflect - a way to call a method without naming it");
    });
  }

  // hl_orders.ts: an action type is one of four string literals, written out.
  // A type that is built (joined, concatenated, read from a variable) is not
  // something a scan for forbidden names can see, so it is not allowed at all.
  if (tree.has("src/lib/hl_orders.ts")) {
    const t = stripComments(tree.get("src/lib/hl_orders.ts"));
    const re = /\btype\s*:\s*/g;
    let m;
    while ((m = re.exec(t))) {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const lit = after.match(/^"([A-Za-z0-9_]+)"/);
      const line = t.slice(0, m.index).split("\n").length;
      if (!lit || !HL_ACTION_TYPES.includes(lit[1])) errors.push("src/lib/hl_orders.ts:" + line + ": an action type must be one of the four permitted string literals, written out");
    }
    if (/\.join\s*\(|fromCharCode|\[\s*["'`]type["'`]\s*\]|\.concat\s*\(/.test(t)) errors.push("src/lib/hl_orders.ts: builds a string or a key (join / concat / fromCharCode / a computed type key) - action shapes are written out literally");
  }

  // MFP public market list: one keyless GET of one URL.
  if (tree.has(MFP_MARKET_LIST)) {
    const code = tree.get(MFP_MARKET_LIST).split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const fetches = (code.match(/\bfetch\s*\(/g) || []).length;
    if (fetches !== 1) errors.push(MFP_MARKET_LIST + " must call fetch exactly once, found " + fetches);
    if (!/\bfetch\s*\(\s*LIST_URL\s*,/.test(code)) errors.push(MFP_MARKET_LIST + " must call fetch(LIST_URL, ...) on the bare constant");
    const uses = (code.match(/\bLIST_URL\b/g) || []).length;
    if (uses !== 2) errors.push(MFP_MARKET_LIST + " must name LIST_URL exactly twice (declaration + fetch), found " + uses);
    const listSf = parse(MFP_MARKET_LIST, tree.get(MFP_MARKET_LIST));
    if (!constText(listSf, "LIST_URL", MFP_LIST_URL_SOURCE)) errors.push(MFP_MARKET_LIST + " must declare LIST_URL as the pinned declaration (the app's own /mfp/live path on the web, " + MFP_LIST_URL + " otherwise)");
    const listPlatform = importedOnce(listSf, "Platform", "react-native");
    if (listPlatform) errors.push(MFP_MARKET_LIST + ": " + listPlatform);
    const urls = code.match(/https?:\/\/[^\s"'`]+/g) || [];
    if (urls.length !== 1 || urls[0] !== MFP_LIST_URL) errors.push(MFP_MARKET_LIST + " may name only " + MFP_LIST_URL + ", found " + JSON.stringify(urls));
    const methods = code.match(/method\s*:\s*["'`]\w+/g) || [];
    if (methods.length !== 1 || !/GET$/.test(methods[0])) errors.push(MFP_MARKET_LIST + " must send exactly one method, GET; found " + JSON.stringify(methods));
    if (/authorization|bearer/i.test(code)) errors.push(MFP_MARKET_LIST + " names an auth header - the market list is public and keyless");
    if (/from\s+["'][^"']*(agent_store|mfp_exchange|mfp_orders|expo-secure-store)["']/.test(code)) errors.push(MFP_MARKET_LIST + " imports a key or exchange module");
    if (/\bbody\s*:/.test(code)) errors.push(MFP_MARKET_LIST + " sends a request body");
  }

  // The pass-through (server/): it can reach MFP's two API hosts and nothing
  // else, sends one request per request, and never answers another origin.
  // Only mfp_passthrough.mjs can send (the one fetch, called once); the
  // hosts live in mfp_route.mjs alone; serve.mjs serves files and has no way
  // to make a request (no fetch, no client call on node:http).
  const serverFiles = [...tree.keys()].filter((k) => k.startsWith("server/"));
  let serverFetch = 0, serverSends = 0;
  for (const f of serverFiles) {
    const code = stripComments(tree.get(f));           // strings kept: URLs, header names, import paths
    const bare = stripComments(tree.get(f), true);     // strings blanked: identifiers only
    const urls = code.match(/(?:https?|wss?):\/\/[^\s"'`;]+/g) || [];
    // A scheme with nothing after it ("https://" + x) is an address too, so
    // the "://" are counted, not only whole URLs.
    const schemes = (code.match(/:\/\//g) || []).length;
    if (f === "server/mfp_route.mjs") {
      for (const u of urls) if (!MFP_API_HOSTS.includes(u)) errors.push(f + ": names a URL other than MFP's two API hosts: " + u);
      if (schemes !== MFP_API_HOSTS.length) errors.push(f + ": names a URL other than MFP's two API hosts (" + schemes + " schemes, " + MFP_API_HOSTS.length + " permitted)");
    } else if (f === "server/mfp_passthrough.mjs") {
      for (const u of urls) errors.push(f + ": names a URL - the sender takes its address from mfp_route.mjs only: " + u);
      // its own origin strings ("http://" + h, compared with the Origin header) are the one use of a scheme
      const own = (code.match(/"http:\/\/" \+ h\b/g) || []).length;
      if (schemes !== own) errors.push(f + ": names a URL - the sender takes its address from mfp_route.mjs only");
    } else if (f === MFP_STREAM_RELAY) {
      // The relay: the stream host's two paths and nothing else (its own
      // origin strings, compared with the Origin header, aside).
      const own = (code.match(/"http:\/\/" \+ h\b/g) || []).length;
      if (urls.length !== 2 || urls[0] !== MFP_STREAM_URLS[0] || urls[1] !== MFP_STREAM_URLS[1] || schemes !== 2 + own) errors.push(f + ": names an address other than the stream host's two paths, found " + JSON.stringify(urls));
      tree.get(f).split(/\r?\n/).forEach((line, i) => {
        if (STREAM_WORDS.test(line)) errors.push(f + ":" + (i + 1) + ": holds the word send or ping - the relay is receive-only (no frame, no keep-alive; the words are banned from the whole file)");
      });
    }
    // The account stream's host and paths live in the relay alone.
    if (f !== MFP_STREAM_RELAY && (/account-stream/i.test(code) || /\/v1\/(sandbox\/)?stream\b/.test(code))) errors.push(f + ": names the MFP stream host or a stream path - only mfp_stream_relay.mjs may");
    const fetches = (bare.match(/\bfetch\b/g) || []).length;
    if (fetches && f !== "server/mfp_passthrough.mjs") errors.push(f + ": names fetch - only mfp_passthrough.mjs may send");
    serverFetch += fetches;
    serverSends += (bare.match(/\bsend\s*\(/g) || []).length;
    if (/access-control/i.test(code)) errors.push(f + ": names a CORS header - the pass-through answers its own origin only");
    if (TRANSPORTS.some((t) => new RegExp("\\b" + t + "\\b").test(bare)) || (f !== MFP_STREAM_RELAY && /WebSocket/.test(code))) errors.push(f + ": names another transport");
    if (/\bhttps?\s*\.\s*(request|get)\b/.test(bare)) errors.push(f + ": makes a client request through node:http - only the one fetch may send");
    for (const m of code.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (!SERVER_IMPORTS.includes(spec) && !/^\.\/[a-z_]+\.mjs$/.test(spec)) errors.push(f + ": imports " + spec + " - server/ may import " + SERVER_IMPORTS.join(", ") + " and its own files only");
    }
    if (/\bimport\s*\(\s*[^"'\s]/.test(code) || /\brequire\s*\(\s*[^"'\s]/.test(code)) errors.push(f + ": a computed import");
    if (/\beval\b|\bFunction\s*\(/.test(bare)) errors.push(f + ": builds code from strings");
  }
  if (serverFiles.length) {
    if (serverFetch !== 1) errors.push("server/: must name fetch exactly once (the default sender in mfp_passthrough.mjs), found " + serverFetch);
    if (serverSends !== 1) errors.push("server/: the pass-through must call its sender exactly once (one request out per request in), found " + serverSends);
    const route = tree.get("server/mfp_route.mjs") || "";
    for (const h of MFP_API_HOSTS) if (!route.includes('"' + h + '"')) errors.push("server/mfp_route.mjs: must name " + h);
    // The hosts are one frozen declaration, whole: a host joined from pieces
    // ("https://developers...com" + ".example.org") names only MFP's URL in
    // its text and is still another host.
    if (tree.has("server/mfp_route.mjs") && !constText(parse("server/mfp_route.mjs", route), "MFP_UPSTREAM", MFP_UPSTREAM_SOURCE)) {
      errors.push("server/mfp_route.mjs: MFP_UPSTREAM must be the pinned declaration (frozen, MFP's two API hosts as two whole literals)");
    }
    // The one send, read from the syntax tree (a count of "send(" cannot see
    // a loop around it): a direct call in handleMfp, on the route's address,
    // never following a redirect, and not inside a loop, a catch clause or a
    // nested function. handleMfp never calls itself. So: no retry, no replay.
    const P = "server/mfp_passthrough.mjs";
    if (tree.has(P)) {
      const sf = parse(P, tree.get(P));
      const sends = [];
      let selfRefs = 0, sendNames = 0;
      visit(sf, (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "send") sends.push(n);
        if (ts.isIdentifier(n) && n.text === "handleMfp") selfRefs++;
        if (ts.isIdentifier(n) && n.text === "send") sendNames++;
      });
      if (selfRefs !== 1) errors.push(P + ": handleMfp is named " + selfRefs + " times - it must not call itself (a replay)");
      // The sender is its parameter and its one call. Any other mention
      // (const again = send, a second parameter, send passed on) is a way to
      // send twice that the call count cannot see.
      if (sendNames !== 2) errors.push(P + ": the sender is named " + sendNames + " times - only its parameter and the one call may name it (an alias is a second sender)");
      const why = importedOnce(sf, "mfpUpstreamOk", "./mfp_route.mjs");
      if (why) errors.push(P + ": " + why);
      if (sends.length === 1) {
        const call = sends[0];
        let fn = null, inside = null;
        for (let a = call.parent; a; a = a.parent) {
          if (ts.isForStatement(a) || ts.isForOfStatement(a) || ts.isForInStatement(a) || ts.isWhileStatement(a) || ts.isDoStatement(a)) inside = "a loop";
          if (ts.isCatchClause(a)) inside = "a catch clause";
          if (ts.isFunctionLike(a)) { fn = a; break; }
        }
        if (inside) errors.push(P + ": the send sits inside " + inside + " - one request out per request in, never a retry");
        if (!fn || !ts.isFunctionExpression(fn) || !fn.name || fn.name.text !== "handleMfp") errors.push(P + ": the send must be a direct statement of handleMfp, not inside another function");
        const addr = call.arguments[0], opts = call.arguments[1];
        if (!addr || addr.getText(sf) !== "route.upstream") errors.push(P + ": the send's address must be route.upstream");
        // The options are exactly these five plain properties, each once: a
        // spread, a computed key or a second redirect could change what the
        // first one says (the last property of a name wins).
        const props = opts && ts.isObjectLiteralExpression(opts) ? opts.properties : null;
        const plain = props && props.every((q) => (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) && ts.isIdentifier(q.name));
        const names = plain ? props.map((q) => q.name.text) : [];
        const manual = plain && names.length === SEND_OPTIONS.length && SEND_OPTIONS.every((x) => names.includes(x))
          && props.some((q) => ts.isPropertyAssignment(q) && q.name.text === "redirect" && ts.isStringLiteral(q.initializer) && q.initializer.text === "manual");
        if (!manual) errors.push(P + ': the send must pass { redirect: "manual" } with no spread - a redirect is never followed (its options are ' + SEND_OPTIONS.join(", ") + ", each once)");
        // The address is checked on the line before the send: the statement
        // before `let upstream;` and the try that sends is
        // if (!mfpUpstreamOk(route.upstream)) return ...
        let tryStmt = call.parent;
        while (tryStmt && !(ts.isTryStatement(tryStmt) && fn && tryStmt.parent === fn.body)) tryStmt = tryStmt.parent;
        const stmts = fn && fn.body ? fn.body.statements : [];
        const at = tryStmt ? stmts.indexOf(tryStmt) : -1;
        const gate = at >= 2 ? stmts[at - 2] : null;
        const gated = gate && ts.isIfStatement(gate) && !gate.elseStatement && gate.expression.getText(sf).replace(/\s+/g, "") === "!mfpUpstreamOk(route.upstream)"
          && ts.isReturnStatement(gate.thenStatement) && ts.isVariableStatement(stmts[at - 1]) && stmts[at - 1].getText(sf).replace(/\s+/g, " ") === "let upstream;";
        if (!gated) errors.push(P + ": the address must be checked on the line before the send - if (!mfpUpstreamOk(route.upstream)) return ...; let upstream; try { ... send ... }");
      }
    }
    // The account stream's relay: ONE upstream socket per request, built
    // once, on the checked address, never in a loop (it never reconnects).
    const R = MFP_STREAM_RELAY;
    if (tree.has(R)) {
      const sf = parse(R, tree.get(R));
      if (!constText(sf, "MFP_STREAM_UPSTREAM", MFP_STREAM_UPSTREAM_SOURCE)) errors.push(R + ": MFP_STREAM_UPSTREAM must be the pinned declaration (frozen, the stream host's two paths as two whole literals)");
      const news = [], sockets = [], ws = [];
      visit(sf, (n) => {
        if (ts.isNewExpression(n)) { const c = newCallee(n); if (c && ts.isIdentifier(c) && c.text === "Socket") news.push(n); }
        if (ts.isIdentifier(n) && n.text === "Socket") sockets.push(n);
        if (ts.isIdentifier(n) && n.text === "WebSocket") ws.push(n);
      });
      // WebSocket is named once: the default of the Socket option.
      const wsOk = ws.length === 1 && ts.isPropertyAccessExpression(ws[0].parent) && ws[0].parent.getText(sf) === "globalThis.WebSocket"
        && ts.isBindingElement(ws[0].parent.parent) && ws[0].parent.parent.name.getText(sf) === "Socket";
      if (!wsOk) errors.push(R + ": WebSocket must be named once, as the default of the Socket option (Socket = globalThis.WebSocket)");
      // Socket: that option, the typeof check, and the one construction.
      if (sockets.length !== 3) errors.push(R + ": the socket class is named " + sockets.length + " times - only its option, the typeof check and the one construction may name it (an alias is a second socket)");
      const made = news.length === 1 ? news[0] : null;
      let fn = null, inside = null;
      if (made) {
        for (let a = made.parent; a; a = a.parent) {
          if (ts.isCatchClause(a)) inside = "a catch clause";
          if (ts.isFunctionLike(a)) { fn = a; break; }
        }
        if (inLoop(made)) inside = "a loop";
      }
      const direct = made && fn && ts.isFunctionExpression(fn) && fn.name && fn.name.text === "handleMfpStream";
      if (!made || !direct || inside || !made.arguments || !made.arguments[0] || made.arguments[0].getText(sf) !== "route.upstream") {
        errors.push(R + ": must build its upstream socket exactly once, as new Socket(route.upstream, ...) directly in handleMfpStream" + (inside ? " (found inside " + inside + " - the relay never reconnects)" : ""));
      } else {
        // The address is checked before the socket is built: a top-level
        // statement of handleMfpStream, if (!mfpStreamUpstreamOk(route.upstream)) return ...
        const gate = fn.body.statements.find((s) => ts.isIfStatement(s) && !s.elseStatement && s.expression.getText(sf).replace(/\s+/g, "") === "!mfpStreamUpstreamOk(route.upstream)" && ts.isReturnStatement(s.thenStatement));
        if (!gate || gate.end > made.getStart(sf)) errors.push(R + ": the address must be checked before the socket is built - if (!mfpStreamUpstreamOk(route.upstream)) return ...");
        // ... and stays what was checked: the socket's whole text is pinned,
        // `route` is one const (the route decision), is never assigned to,
        // and is only ever read through a property of it.
        const flatR = (n) => n.getText(sf).replace(/\s+/g, "");
        if (flatR(made) !== "newSocket(route.upstream,{headers:{Authorization:authorization}})") errors.push(R + ": the socket must be built as new Socket(route.upstream, { headers: { Authorization: authorization } }) - nothing else may travel with it");
        const routeDecls = [], routeRefs = [];
        visit(fn, (n) => {
          if (!ts.isIdentifier(n) || n.text !== "route") return;
          if (isDeclName(n)) routeDecls.push(n.parent); else if (isValueRef(n)) routeRefs.push(n);
        });
        const routeOk = routeDecls.length === 1 && ts.isVariableDeclaration(routeDecls[0]) && routeDecls[0].initializer
          && flatR(routeDecls[0].initializer) === "mfpStreamRoute(req.method,req.url,authorization)" && (routeDecls[0].parent.flags & ts.NodeFlags.Const) !== 0;
        const routeRead = routeRefs.every((n) => ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n);
        if (!routeOk || !routeRead || assignmentsTo(fn, ["route"]).length) errors.push(R + ": route must be ONE const, mfpStreamRoute(req.method, req.url, authorization), never assigned to and only read through its properties - the address the socket gets is the address that was checked");
        // The key: read once from the request, handed to the route decision
        // and to the socket's Authorization header, and to nothing else (a
        // log line least of all).
        const authRefs = [], authProps = [];
        visit(fn, (n) => {
          if (!ts.isIdentifier(n) || n.text !== "authorization") return;
          if (isDeclName(n)) return;
          if (isPropName(n)) authProps.push(n); else authRefs.push(n);
        });
        const inside = (n, outer) => !!outer && n.getStart(sf) >= outer.getStart(sf) && n.end <= outer.end;
        const routeCall = routeDecls.length === 1 ? routeDecls[0].initializer : null;
        const authOk = authRefs.length === 2 && authRefs.some((n) => inside(n, routeCall)) && authRefs.some((n) => inside(n, made))
          && authProps.length === 1 && authProps[0].parent.getText(sf) === "req.headers.authorization" && ts.isVariableDeclaration(authProps[0].parent.parent);
        if (!authOk) errors.push(R + ": authorization must be named only as its one declaration (const authorization = req.headers.authorization), in the route decision and in the socket's header - never in a log line or a second header (found " + authRefs.length + " uses, " + authProps.length + " reads of the header)");
        // The request's headers are read one by one, never handed on whole;
        // its url only for the logged path and the route decision.
        let bareHeaders = 0, urls = 0;
        visit(fn, (n) => {
          if (ts.isPropertyAccessExpression(n) && n.getText(sf) === "req.headers") {
            const p = n.parent;
            const ok = (ts.isPropertyAccessExpression(p) && p.expression === n) || (ts.isElementAccessExpression(p) && p.expression === n && ts.isStringLiteral(p.argumentExpression));
            if (!ok) bareHeaders++;
          }
          if (ts.isPropertyAccessExpression(n) && n.getText(sf) === "req.url") urls++;
        });
        if (bareHeaders) errors.push(R + ": req.headers is read whole - each header is read by its own name");
        if (urls !== 2) errors.push(R + ": req.url is read " + urls + " times - only for the logged path (no query) and the route decision");
      }
      // Nothing is indexed by a built name anywhere in the relay: its five
      // tables by a plain name, the request's headers by a string literal.
      const TABLES = ["STREAM_PATHS", "QUERY", "seen", "KEY_SHAPE", "MFP_STREAM_UPSTREAM"];
      visit(sf, (n) => {
        if (ts.isElementAccessExpression(n)) {
          const obj = n.expression.getText(sf), arg = n.argumentExpression;
          // (a numeric index, x.split("?")[0], names no method)
          const ok = (TABLES.includes(obj) && ts.isIdentifier(arg)) || (obj === "req.headers" && ts.isStringLiteral(arg)) || ts.isNumericLiteral(arg);
          if (!ok) errors.push(R + ":" + lineOf(sf, n) + ": indexes " + n.getText(sf).replace(/\s+/g, "").slice(0, 40) + " - only its tables (by a plain name) and req.headers (by a string literal) may be indexed here");
        }
        if (ts.isIdentifier(n) && n.text === "Reflect") errors.push(R + ":" + lineOf(sf, n) + ": names Reflect - a way to call a method without naming it");
      });
    }
    // The relay's handler is called once per request, in app.mjs; serve.mjs
    // makes it once and hands it to makeApp.
    {
      const refsOf = (f, name) => {
        const refs = [];
        if (tree.has(f)) visit(parse(f, tree.get(f)), (n) => { if (ts.isIdentifier(n) && n.text === name) refs.push(n); });
        return refs;
      };
      const callee = (n) => ts.isCallExpression(n.parent) && n.parent.expression === n;
      const inApp = refsOf("server/app.mjs", "handleMfpStream");
      const calls = inApp.filter(callee);
      if (tree.has(R) && tree.has("server/app.mjs") && (calls.length !== 1 || calls.some(inLoop))) errors.push("server/app.mjs: the stream relay's handler is called " + calls.length + " times - once per request, outside any loop");
      for (const f of serverFiles) {
        if (f === "server/app.mjs" || f === R) continue;
        const refs = refsOf(f, "handleMfpStream");
        const okServe = f === "server/serve.mjs" && refs.length === 2 && !refs.some(callee);
        if (refs.length && !okServe) errors.push(f + ": names the stream relay's handler " + refs.length + " times - only app.mjs calls it; serve.mjs declares it and hands it to makeApp, once each");
      }
      if (tree.has("server/serve.mjs") && tree.has(R)) {
        const refs = refsOf("server/serve.mjs", "makeMfpStreamRelay");
        if (refs.length !== 2 || refs.filter(callee).length !== 1) errors.push("server/serve.mjs: makeMfpStreamRelay is named " + refs.length + " times - imported once and called once (one relay, mounted once)");
      }
    }
    // The mounting site calls the handler once per request. In ALL of
    // server/ there is one call of it, in app.mjs (which names it as its
    // parameter and in that call, outside any loop). serve.mjs makes the
    // handler once and hands it to makeApp once, and never calls it: a
    // second mount there (server.on("request", ...)) would send every write
    // twice. The rule does not go away with the file it reads.
    const A = "server/app.mjs", S = "server/serve.mjs";
    const named = (f, name) => {
      const refs = [];
      if (tree.has(f)) visit(parse(f, tree.get(f)), (n) => { if (ts.isIdentifier(n) && n.text === name) refs.push(n); });
      return refs;
    };
    const isCallee = (n) => ts.isCallExpression(n.parent) && n.parent.expression === n;
    if (!tree.has(A)) errors.push(A + ": missing - it is the one place the pass-through's handler is called");
    else {
      const refs = named(A, "handleMfp");
      const calls = refs.filter(isCallee);
      let looped = false;
      for (const c of calls) for (let a = c.parent; a && !ts.isFunctionLike(a); a = a.parent) {
        if (ts.isForStatement(a) || ts.isForOfStatement(a) || ts.isForInStatement(a) || ts.isWhileStatement(a) || ts.isDoStatement(a)) looped = true;
      }
      if (refs.length !== 2 || calls.length !== 1 || looped) errors.push(A + ": the handler is named " + refs.length + " times and called " + calls.length + " - it is called once per request (its parameter, one call, no loop)");
    }
    for (const f of serverFiles) {
      if (f === A || f === P) continue;
      const refs = named(f, "handleMfp");
      const okServe = f === S && refs.length === 2 && !refs.some(isCallee);
      if (refs.length && !okServe) errors.push(f + ": names the pass-through's handler " + refs.length + " times - only app.mjs calls it; serve.mjs declares it and hands it to makeApp, once each");
    }
    if (tree.has(S)) {
      for (const name of ["makeMfpHandler", "makeApp"]) {
        const refs = named(S, name);
        if (refs.length !== 2 || refs.filter(isCallee).length !== 1) errors.push(S + ": " + name + " is named " + refs.length + " times - imported once and called once (one handler, mounted once)");
      }
    }
  }

  // No real addresses or keys anywhere (src, test, docs, fixtures). Allowed:
  // the SDK's published test key and its address, and obviously fake hex
  // (a single repeated digit, or a 0x000000... prefix).
  const SDK_KEY = "0123456789012345678901234567890123456789012345678901234567890123";
  const SDK_ADDR = "14791697260e4c9a71f18484c9f997b308e59325";
  const fake = (h) => /^(.)\1*$/.test(h) || /^0{6}/.test(h) || /^(0123456789){2}/.test(h) || /^(abcdef|deadbeef|cafe|beef)/i.test(h);
  for (const f of tree.keys()) {
    // The SDK's own published signing vectors (r / s values, action hashes and
    // the SDK's vault-address vector) live in this one test file.
    if (f === "test/hl_sign.test.mjs") continue;
    // hl_sign.ts carries the SDK's dummy-vector r / s for the device self-test.
    const skipSdkRs = f === "src/lib/hl_sign.ts";
    const text = tree.get(f);
    for (const m of text.matchAll(/0x([0-9a-fA-F]{40,64})\b/g)) {
      const h = m[1].toLowerCase();
      if (h === SDK_KEY || h === SDK_ADDR || fake(h)) continue;
      if (skipSdkRs) continue;
      errors.push(f + ": a hex address or key that is not a known test vector or an obviously fake pattern");
    }
    for (const m of text.matchAll(/\bfp_(live|test)_[A-Za-z0-9_-]{24,}/g)) {
      if (!/^fp_(live|test)_(x+|a+|abcdefghijklmnop12345678|fake[a-z0-9_-]*|[a-z]{8}12345678)$/i.test(m[0])) errors.push(f + ": an MFP key-shaped string that is not an obvious test fake: " + m[0].slice(0, 12) + "...");
    }
  }

  return { errors, scanned: files.length };
}

module.exports = { check, loadTree, stripComments };

if (require.main === module) {
  const { errors, scanned } = check(loadTree());
  if (errors.length) {
    console.error("exchange guard FAILED:");
    for (const e of errors) console.error("- " + e);
    process.exit(1);
  }
  console.log("exchange guard OK: " + scanned + " source files scanned");
}
