"use strict";

// Release configuration check (first step of `npm run release:check`).
// It pins no project identity: the Android package, the EAS project and the
// Firebase client file are the builder's own. It checks only what the code
// relies on.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

const app = readJson("app.json").expo;
const pkg = readJson("package.json");
const errors = [];
const notes = [];

const requireValue = (condition, message) => {
  if (!condition) errors.push(message);
};
const plugin = (name) =>
  (app.plugins || []).find((p) => Array.isArray(p) && p[0] === name);

const versionOk = /^\d+\.\d+\.\d+$/.test(app.version || "");
requireValue(versionOk, "expo.version must be x.y.z");
requireValue(
  /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(app.android?.package || ""),
  "expo.android.package must be a valid Android application id",
);
if (app.android?.package === "com.example.hip3strat") {
  notes.push("android.package is still the placeholder - set your own before a release build");
}

// Push is optional. When a Firebase client file is declared it must exist,
// otherwise the native build fails late and without a clear reason.
const gsf = app.android?.googleServicesFile;
if (gsf) {
  requireValue(
    fs.existsSync(path.join(root, gsf)),
    "expo.android.googleServicesFile points at a missing file: " + gsf,
  );
} else {
  notes.push("no googleServicesFile - push notifications stay unregistered (see README)");
}
if (!app.extra?.eas?.projectId) {
  notes.push("no extra.eas.projectId - run `eas init` in your own Expo account for builds and push");
}

// src/lib/push.ts creates and uses the Android channel named "default".
requireValue(
  plugin("expo-notifications")?.[1]?.defaultChannel === "default",
  "expo-notifications defaultChannel must be \"default\"",
);

// expo-secure-store holds the keys behind the device keystore. The plugin
// must stay declared with Android auto-backup excluded, and the module only
// exists in binaries built at or after 1.0.2: expo.version may never roll
// back below that floor while the plugin is present.
const NATIVE_FLOOR = "1.0.2";
const versionAtLeast = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i]; }
  return true;
};
const secureStore = plugin("expo-secure-store");
requireValue(secureStore, "expo-secure-store plugin entry is missing");
requireValue(
  secureStore?.[1]?.configureAndroidBackup === true,
  "expo-secure-store must set configureAndroidBackup: true",
);
requireValue(pkg.dependencies?.["expo-secure-store"], "expo-secure-store is missing");
requireValue(
  !versionOk || versionAtLeast(app.version, NATIVE_FLOOR),
  "expo.version below the expo-secure-store native floor " + NATIVE_FLOOR,
);

if (errors.length) {
  console.error("release config FAILED:");
  for (const error of errors) console.error("- " + error);
  process.exit(1);
}

for (const note of notes) console.log("release config note: " + note);
console.log("release config OK: " + app.android.package + " v" + app.version);
