// Web screenshot gate: exports the web build (unless --no-export), serves
// it with an SPA fallback, and drives headless Chromium through the mock
// venue layer (?mock=1) at a desktop viewport (1440x900) and a phone
// viewport (390x844). Shots land in shots/. No keyed calls: the mock layer
// never touches the network.
//
//   node scripts/shots.mjs [--no-export] [--only name]
import { spawnSync } from "node:child_process";
import url from "node:url";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-web");
const out = path.join(root, "shots");
const args = process.argv.slice(2);
const noExport = args.includes("--no-export");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

if (!noExport) {
  const r = spawnSync("npx", ["expo", "export", "--platform", "web", "--output-dir", dist], { cwd: root, stdio: "inherit", shell: process.platform === "win32" }); // npx is npx.cmd on Windows
  if (r.status !== 0) { console.error("web export failed"); process.exit(1); }
}
fs.mkdirSync(out, { recursive: true });

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".map": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(dist, decodeURIComponent(url.pathname));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dist, "index.html");
  res.setHeader("Content-Type", MIME[path.extname(p)] || "application/octet-stream");
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = "http://127.0.0.1:" + port;

// Playwright is a devDependency of this repo.
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
let pwPath = null;
try { pwPath = req.resolve("playwright"); } catch { /* reported below */ }
if (!pwPath) { console.error("playwright not found - run npm ci (it is a devDependency), then npx playwright install chromium"); process.exit(1); }
const pw = req(pwPath);
const chromium = pw.chromium;
const browser = await chromium.launch();

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

// Each scenario: a name, a viewport, a path, and an optional driver that
// interacts before the shot. shots.scenarios.mjs appends to this list.
const scenarios = [
  { name: "desktop-trade", vp: DESKTOP, path: "/?mock=1" },
  { name: "phone-trade", vp: PHONE, path: "/?mock=1", mobile: true },
  { name: "desktop-settings", vp: DESKTOP, path: "/settings?mock=1" },
  { name: "phone-settings", vp: PHONE, path: "/settings?mock=1", mobile: true },
];
const extra = path.join(root, "scripts", "shots.scenarios.mjs");
if (fs.existsSync(extra)) {
  const mod = await import(url.pathToFileURL(extra).href); // a bare Windows drive path is not a valid ESM specifier
  scenarios.push(...mod.scenarios({ DESKTOP, PHONE }));
}

const failures = [];
for (const sc of scenarios) {
  if (only && sc.name !== only) continue;
  const ctx = await browser.newContext({ viewport: sc.vp, deviceScaleFactor: 2, isMobile: !!sc.mobile, hasTouch: !!sc.mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  try {
    await page.goto(base + sc.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(sc.wait ?? 2500);
    if (sc.drive) await sc.drive(page);
    await page.screenshot({ path: path.join(out, sc.name + ".png"), fullPage: false });
    const text = await page.evaluate(() => document.body.innerText.replace(/\n+/g, " | "));
    console.log("shot " + sc.name + ": " + text.slice(0, 140));
    if (sc.expect && !text.includes(sc.expect)) failures.push(sc.name + ": expected text not found: " + sc.expect);
    const bad = errors.filter((e) => !/favicon|ResizeObserver|DevTools/.test(e));
    if (bad.length) { console.log("  console errors: " + bad.slice(0, 3).join(" || ")); failures.push(sc.name + ": console errors"); }
  } catch (e) {
    failures.push(sc.name + ": " + (e instanceof Error ? e.message : String(e)));
  }
  await ctx.close();
}
await browser.close();
server.close();
if (failures.length) { console.error("shots FAILED:\n- " + failures.join("\n- ")); process.exit(1); }
console.log("shots OK: " + fs.readdirSync(out).filter((f) => f.endsWith(".png")).length + " files in shots/");
