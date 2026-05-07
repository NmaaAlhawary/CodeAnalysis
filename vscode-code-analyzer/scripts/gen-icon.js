// Generates assets/icon.png — run with: node scripts/gen-icon.js
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const W = 256, H = 256, R = 52;
const buf = Buffer.alloc(W * H * 4, 0);

function px(x, y, r, g, b, a = 255) {
  const i = (y * W + x) * 4;
  buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = a;
}
function lerp(a, b, t) { return Math.round(a + (b - a) * Math.min(1, Math.max(0, t))); }
function hex(h) { return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]; }

// ── Background: diagonal gradient indigo→teal ───────────────────────────────
const c0 = hex('#312e81'), c1 = hex('#0f766e');
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // Rounded-rect mask
    const dx = Math.max(R - x, 0, x - (W - 1 - R));
    const dy = Math.max(R - y, 0, y - (H - 1 - R));
    const dist2 = dx * dx + dy * dy;
    if (dist2 > R * R) { px(x, y, 0, 0, 0, 0); continue; }

    const t = (x + y) / (W + H - 2);
    // inner glow: lighter towards center
    const cx = x - W/2, cy = y - H/2;
    const g2 = 1 - Math.min(1, Math.sqrt(cx*cx + cy*cy) / (W * 0.65));
    const tg = t * 0.7 + g2 * 0.3;

    px(x, y,
      lerp(c0[0], c1[0], tg),
      lerp(c0[1], c1[1], tg),
      lerp(c0[2], c1[2], tg),
      255
    );
  }
}

// ── Anti-aliased line drawing ─────────────────────────────────────────────
function blend(x, y, r, g, b, alpha) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const a = alpha / 255, ia = 1 - a;
  buf[i]   = Math.round(buf[i]   * ia + r * a);
  buf[i+1] = Math.round(buf[i+1] * ia + g * a);
  buf[i+2] = Math.round(buf[i+2] * ia + b * a);
  buf[i+3] = Math.min(255, buf[i+3] + Math.round(alpha * (buf[i+3] / 255 + a)));
}

function aaLine(x0, y0, x1, y1, r, g, b, thick = 2.5) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx*dx+dy*dy);
  const steps = Math.ceil(len * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + dx * t, cy = y0 + dy * t;
    for (let oy = -Math.ceil(thick); oy <= Math.ceil(thick); oy++) {
      for (let ox = -Math.ceil(thick); ox <= Math.ceil(thick); ox++) {
        const d = Math.sqrt(ox*ox + oy*oy);
        const a = Math.max(0, 1 - Math.max(0, d - thick/2) / 1.2);
        blend(Math.round(cx+ox), Math.round(cy+oy), r, g, b, Math.round(a * 230));
      }
    }
  }
}

function circle(cx, cy, radius, r, g, b, thick = 2.5) {
  const steps = Math.ceil(2 * Math.PI * radius * 2);
  for (let s = 0; s <= steps; s++) {
    const a = (s / steps) * 2 * Math.PI;
    const x = cx + Math.cos(a) * radius, y = cy + Math.sin(a) * radius;
    for (let oy = -Math.ceil(thick); oy <= Math.ceil(thick); oy++) {
      for (let ox = -Math.ceil(thick); ox <= Math.ceil(thick); ox++) {
        const d = Math.sqrt(ox*ox + oy*oy);
        const alpha = Math.max(0, 1 - Math.max(0, d - thick/2) / 1.2);
        blend(Math.round(x+ox), Math.round(y+oy), r, g, b, Math.round(alpha * 230));
      }
    }
  }
}

function filledCircle(cx, cy, radius, r, g, b, a = 255) {
  const R2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx*dx + dy*dy;
      if (d2 > R2) continue;
      const aa = Math.max(0, 1 - Math.max(0, Math.sqrt(d2) - radius + 1));
      blend(x, y, r, g, b, Math.round(aa * a));
    }
  }
}

// ── Magnifying glass (white) ──────────────────────────────────────────────
const lensX = 96, lensY = 96, lensR = 58;
circle(lensX, lensY, lensR, 255, 255, 255, 7);
// Handle
aaLine(lensX + lensR * 0.72, lensY + lensR * 0.72, 192, 192, 255, 255, 255, 7);

// ── Code < > inside lens (cyan) ───────────────────────────────────────────
// < bracket
aaLine(78, 78, 58, 96, 34, 211, 238, 5);   // top-left arm
aaLine(58, 96, 78, 114, 34, 211, 238, 5);  // bottom-left arm
// > bracket
aaLine(112, 78, 132, 96, 167, 139, 250, 5); // top-right arm
aaLine(132, 96, 112, 114, 167, 139, 250, 5);// bottom-right arm
// / slash (white)
aaLine(103, 68, 85, 124, 255, 255, 255, 4.5);

// ── Graph nodes (top-right area, purple/cyan accent) ─────────────────────
filledCircle(188, 52, 14, 167, 139, 250);  // node 1
filledCircle(212, 88, 10, 34, 211, 238);   // node 2
filledCircle(164, 76, 8,  167, 139, 250);  // node 3
aaLine(188, 52, 212, 88, 167, 139, 250, 2);
aaLine(188, 52, 164, 76, 34, 211, 238, 2);
aaLine(164, 76, 212, 88, 200, 180, 255, 2);

// ── Bottom bar metrics (teal accent) ─────────────────────────────────────
const bars = [[60,196,24], [96,186,34], [132,202,20], [168,190,30]];
bars.forEach(([bx, by, bh]) => {
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + 16; x++) {
      const alpha = (x === bx || x === bx+15 || y === by || y === by+bh-1) ? 200 : 160;
      blend(x, y, 20, 184, 166, alpha);
    }
  }
});

// ── Build PNG ─────────────────────────────────────────────────────────────
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) { c = (c >>> 8) ^ crcTable[(c ^ b) & 0xff]; }
  return (c ^ 0xffffffff) >>> 0;
}
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeB, data]);
  const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// Raw data: each row prefixed with filter byte 0
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter None
  buf.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.resolve(__dirname, '../assets/icon.png');
fs.writeFileSync(out, png);
console.log(`Written ${png.length} bytes → ${out}`);
