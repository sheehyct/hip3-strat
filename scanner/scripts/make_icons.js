"use strict";

// Generates the PWA icons (public/icon-192.png, public/icon-512.png) with
// zero dependencies: raw RGBA pixels + node:zlib deflate + hand-rolled PNG
// chunks. Design: three candlestick-style bars in the dashboard's semantic
// accent colors (2U emerald, 3 amber, 2D crimson) on the zinc-950 background.
// Content stays inside the center ~70% so the maskable variant survives
// Android's circular crop. Run: node scripts/make_icons.js

const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

// ---- tiny PNG encoder ----
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // scanlines with filter byte 0 (None)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---- drawing ----
function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }

function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = hex("#09090b");
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = bg[0]; px[i * 4 + 1] = bg[1]; px[i * 4 + 2] = bg[2]; px[i * 4 + 3] = 255;
  }
  function fillRect(x0, y0, x1, y1, color) {
    const c = hex(color);
    const ax = Math.round(x0 * size), bx = Math.round(x1 * size);
    const ay = Math.round(y0 * size), by = Math.round(y1 * size);
    for (let y = ay; y < by; y++) {
      for (let x = ax; x < bx; x++) {
        const o = (y * size + x) * 4;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
      }
    }
  }
  // three "bars": 2U (emerald, mid height), 3 (amber, tallest), 2D (crimson)
  fillRect(0.24, 0.34, 0.36, 0.76, "#00DC82");
  fillRect(0.44, 0.26, 0.56, 0.76, "#FFB800");
  fillRect(0.64, 0.42, 0.76, 0.76, "#FF3B5C");
  return encodePNG(size, px);
}

const outDir = path.resolve(__dirname, "..", "public");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, "icon-" + size + ".png");
  fs.writeFileSync(file, makeIcon(size));
  console.log("wrote " + file + " (" + fs.statSync(file).size + " bytes)");
}
