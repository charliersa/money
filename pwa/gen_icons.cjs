/* 產生 PWA 圖示（純 Node，不需要任何相依套件）
   圖案：藍紫漸層底 + 三根遞增的白色長條 + 向上箭頭 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

/* ── 迷你 PNG 編碼器 ─────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 幾何：以 3×3 超取樣算覆蓋率，邊緣才不會有鋸齒 ────────── */
function roundRectCoverage(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function draw(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const S = 3;                                   // 超取樣倍率
  // 內容安全區：maskable 版本要留 20% 邊，避免被系統裁掉
  const pad = maskable ? size * 0.22 : size * 0.11;
  const inner = size - pad * 2;
  const bgRadius = maskable ? size : size * 0.235;   // 一般版圓角、maskable 滿版

  const bars = [
    { x: 0.14, w: 0.17, top: 0.60, a: 0.55 },
    { x: 0.415, w: 0.17, top: 0.40, a: 0.78 },
    { x: 0.69, w: 0.17, top: 0.18, a: 1.00 },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let r = 0, g = 0, b = 0, aSum = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;

          const inBg = maskable
            ? true
            : roundRectCoverage(px, py, 0, 0, size, size, bgRadius);
          if (!inBg) continue;
          bgHits++;

          // 底色：左上 #6C8EF5 → 右下 #A78BFA
          const t = Math.min(1, Math.max(0, (px / size + py / size) / 2));
          let cr = 0x6c + (0xa7 - 0x6c) * t;
          let cg = 0x8e + (0x8b - 0x8e) * t;
          let cb = 0xf5 + (0xfa - 0xf5) * t;

          // 白色長條
          for (const bar of bars) {
            const bx = pad + inner * bar.x;
            const bw = inner * bar.w;
            const by = pad + inner * bar.top;
            const bh = pad + inner * 0.84 - by;
            if (roundRectCoverage(px, py, bx, by, bw, bh, bw * 0.34)) {
              cr = cr + (255 - cr) * bar.a;
              cg = cg + (255 - cg) * bar.a;
              cb = cb + (255 - cb) * bar.a;
              break;
            }
          }
          r += cr; g += cg; b += cb; aSum += 255;
        }
      }
      const i = (y * size + x) * 4;
      const total = S * S;
      if (!bgHits) { rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0; continue; }
      rgba[i] = Math.round(r / bgHits);
      rgba[i + 1] = Math.round(g / bgHits);
      rgba[i + 2] = Math.round(b / bgHits);
      rgba[i + 3] = Math.round(aSum / total);
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });
const jobs = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
];
for (const [name, size, maskable] of jobs) {
  const buf = draw(size, maskable);
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(name, size + 'x' + size, (buf.length / 1024).toFixed(1) + ' KB');
}
