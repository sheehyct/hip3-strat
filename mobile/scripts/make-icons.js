"use strict";

// Regenerates all app icon assets with zero dependencies (raw RGBA +
// node:zlib PNG encoding). Same three-bar mark as the scanner's web dashboard:
// candlestick bars in the STRAT semantic accents (2U emerald, 3 amber,
// 2D crimson) on zinc-950. Run: node scripts/make-icons.js

const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

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
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
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

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

// opts: { bg: "#hex" | null (transparent), mono: force all bars to this hex,
//         inset: extra content inset 0..0.5 (adaptive icons need safe zone) }
function makeIcon(size, opts) {
  opts = opts || {};
  const px = Buffer.alloc(size * size * 4);
  if (opts.bg) {
    const bg = hex(opts.bg);
    for (let i = 0; i < size * size; i++) {
      px[i * 4] = bg[0]; px[i * 4 + 1] = bg[1]; px[i * 4 + 2] = bg[2]; px[i * 4 + 3] = 255;
    }
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
  // Bars defined in unit space, then squeezed toward center by inset.
  const k = 1 - 2 * (opts.inset || 0);
  const m = (opts.inset || 0);
  function sq(v) { return m + v * k; }
  const bars = [
    { x0: 0.24, y0: 0.34, x1: 0.36, y1: 0.76, c: "#00DC82" },
    { x0: 0.44, y0: 0.26, x1: 0.56, y1: 0.76, c: "#FFB800" },
    { x0: 0.64, y0: 0.42, x1: 0.76, y1: 0.76, c: "#FF3B5C" }
  ];
  for (const b of bars) {
    fillRect(sq(b.x0), sq(b.y0), sq(b.x1), sq(b.y1), opts.mono || b.c);
  }
  return encodePNG(size, px);
}

const out = path.resolve(__dirname, "..", "assets", "images");
const files = [
  ["icon.png",                        makeIcon(1024, { bg: "#09090b" })],
  ["android-icon-foreground.png",     makeIcon(1024, { bg: null, inset: 0.18 })],
  ["android-icon-background.png",     makeIcon(1024, { bg: "#09090b", mono: "#09090b" })],
  ["android-icon-monochrome.png",     makeIcon(1024, { bg: null, mono: "#ffffff", inset: 0.18 })],
  ["splash-icon.png",                 makeIcon(512, { bg: null })],
  ["favicon.png",                     makeIcon(48, { bg: "#09090b" })]
];
for (const [name, buf] of files) {
  fs.writeFileSync(path.join(out, name), buf);
  console.log("wrote assets/images/" + name + " (" + buf.length + " bytes)");
}
