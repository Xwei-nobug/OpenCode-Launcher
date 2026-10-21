"use strict";

/**
 * Draws the app icon with plain math (no image libraries) and writes a
 * 512x512 PNG that electron-builder converts to .ico.
 *
 * Design: rounded-square with a blue-violet diagonal gradient and a white
 * terminal glyph (chevron + caret line) — the same mark the window header uses.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT = 512;
const SS = 2; // supersample factor for anti-aliasing
const N = OUT * SS;

const buf = new Float64Array(N * N * 4); // premultiplied-ish accumulation

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp01((wx * vx + wy * vy) / len2);
  const dx = px - (ax + vx * t);
  const dy = py - (ay + vy * t);
  return Math.hypot(dx, dy);
}

function blend(i, r, g, b, a) {
  const o = i * 4;
  buf[o] = buf[o] * (1 - a) + r * a;
  buf[o + 1] = buf[o + 1] * (1 - a) + g * a;
  buf[o + 2] = buf[o + 2] * (1 - a) + b * a;
  buf[o + 3] = buf[o + 3] * (1 - a) + 255 * a;
}

// ---- background: rounded square with a diagonal gradient -------------------
const pad = N * 0.045;
const R = N * 0.22; // corner radius
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (!inRoundedRect(x, y, pad, pad, N - pad, N - pad, R)) continue;
    const t = clamp01((x - pad + (y - pad)) / (2 * (N - 2 * pad)));
    // #7b93ff -> #4f6ef7 -> #3f54d8
    const r0 = 0x7b, g0 = 0x93, b0 = 0xff;
    const r1 = 0x4f, g1 = 0x6e, b1 = 0xf7;
    const r2 = 0x3f, g2 = 0x54, b2 = 0xd8;
    const k = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const from = t < 0.5 ? [r0, g0, b0] : [r1, g1, b1];
    const to = t < 0.5 ? [r1, g1, b1] : [r2, g2, b2];
    blend(y * N + x, from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k, 1);
  }
}

// ---- terminal glyph: rounded window outline + chevron + caret --------------
// All coordinates relative to the icon box (0..1), scaled to N.
const W = (v) => pad + v * (N - 2 * pad);

// screen (window) outline
const sx0 = W(0.19), sy0 = W(0.245), sx1 = W(0.81), sy1 = W(0.755);
const sR = W(0.075);
const strokeW = W(0.045);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const outer = inRoundedRect(x, y, sx0, sy0, sx1, sy1, sR);
    const inner = inRoundedRect(x, y, sx0 + strokeW, sy0 + strokeW, sx1 - strokeW, sy1 - strokeW, Math.max(2, sR - strokeW));
    if (outer && !inner) blend(y * N + x, 255, 255, 255, 0.96);
  }
}

// chevron ">"
const chevW = W(0.042);
const segs = [
  [W(0.335), W(0.40), W(0.45), W(0.50)],
  [W(0.45), W(0.50), W(0.335), W(0.60)],
];
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let d = Infinity;
    for (const [ax, ay, bx, by] of segs) d = Math.min(d, distToSegment(x, y, ax, ay, bx, by));
    if (d <= chevW / 2) blend(y * N + x, 255, 255, 255, 0.96);
  }
}

// caret "_" (rounded bar)
const cx0 = W(0.50), cy0 = W(0.585), cx1 = W(0.655), cy1 = W(0.585) + chevW * 0.55;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (inRoundedRect(x, y, cx0, cy0, cx1, cy1, (cy1 - cy0) / 2)) blend(y * N + x, 255, 255, 255, 0.96);
  }
}

// ---- downsample to OUT x OUT ----------------------------------------------
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const o = ((y * SS + dy) * N + (x * SS + dx)) * 4;
        r += buf[o];
        g += buf[o + 1];
        b += buf[o + 2];
        a += buf[o + 3];
      }
    }
    const n = SS * SS;
    const o = (y * OUT + x) * 4;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
    out[o + 3] = Math.round(a / n);
  }
}

// ---- PNG encode (8-bit RGBA, no filtering) --------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((OUT * 4 + 1) * OUT);
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0; // filter: none
  out.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const dest = path.join(__dirname, "..", "build", "icon.png");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, png);
console.log(`icon written: ${dest} (${(png.length / 1024).toFixed(1)} KB, ${OUT}x${OUT})`);
