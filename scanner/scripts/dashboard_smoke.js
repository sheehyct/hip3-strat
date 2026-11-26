"use strict";

// Dashboard browser-smoke harness. Drives headless Chrome
// over CDP against a serving worker and checks the committed acceptance
// criteria: desktop + 390px viewports, both Simple/Regular modes,
// preference persistence across reload, rendered row count matching the
// current payload, no runtime exceptions, and no failed application
// requests (favicon 404 is known-cosmetic and excluded).
//
// Zero dependencies; needs node >= 22 (global fetch + WebSocket) and a
// local Chrome. Run it against a LOG_ONLY local boot or production:
//   npm run smoke                                   (default local :8787)
//   SMOKE_URL=https://<your-worker-host>/ npm run smoke
// Env: SMOKE_URL (default http://127.0.0.1:8787/), CHROME_PATH,
//      SMOKE_PORT (CDP port, default 9333), SMOKE_OUT (screenshot dir,
//      default <os tmp>/hip3-smoke - never the repo).
//
// Exit 0 = green; nonzero = a criterion failed (message on stderr).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DASH = process.env.SMOKE_URL || "http://127.0.0.1:8787/";
const CDP_PORT = parseInt(process.env.SMOKE_PORT || "9333", 10);
const OUT = process.env.SMOKE_OUT || path.join(os.tmpdir(), "hip3-smoke");

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  throw new Error("Chrome not found - set CHROME_PATH");
}

