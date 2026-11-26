// Runs the web build on this machine: serves the exported app (dist-web/)
// and the MyFundedPerps pass-through (/mfp/...) from ONE origin, so the
// browser's MFP requests are same-origin and need no CORS (app.mjs).
//
//   npm run serve            export the web build, then serve it
//   node server/serve.mjs    serve the last export
//
// Listens on 127.0.0.1 only. Open http://localhost:8088 (TT_PORT changes
// the port). Stop it with Ctrl+C.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeApp } from "./app.mjs";
import { makeMfpHandler } from "./mfp_passthrough.mjs";
import { makeMfpStreamRelay } from "./mfp_stream_relay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-web");
const port = Number(process.env.TT_PORT) || 8088;

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("no web build in dist-web/ - run: npm run serve");
  process.exit(1);
}

const stamp = () => new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
const hosts = ["localhost:" + port, "127.0.0.1:" + port];
const log = (line) => console.log(stamp() + " ET  " + line);
const handleMfp = makeMfpHandler({ hosts, log });
// The account stream's relay: Node's own WebSocket, one socket per request.
const handleMfpStream = makeMfpStreamRelay({ hosts, log });

makeApp({ dist, handleMfp, handleMfpStream }).listen(port, "127.0.0.1", () => {
  console.log("Trade Terminal: http://localhost:" + port + "   (demo mode: http://localhost:" + port + "/?mock=1)");
  console.log("MyFundedPerps requests go through this window. Ctrl+C stops it.");
});