let msgId = 0;
const pending = new Map();
const errors = [];
const netFails = [];
const exchangeReqs = []; // any browser request to the exchange (must be ZERO in hosted mode)
let ws, chrome;

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitRows(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const n = await evaluate("document.querySelectorAll('#tbody > tr').length");
    if (n > 0) return n;
    if (Date.now() - t0 > timeoutMs) throw new Error("rows never rendered");
    await sleep(1000);
  }
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64"));
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hip3-smoke-profile-"));
  chrome = spawn(findChrome(), [
    "--headless=new", "--disable-gpu", "--no-first-run",
    "--remote-debugging-port=" + CDP_PORT,
    "--user-data-dir=" + profile, "about:blank"
  ], { stdio: "ignore" });

  // CDP endpoint comes up asynchronously
  let list = null;
  for (let i = 0; i < 30 && !list; i++) {
    await sleep(500);
    try { list = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json")).json(); } catch (e) {}
  }
  if (!list) throw new Error("CDP endpoint never came up on :" + CDP_PORT);
  const page = list.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method === "Runtime.exceptionThrown") {
      errors.push("EXCEPTION: " + JSON.stringify(m.params.exceptionDetails.exception));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push("console.error: " + m.params.args.map((a) => a.value || a.description).join(" "));
    } else if (m.method === "Network.responseReceived") {
      const r = m.params.response;
      if (r.status >= 400 && r.url.indexOf("favicon") < 0) netFails.push(r.status + " " + r.url);
    } else if (m.method === "Network.requestWillBeSent") {
      if (m.params.request.url.indexOf("api.hyperliquid.xyz") >= 0)
        exchangeReqs.push(m.params.request.url);
    }
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

  // -------- desktop regular --------
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: DASH });
  await sleep(3000);
  await waitRows(120000);
  await sleep(2000); // bootstrap seed + first render settle
  const payloadCoins = await evaluate("state.order.length");
  const showing = await evaluate("document.querySelectorAll('#tbody > tr').length");
  console.log("desktop regular: payload coins " + payloadCoins + " | rendered rows " + showing);
  if (showing !== payloadCoins) throw new Error("row count mismatch: " + showing + " vs " + payloadCoins);
  // Served pages must enter HOSTED mode: worker-authoritative analysis and
  // metrics, zero exchange requests (asserted at the end of the run).
  const dataMode = await evaluate("state.dataMode");
  const hostedRev = await evaluate("state.hostedRev");
  console.log("data mode: " + dataMode + " | worker rev " + hostedRev +
    " | exchange requests so far: " + exchangeReqs.length);
  if (dataMode !== "hosted") throw new Error("served page did not enter hosted mode: " + dataMode);
  await shot("smoke_desktop_regular.png");

  // -------- scroll holds across re-renders with a focused row --------------
  // Reported 2026-08-16: rows are tabindex="0", so one click leaves a
  // row focused, and the render loop's focus restoration called focus()
  // WITHOUT preventScroll - every ~4s re-render yanked the viewport back to
  // the focused row (reproduced: scrollY 4000 -> 224 within a second). This
  // criterion focuses a row exactly like a click does, scrolls away, sits
  // through two-plus renders, and requires the viewport to HOLD.
  await evaluate("document.querySelectorAll('tr.row')[2].focus(); window.scrollTo(0, 4000); 'set'");
  await sleep(9000);
  const heldY = await evaluate("window.scrollY");
  const focusHeld = await evaluate(
    "document.activeElement && document.activeElement.closest && !!document.activeElement.closest('tr.row')");
  console.log("scroll hold: y " + heldY + " after 9s with a focused row | row focus survived " + focusHeld);
  if (heldY < 3000) throw new Error("viewport yanked back to the focused row during re-render: y=" + heldY);
  if (!focusHeld) throw new Error("focus restoration stopped surviving the re-render");
  // Focus IDENTITY (code review 2026-08-16 F6): a focused star must be
  // restored as the STAR, not demoted to its row - a demotion silently
  // turns the next Enter/Space from toggle-favorite into expand-row.
  await evaluate("document.querySelector('tr.row .star').focus({preventScroll:true}); 'star'");
  await sleep(6000); // at least one re-render
  const starHeld = await evaluate(
    "!!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('star'))");
  console.log("star focus identity survived re-render: " + starHeld);
  if (!starHeld) throw new Error("focused star was demoted to its row by the re-render");
  await evaluate("document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); 'reset'");

  // -------- alert scope + universe-aware JSON link (code review lane 1) ----
  // A served dashboard must learn the worker's alert scope (one /health fetch
  // at load) and render the status-bar chip, and the JSON link must carry the
  // active universe like the CSV export always did. getAttribute, not .href -
  // the property returns the resolved ABSOLUTE url, the attribute what we set.
  const scopeKnown = await evaluate("Array.isArray(state.alertScope)");
  const chipShown = await evaluate("document.getElementById('statusbar').textContent.indexOf('alerts') >= 0");
  const jsonHref = await evaluate("document.getElementById('jsonapi').getAttribute('href')");
  const uniNow = await evaluate("state.universe");
  console.log("alert scope: known " + scopeKnown + " | chip " + chipShown + " | json link " + jsonHref);
  if (!scopeKnown) throw new Error("served dashboard never learned the alert scope from /health");
  if (!chipShown) throw new Error("alert-scope chip missing from the status bar");
  if (jsonHref !== "/api/briefing/latest.json?uni=" + encodeURIComponent(uniNow))
    throw new Error("JSON link does not carry the active universe: " + jsonHref);

  // -------- desktop simple + persistence --------
  await evaluate("setView('simple')");
  await sleep(1500);
  const hasSimple = await evaluate("document.getElementById('tbody').innerHTML.indexOf('simple-row') >= 0");
  const stored = await evaluate("localStorage.getItem('hip3-view')");
  console.log("desktop simple: markup " + hasSimple + " | stored view " + stored);
  if (!hasSimple || stored !== "simple") throw new Error("simple mode did not engage/persist");
  await shot("smoke_desktop_simple.png");

  await send("Page.navigate", { url: DASH });
  await sleep(3000);
  await waitRows(120000);
  const viewAfter = await evaluate("state.view");
  const stillSimple = await evaluate("document.getElementById('tbody').innerHTML.indexOf('simple-row') >= 0");
  console.log("after reload: view " + viewAfter + " | simple markup " + stillSimple);
  if (viewAfter !== "simple" || !stillSimple) throw new Error("view persistence failed");

  // -------- simple-view sort wiring --------
  // Bug report 2026-07-26: "Simple view cannot sort by progress or percent
  // change; price is the only working sort". Both causes were
  // SILENT: Progress carried an empty data-k so its header click was a no-op,
  // and 24h % had no header at all because it shares the Price cell. Neither
  // threw, neither logged, and every rendering check above still passed - so
  // rendering assertions alone cannot catch this class of bug. These check the
  // wiring itself.
  await evaluate("setView('simple')");
  await sleep(1200);

  // D2-c: Progress rides the Focus group's cycling header (focus -> prog).
  // The default sort is focus, so one click lands on prog descending.
  const focusCyc = "#thead th[data-cycle=\\\"focus,prog\\\"]";
  await evaluate("document.querySelector('" + focusCyc + "').click()");
  await sleep(800);
  const progKey = await evaluate("state.sortKey");
  if (progKey !== "prog") throw new Error("Focus cycle did not reach the progress sort: " + progKey);

  // Rows with no comparable progress (setups showing "% away", INVAL, empty)
  // must sink in BOTH directions - the whole point of not using the file's
  // -Infinity idiom, which would float them to the top on reversal. Assert the
  // partition directly: once a row without a progress bar appears, no row WITH
  // one may follow. Checked under both directions.
  const partitioned =
    "(function(){var t=[].slice.call(document.querySelectorAll('#tbody > tr.simple-row'));" +
    "if(t.length < 2) return 'too-few';" +
    "var seenBlank = false;" +
    "for(var i=0;i<t.length;i++){" +
    "  var has = !!t[i].querySelector('.scan-mag');" +
    "  if(!has) seenBlank = true;" +
    "  else if(seenBlank) return 'row ' + i + ' has progress after a blank';" +
    "}" +
    "return 'ok';})()";
  const partDesc = await evaluate(partitioned);
  if (partDesc !== "ok") throw new Error("progress sort (desc) not partitioned: " + partDesc);

  // Two more clicks wrap the cycle (prog -> focus flipped -> prog flipped),
  // landing on progress ASCENDING - the direction the partition must hold in.
  await evaluate("document.querySelector('" + focusCyc + "').click()");
  await sleep(400);
  await evaluate("document.querySelector('" + focusCyc + "').click()");
  await sleep(800);
  const progKey2 = await evaluate("state.sortKey");
  const progDir = await evaluate("state.sortDir");
  if (progKey2 !== "prog" || progDir !== 1)
    throw new Error("Focus cycle wrap did not reach progress ascending: " + progKey2 + " dir " + progDir);
  const partAsc = await evaluate(partitioned);
  if (partAsc !== "ok") throw new Error("progress sort (reversed) not partitioned: " + partAsc);
  console.log("simple sort: progress key " + progKey + " | reversed dir " + progDir +
    " | no-progress rows sink both ways");

  // The Market header cycles px -> chg -> trend. A no-op click here is
  // exactly the reported symptom, so assert the key actually moves.
  const cycSel = "#thead th[data-cycle=\\\"px,chg,trend\\\"]";
  const cycExists = await evaluate("!!document.querySelector('" + cycSel + "')");
  if (!cycExists) throw new Error("Command view has no cycling Market header");
  await evaluate("document.querySelector('" + cycSel + "').click()");
  await sleep(600);
  const k1 = await evaluate("state.sortKey");
  await evaluate("document.querySelector('" + cycSel + "').click()");
  await sleep(600);
  const k2 = await evaluate("state.sortKey");
  console.log("simple sort: price cycle -> " + k1 + " -> " + k2);
  if (k1 === k2) throw new Error("price header cycle did not advance: stuck on " + k1);
  if ([k1, k2].indexOf("chg") < 0) throw new Error("price cycle never reached 24h % (chg)");
  if ([k1, k2].indexOf("px") < 0) throw new Error("price cycle never reached price (px)");
  // Full three-key wrap (audit D2 F12): the third stop is trend, and
  // wrapping past it returns to px with the DIRECTION flipped. The trend
  // comparator must actually order rows while it is the active key.
  const d2 = await evaluate("state.sortDir");
  await evaluate("document.querySelector('" + cycSel + "').click()");
  await sleep(600);
  const k3 = await evaluate("state.sortKey");
  const trendMono = await evaluate(
    "(function(){ var vs = rowsSorted().map(function(r){ return simpleTrendPct(r.coin); })" +
    ".filter(function(v){ return v !== null && isFinite(v); });" +
    " for(var i=1;i<vs.length;i++) if(vs[i] > vs[i-1] + 1e-9) return 'bad@'+i; return 'ok('+vs.length+')'; })()");
  await evaluate("document.querySelector('" + cycSel + "').click()");
  await sleep(600);
  const k4 = await evaluate("state.sortKey");
  const d4 = await evaluate("state.sortDir");
  console.log("simple sort: wrap " + k2 + " -> " + k3 + " -> " + k4 +
    " | dir " + d2 + " -> " + d4 + " | trend order " + trendMono);
  if (k3 !== "trend") throw new Error("cycle third stop must be trend, got " + k3);
  if (!/^ok/.test(trendMono)) throw new Error("trend comparator did not order rows: " + trendMono);
  if (k4 !== "px" || d4 !== -d2) throw new Error("wrap must return to px with direction flipped: " + k4 + "/" + d4);

  // The Trend column follows the FASTEST ACTIVE timeframe.
  // The old column was hardcoded to 15m and rendered a perfectly good sparkline
  // while ignoring the selection entirely - so "a sparkline appeared" proves
  // nothing here. Toggle the fastest TF off and assert the column RESPONDS.
  const tfSel = '.tfbtn[data-tf="15m"]';
  // D2-c: the trend label lives in the Market group's cycling header.
  const trendTh = "document.querySelector('#thead th[data-cycle=\\\"px,chg,trend\\\"]')";
  const tfBtnExists = await evaluate("!!document.querySelector('" + tfSel + "')");
  if (!tfBtnExists) throw new Error("no 15m TF toggle to drive the trend column with");
  const trendBefore = await evaluate("trendTF() && trendTF().id");
  const headBefore = await evaluate(trendTh + ".textContent");
  await evaluate("document.querySelector('" + tfSel + "').click()");
  await sleep(900);
  const trendAfter = await evaluate("trendTF() && trendTF().id");
  const headAfter = await evaluate(trendTh + ".textContent");
  console.log("trend tf: " + trendBefore + " -> " + trendAfter +
    ' | header "' + String(headBefore).trim() + '" -> "' + String(headAfter).trim() + '"');
  if (trendAfter === trendBefore)
    throw new Error("trend TF did not follow the toggle: stuck on " + trendBefore);
  if (headAfter === headBefore)
    throw new Error("trend header did not re-render after the TF toggle: " + headBefore);
  await evaluate("document.querySelector('" + tfSel + "').click()");   // restore 15m
  await sleep(900);
  if ((await evaluate("trendTF() && trendTF().id")) !== trendBefore)
    throw new Error("re-enabling 15m did not restore the trend TF");

  // -------- Tier 1: composable filters + matched-signal focus --------
  // The Actionable preset must set stages=[live], the rendered rows must
  // equal the model's own filtered count, the choice must persist, and All
  // must restore the whole board. Row counts vary with the market; the
  // render-vs-model equality is the criterion, not a fixed number.
  await evaluate("document.querySelector('.fbtn[data-preset=\\\"actionable\\\"]').click()");
  await sleep(800);
  const stagesNow = await evaluate("state.filters.stages.join(',')");
  if (stagesNow !== "live") throw new Error("Actionable preset did not set stages=[live]: " + stagesNow);
  const actionableRows = await evaluate("document.querySelectorAll('#tbody > tr.simple-row').length");
  const modelRows = await evaluate("rowsSorted().length");
  if (actionableRows !== modelRows)
    throw new Error("filtered render mismatch: " + actionableRows + " rendered vs " + modelRows + " in the model");
  const storedFilters = await evaluate("localStorage.getItem('hip3-filters')");
  if (!storedFilters || storedFilters.indexOf('"live"') < 0)
    throw new Error("filter state did not persist: " + storedFilters);
  console.log("tier1: actionable rows " + actionableRows + "/" + payloadCoins + " | stages [" + stagesNow + "] persisted");
  await evaluate("document.querySelector('.fbtn[data-preset=\\\"all\\\"]').click()");
  await sleep(800);
  const allRows = await evaluate("document.querySelectorAll('#tbody > tr.simple-row').length");
  if (allRows !== payloadCoins) throw new Error("All preset did not restore the full board: " + allRows);

  // -------- D2-a: dropdown chips + layout presets --------
  // The control stacks collapsed into five chip-panel dropdowns. The
  // criteria: panels start closed, exactly one opens at a time, the badge
  // counts track hidden filter state, filtering still matches the model
  // through a panel, and a saved layout preset round-trips a TF change.
  const chips = ["chip-filters", "chip-patterns", "chip-tfs", "colsbtn", "chip-layout"];
  const chipsThere = await evaluate(
    "[" + chips.map(function (c) { return "'" + c + "'"; }).join(",") + "]" +
    ".every(function(id){ return !!document.getElementById(id); })");
  if (!chipsThere) throw new Error("D2-a chips missing from the header");
  const anyOpen = await evaluate(
    "['panel-filters','panel-patterns','panel-tfs','colpills','panel-layout']" +
    ".some(function(id){ return !document.getElementById(id).hidden; })");
  if (anyOpen) throw new Error("a dropdown panel started open");
  await evaluate("document.getElementById('chip-patterns').click()");
  await sleep(200);
  if (await evaluate("document.getElementById('panel-patterns').hidden"))
    throw new Error("Patterns chip did not open its panel");
  await evaluate("document.getElementById('chip-filters').click()");
  await sleep(200);
  const oneAtATime = await evaluate(
    "document.getElementById('panel-patterns').hidden && !document.getElementById('panel-filters').hidden");
  if (!oneAtATime) throw new Error("panels are not exclusive: filters open did not close patterns");
  await evaluate("document.getElementById('chip-patterns').click()");
  await sleep(200);
  await evaluate("document.querySelector('.fbtn[data-pat=\\\"22\\\"]').click()");
  await sleep(600);
  const patCount = await evaluate("document.getElementById('cnt-patterns').textContent");
  const patHidden = await evaluate("document.getElementById('cnt-patterns').hidden");
  if (patHidden || patCount !== "1")
    throw new Error("Patterns badge did not track the selection: hidden=" + patHidden + " count=" + patCount);
  const patRows = await evaluate("document.querySelectorAll('#tbody > tr.simple-row').length");
  const patModel = await evaluate("rowsSorted().length");
  if (patRows !== patModel)
    throw new Error("pattern filter render mismatch through the panel: " + patRows + " vs " + patModel);
  await evaluate("document.getElementById('patclear').click()");
  await sleep(600);
  if (!(await evaluate("document.getElementById('cnt-patterns').hidden")))
    throw new Error("Clear did not empty the pattern selection badge");
  console.log("d2a chips: exclusive panels | pattern badge 1 -> clear | rows " + patRows + " matched model");
  // Layout preset round-trip: capture the default board, change a TF,
  // apply the preset back, and the TF change must revert.
  const tfSumBefore = await evaluate("document.getElementById('sum-tfs').textContent");
  await evaluate("document.getElementById('layoutname').value = 'smoke-preset'");
  await evaluate("document.getElementById('layoutsave').click()");
  await sleep(300);
  const layoutSum = await evaluate("document.getElementById('sum-layout').textContent");
  if (layoutSum !== "smoke-preset") throw new Error("saved preset not reflected in the Layout chip: " + layoutSum);
  await evaluate("document.querySelector('.tfbtn[data-tf=\\\"1h\\\"]').click()");
  await sleep(600);
  const dirtySum = await evaluate("document.getElementById('sum-layout').textContent");
  if (dirtySum !== "Custom") throw new Error("TF change did not mark the preset dirty: " + dirtySum);
  const tfSumChanged = await evaluate("document.getElementById('sum-tfs').textContent");
  if (tfSumChanged === tfSumBefore) throw new Error("Timeframes summary did not follow the toggle");
  const storedTfs = await evaluate("localStorage.getItem('hip3-tfs')");
  if (!storedTfs || storedTfs.indexOf("1h") >= 0)
    throw new Error("TF persistence did not record the 1h toggle-off: " + storedTfs);
  await evaluate("document.getElementById('chip-layout').click()");
  await sleep(200);
  await evaluate("document.querySelector('#layoutlist .lapply').click()");
  await sleep(800);
  const tfSumRestored = await evaluate("document.getElementById('sum-tfs').textContent");
  const appliedSum = await evaluate("document.getElementById('sum-layout').textContent");
  if (tfSumRestored !== tfSumBefore)
    throw new Error("applying the preset did not restore the TF set: " + tfSumRestored + " vs " + tfSumBefore);
  if (appliedSum !== "smoke-preset") throw new Error("apply did not mark the preset current: " + appliedSum);
  await evaluate("document.querySelector('#layoutlist .ldel').click()");
  await sleep(300);
  const listEmpty = await evaluate("document.getElementById('layoutlist').children.length === 0");
  const delSum = await evaluate("document.getElementById('sum-layout').textContent");
  if (!listEmpty || delSum !== "Custom")
    throw new Error("delete did not clear the preset: empty=" + listEmpty + " sum=" + delSum);
  await evaluate("(function(){ var e = new KeyboardEvent('keydown', {key:'Escape'}); document.dispatchEvent(e); })()");
  await sleep(200);
  const escClosed = await evaluate(
    "['panel-filters','panel-patterns','panel-tfs','colpills','panel-layout']" +
    ".every(function(id){ return document.getElementById(id).hidden; })");
  if (!escClosed) throw new Error("Escape did not close the open panel");
  console.log("d2a layout: save -> dirty on TF change -> apply restores -> delete | esc closes");

  // -------- Day % column (chgUtc as a Columns toggle, design decision 2026-09-13) ----
  // The worker has served chgUtc since 2026-08-04; the dashboard now renders
  // it beside 24h % behind ONE Columns pill that defaults visible. Criteria:
  // the sort chip lists the key; at desktop width the Regular header carries
  // "Day %" while the pill is on, the pill toggles header AND cells off and
  // back on, and the hidden set persists through localStorage.
  const dayKeyListed = await evaluate("!!document.querySelector('#panel-sort [data-sortkey=\\\"chgutc\\\"]')");
  if (!dayKeyListed) throw new Error("sort chip does not list the Day % key");
  await evaluate("setView('regular')");
  await sleep(1000);
  const dayHead = await evaluate(
    "(function(){ var th = document.querySelector('#thead th.col-chgutc'); return th ? th.textContent.trim() : 'absent'; })()");
  if (dayHead !== "Day %") throw new Error("Regular header lacks the Day % column while on: " + dayHead);
  const dayCells = await evaluate("document.querySelectorAll('#tbody > tr.row td.col-chgutc').length");
  if (dayCells !== payloadCoins) throw new Error("Day % cells " + dayCells + " vs rows " + payloadCoins);
  const dayPill = await evaluate("document.querySelector('#colpills .fbtn[data-col=\\\"chgutc\\\"]').classList.contains('on')");
  if (!dayPill) throw new Error("Day % pill is not ON by default");
  await evaluate("document.getElementById('colsbtn').click()");
  await sleep(200);
  if (await evaluate("document.getElementById('colpills').hidden")) throw new Error("Columns panel did not open");
  await evaluate("document.querySelector('#colpills .fbtn[data-col=\\\"chgutc\\\"]').click()");
  await sleep(600);
  const dayHeadOff = await evaluate("!!document.querySelector('#thead th.col-chgutc')");
  const dayCellsOff = await evaluate("document.querySelectorAll('#tbody > tr.row td.col-chgutc').length");
  const dayStored = await evaluate("localStorage.getItem('hip3-cols')");
  if (dayHeadOff || dayCellsOff !== 0)
    throw new Error("toggling Day % off left header=" + dayHeadOff + " cells=" + dayCellsOff);
  if (!dayStored || dayStored.indexOf("chgutc") < 0)
    throw new Error("Day % hidden state did not persist: " + dayStored);
  await evaluate("document.querySelector('#colpills .fbtn[data-col=\\\"chgutc\\\"]').click()");
  await sleep(600);
  const dayHeadBack = await evaluate("!!document.querySelector('#thead th.col-chgutc')");
  const dayStoredBack = await evaluate("localStorage.getItem('hip3-cols')");
  if (!dayHeadBack) throw new Error("toggling Day % back on did not restore the header");
  if (dayStoredBack && dayStoredBack.indexOf("chgutc") >= 0)
    throw new Error("Day % still in the persisted hidden set after re-enable: " + dayStoredBack);
  // Value honesty: every cell is either the '-' unknown or a signed percent.
  const dayCellShape = await evaluate(
    "(function(){ var t=[].slice.call(document.querySelectorAll('#tbody > tr.row td.col-chgutc'));" +
    " var known=0; for(var i=0;i<t.length;i++){ var s=t[i].textContent.trim();" +
    " if(s==='-') continue; if(!/^[+-]\\d+\\.\\d{2}%$/.test(s)) return 'bad:'+s; known++; }" +
    " return 'ok:'+known+'/'+t.length; })()");
  if (!/^ok:/.test(dayCellShape)) throw new Error("Day % cell renders something other than '-' or +x.xx%: " + dayCellShape);
  await evaluate("(function(){ var e = new KeyboardEvent('keydown', {key:'Escape'}); document.dispatchEvent(e); })()");
  await sleep(200);
  await evaluate("setView('simple')");
  await sleep(800);
  const dayLine = await evaluate("document.querySelectorAll('#tbody > tr.simple-row .g-day').length");
  if (dayLine !== payloadCoins) throw new Error("Command Market stack Day % lines " + dayLine + " vs rows " + payloadCoins);
  console.log("day %: chip lists key | Regular header on -> off -> on with persistence | cells " +
    dayCellShape.slice(3) + " known | Command stack lines " + dayLine);

  // -------- D2-b: Favs cross-universe view --------
  // Star one xyz coin and one perps coin BY NAME (the perps universe is not
  // loaded yet - that is the lazy-load path under test). Entering the Favs
  // view must render the xyz favorite immediately, pull the perps universe
  // from the worker without a reload, and relabel the stats honestly; a
  // universe click must exit with the full board intact.
  // The perps leg needs a worker that TRACKS perps (production does; a
  // default local boot is xyz-only). Skip it VISIBLY when absent - boot
  // with UNIVERSES=xyz,perps for the full gate.
  let workerUnis = [];
  try { workerUnis = (await (await fetch(DASH + "health")).json()).universes || []; } catch (e) {}
  const perpsTracked = workerUnis.indexOf("perps") >= 0;
  const favTarget = perpsTracked ? 2 : 1;
  await evaluate("toggleFav(state.order[0]);" + (perpsTracked ? " toggleFav('BTC');" : "") + " 'starred'");
  await evaluate("document.getElementById('favsbtn').click()");
  await sleep(1200);
  const favStats = await evaluate("document.getElementById('stats').textContent");
  if (favStats.indexOf("Favorites") < 0)
    throw new Error("Favs view stats did not relabel to Favorites: " + favStats);
  let favModel = 0;
  for (let i = 0; i < 20; i++) {
    favModel = await evaluate("rowsSorted().length");
    if (favModel === favTarget) break;
    await sleep(1500);
  }
  if (favModel !== favTarget)
    throw new Error("Favs view rows never settled (lazy load): model rows " + favModel + " vs " + favTarget);
  if (perpsTracked) {
    const favBtc = await evaluate("rowsSorted().some(function(r){ return r.coin.name === 'BTC'; })");
    if (!favBtc) throw new Error("BTC favorite absent from the Favs rows after the perps load");
  }
  // The model can lead the DOM by one render beat (coins land in
  // state.coins before the load-completion repaint); give it one.
  await sleep(1000);
  const favRendered = await evaluate("document.querySelectorAll('#tbody > tr.simple-row').length");
  if (favRendered !== favTarget)
    throw new Error("Favs view render mismatch: " + favRendered + " rendered vs " + favTarget + " in the model");
  console.log("d2b favs: " + (perpsTracked
    ? "xyz + lazy-loaded perps on one page | rendered " + favRendered + "/2"
    : "xyz-only worker - perps lazy-load leg SKIPPED (boot with UNIVERSES=xyz,perps for the full gate) | rendered " + favRendered + "/1")
    + " | stats relabeled");
  await evaluate("document.querySelector('[data-uni=\\\"xyz\\\"]').click()");
  await sleep(800);
  const favsExited = await evaluate("state.favsView === false");
  const boardBack = await evaluate("document.querySelectorAll('#tbody > tr.simple-row').length");
  if (!favsExited || boardBack !== payloadCoins)
    throw new Error("universe click did not exit Favs cleanly: exited=" + favsExited + " rows=" + boardBack);
  await evaluate("toggleFav(state.order[0]);" + (perpsTracked ? " toggleFav('BTC');" : "") + " 'unstarred'");
  const favsClean = await evaluate("state.favs.length");
  if (favsClean !== 0) throw new Error("smoke favorites were not cleaned up: " + favsClean);

  // -------- D2-d: detail drawer + TV handoff --------
  // Command-view row activation opens the drawer; the TV link must route
  // through the TESTED symbol rule (tvHref); Escape closes; and the
  // Regular view keeps its inline expansion untouched.
  await evaluate("document.querySelector('#tbody > tr.simple-row').click()");
  await sleep(600);
  const drawerOpen = await evaluate("!document.getElementById('drawer').hidden && state.drawer !== null");
  if (!drawerOpen) throw new Error("Command-view row click did not open the drawer");
  const drawerSym = await evaluate("state.coins[state.drawer].sym");
  const drawerNames = await evaluate("document.querySelector('#drawer .dr-sym').textContent");
  if (drawerNames !== drawerSym)
    throw new Error("drawer names the wrong coin: " + drawerNames + " vs " + drawerSym);
  const tvOk = await evaluate(
    "(function(){var a=document.querySelector('#drawer .dr-tv');if(!a)return 'missing';" +
    "var want=tvHref(state.coins[state.drawer]);return a.getAttribute('href')===want?'ok':'href '+a.getAttribute('href');})()");
  if (tvOk !== "ok") throw new Error("TV handoff link wrong: " + tvOk);
  await shot("smoke_drawer.png");
  // Drawer focus survives a full render (audit D2 F8): the innerHTML swap
  // used to drop document.activeElement to <body> every 5 seconds.
  await evaluate("document.getElementById('drawerclose').focus()");
  await evaluate("render()");
  await sleep(300);
  const afterRender = await evaluate("document.activeElement && document.activeElement.id");
  if (afterRender !== "drawerclose")
    throw new Error("drawer focus lost across render: " + afterRender);
  // The drawer star (span role=button) toggles on Enter (audit D2 F8).
  const favBefore = await evaluate("state.favs.length");
  await evaluate("(function(){var st=document.querySelector('#drawer .dr-head .star'); st.focus();" +
    " st.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()");
  await sleep(300);
  if ((await evaluate("state.favs.length")) === favBefore)
    throw new Error("drawer star did not toggle on Enter");
  await evaluate("(function(){var st=document.querySelector('#drawer .dr-head .star');" +
    " st.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()");
  await sleep(200);
  if ((await evaluate("state.favs.length")) !== favBefore)
    throw new Error("drawer star Enter toggle did not restore");
  console.log("d2d drawer: focus survives render | star toggles on Enter");
  await evaluate("(function(){var e=new KeyboardEvent('keydown',{key:'Escape'});document.dispatchEvent(e);})()");
  await sleep(300);
  if (!(await evaluate("document.getElementById('drawer').hidden")))
    throw new Error("Escape did not close the drawer");
  console.log("d2d drawer: opens on row click | names " + drawerSym + " | TV href via tested rule | esc closes");
  await evaluate("setView('regular')");
  await sleep(1000);
  await evaluate("document.querySelector('#tbody > tr.row').click()");
  await sleep(600);
  const inlineDetail = await evaluate("document.querySelectorAll('#tbody > tr.detail').length");
  const drawerStayed = await evaluate("document.getElementById('drawer').hidden");
  if (inlineDetail !== 1 || !drawerStayed)
    throw new Error("Regular-view expansion broken: detail rows " + inlineDetail + " drawer hidden " + drawerStayed);
  // View-transition reconciliation (audit D2 F9): leave each surface OPEN
  // across the switch - the destination must show only its own surface.
  await evaluate("setView('simple')");
  await sleep(800);
  const leakDetail = await evaluate("document.querySelectorAll('#tbody > tr.detail').length");
  if (leakDetail !== 0) throw new Error("inline detail leaked into Command view: " + leakDetail);
  await evaluate("document.querySelector('#tbody > tr.simple-row').click()");
  await sleep(400);
  if (await evaluate("document.getElementById('drawer').hidden"))
    throw new Error("drawer did not open for the F9 transition check");
  await evaluate("setView('regular')");
  await sleep(600);
  if (!(await evaluate("document.getElementById('drawer').hidden")))
    throw new Error("drawer leaked into Regular view");
  console.log("d2 transitions: inline detail gated to Regular | drawer closed entering Regular");
  await evaluate("setView('simple')");
  await sleep(800);

  // -------- 390px both modes --------
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(1500);
  console.log("390px simple: rows " + (await evaluate("document.querySelectorAll('#tbody > tr').length")));
  await shot("smoke_390_simple.png");
  // Dropdown containment (audit D2 F6): every chip panel must open fully
  // inside the viewport - flipped panels used to land at left -283px where
  // no pan could reach them.
  const geo = await evaluate("(function(){ var out=[]; DD.forEach(function(d){" +
    " var chip=document.getElementById(d.chip), p=document.getElementById(d.panel);" +
    " chip.click(); var r=p.getBoundingClientRect();" +
    " out.push(d.chip+':'+Math.round(r.left)+','+Math.round(r.right)); chip.click(); });" +
    " return out.join(' '); })()");
  console.log("390px dropdown geometry: " + geo);
  geo.split(" ").forEach(function (entry) {
    const m = entry.match(/^(.+):(-?\d+),(-?\d+)$/);
    if (!m) throw new Error("unparseable geometry entry: " + entry);
    if (+m[2] < 8 || +m[3] > 390 - 8)
      throw new Error("chip panel escapes the 390px viewport: " + entry);
  });
  // Sort chip (Option A, chosen 2026-08-31, supersedes the earlier
  // select): the Command thead is display:none at this width, so the chip
  // is the ONLY sort surface - it must be visible, open, drive the same
  // sort state, and keep an honest badge.
  const theadDisp = await evaluate("getComputedStyle(document.getElementById('thead')).display");
  if (theadDisp !== "none") throw new Error("Command thead unexpectedly visible at 390px: " + theadDisp);
  const sortVis = await evaluate("!document.getElementById('dd-sort').hidden");
  if (!sortVis) throw new Error("Sort chip hidden in 390px Command view");
  await evaluate("document.getElementById('chip-sort').click()");
  await sleep(300);
  if (await evaluate("document.getElementById('panel-sort').hidden"))
    throw new Error("Sort panel did not open");
  await evaluate("document.querySelector('#panel-sort [data-sortkey=\\\"chg\\\"]').click()");
  await sleep(400);
  if ((await evaluate("state.sortKey")) !== "chg")
    throw new Error("sort key button did not drive sortKey");
  await evaluate("document.querySelector('#panel-sort [data-sortdir=\\\"1\\\"]').click()");
  await sleep(300);
  if ((await evaluate("state.sortDir")) !== 1)
    throw new Error("sort direction button did not flip to asc");
  const sortBadge = await evaluate("document.getElementById('sum-sort').textContent");
  if (sortBadge !== "24h %")
    throw new Error("sort badge does not name the active key: " + sortBadge);
  // Symbol sign (a mobile-app divergence, 2026-09-02): the chip's
  // Symbol key opens ASCENDING (sortDir 1) and that must render A-Z. The
  // name comparator carried the inverse sign of the numeric branches and
  // rendered Z-A under an ascending badge; no criterion pinned it. Read
  // the rendered Identity cells (no favorites are pinned at this point -
  // the D2-b leg unstarred its own), not the model.
  await evaluate("document.querySelector('#panel-sort [data-sortkey=\\\"name\\\"]').click()");
  await sleep(400);
  const symKey = await evaluate("state.sortKey");
  const symDir = await evaluate("state.sortDir");
  if (symKey !== "name" || symDir !== 1)
    throw new Error("Symbol chip did not land on name ascending: " + symKey + "/" + symDir);
  const symOrder = await evaluate(
    "(function(){ var t=[].slice.call(document.querySelectorAll('#tbody > tr.simple-row')).slice(0, 12);" +
    " var s=t.map(function(tr){ return state.coins[tr.getAttribute('data-coin')].sym; });" +
    " for(var i=1;i<s.length;i++) if(s[i] < s[i-1]) return 'bad@'+i+':'+s.join(',');" +
    " return 'ok:'+s.slice(0,4).join(','); })()");
  if (!/^ok:/.test(symOrder)) throw new Error("Symbol ascending did not render A-Z: " + symOrder);
  console.log("390px sort chip: Symbol key -> dir " + symDir + " | first rows " + symOrder.slice(3));
  await evaluate("document.getElementById('chip-sort').click()");   // close the panel
  await sleep(200);
  console.log("390px sort chip: visible | panel drives key + dir | badge " + sortBadge);
  await evaluate("setView('regular')");
  await sleep(1500);
  const mRows = await evaluate("document.querySelectorAll('#tbody > tr').length");
  console.log("390px regular: rows " + mRows);
  await shot("smoke_390_regular.png");
  if (mRows !== payloadCoins) throw new Error("390px regular row count mismatch");
  // The phone hide-list must track column KEYS, not positions (external
  // audit 2026-08-16 F5): with Tier A able to remove arbitrary columns,
  // positional nth-child rules hid whatever landed on their index. Assert
  // the computed visibility of the keyed policy: funding/5m/30m hidden,
  // score visible - regardless of what sits at which index.
  const colVis = await evaluate(
    "['col-funding','col-r5','col-r30','col-score'].map(function(c){" +
    " var el = document.querySelector('tbody tr.row td.' + c);" +
    " return c + '=' + (el ? getComputedStyle(el).display : 'absent'); }).join(' ')");
  console.log("390px column policy: " + colVis);
  if (!/col-funding=none/.test(colVis) || !/col-r5=none/.test(colVis) ||
      !/col-r30=none/.test(colVis) || !/col-score=table-cell/.test(colVis))
    throw new Error("390px keyed column policy broken: " + colVis);

  // -------- hosted guarantee + standalone rollback --------
  // Every section above ran in hosted mode; the browser must not have
  // touched the exchange ONCE. Then ?standalone=1 must still bring up the
  // original in-browser pipeline - the rollback path - which by definition
  // DOES talk to the exchange.
  if (exchangeReqs.length)
    throw new Error("hosted page hit the exchange " + exchangeReqs.length + "x, e.g. " + exchangeReqs[0]);
  console.log("hosted guarantee: ZERO exchange requests across every section above");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: DASH + (DASH.indexOf("?") >= 0 ? "&" : "?") + "standalone=1" });
  await sleep(3000);
  await waitRows(180000);
  await sleep(5000); // let the standalone mids poll fire at least once
  const saMode = await evaluate("state.dataMode");
  const saRows = await evaluate("document.querySelectorAll('#tbody > tr').length");
  console.log("standalone rollback: mode " + saMode + " | rows " + saRows +
    " | exchange requests " + exchangeReqs.length);
  if (saMode !== "standalone") throw new Error("?standalone=1 did not force standalone: " + saMode);
  if (saRows !== payloadCoins) throw new Error("standalone row count mismatch: " + saRows);
  if (!exchangeReqs.length)
    throw new Error("standalone mode made no exchange requests - the rollback pipeline is dead");

  // -------- verdict --------
  console.log("runtime errors: " + errors.length + " | failed app requests: " + netFails.length);
  errors.slice(0, 5).forEach((e) => console.log("  " + e.slice(0, 200)));
  netFails.slice(0, 5).forEach((e) => console.log("  " + e.slice(0, 200)));
  if (errors.length || netFails.length) throw new Error("smoke found errors");
  console.log("SMOKE GREEN (" + DASH + ") - screenshots in " + OUT);
}

async function cleanup() {
  try {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ id: ++msgId, method: "Browser.close" }));
      await sleep(700);
    }
  } catch (e) {}
  try { if (chrome) chrome.kill(); } catch (e) {}
}

// The failure path used to print ONLY the message, discarding the exception
// and failed-request buffers it had been filling the whole run - so "rows
// never rendered" read identically whether the dashboard threw a TypeError or
// Hyperliquid just answered 429 during the initial load. That is the same
// shape as the webhook-delivery blind spot: the evidence existed and was
// thrown away at the one moment it mattered. Dump both buffers on failure.
run().then(
  async () => { await cleanup(); process.exit(0); },
  async (e) => {
    console.error("SMOKE FAILED: " + (e && e.message));
    console.error("runtime errors: " + errors.length + " | failed app requests: " + netFails.length);
    errors.slice(0, 10).forEach((x) => console.error("  " + String(x).slice(0, 300)));
    netFails.slice(0, 10).forEach((x) => console.error("  " + String(x).slice(0, 300)));
    if (!errors.length && !netFails.length) {
      console.error("  (no runtime errors and no failed requests - the page loaded " +
        "cleanly and simply had no rows in time; suspect upstream rate limiting " +
        "or a slow initial load before suspecting the dashboard)");
    }
    await cleanup();
    process.exit(1);
  }
);
