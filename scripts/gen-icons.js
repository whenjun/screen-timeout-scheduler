'use strict';
/*
 * 生成应用图标资产（纯 Node 内置模块，无第三方依赖）。
 *
 * 仓库里只保存这份脚本，不保存二进制图标；npm install 时由 prepare 自动执行。
 * 输出：
 *   src/icons/{work,lunch,off,lock}.png   托盘四色图标 32x32
 *   src/icon.ico / build/icon.ico          256px 多尺寸应用图标
 *
 * ICO 使用 BMP/DIB 条目（而非 PNG 压缩），因为 electron-builder 的 rcedit
 * 无法提交 PNG 压缩条目，会报 "Fatal error: Unable to commit changes"。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BRAND = [37, 99, 235];
const COLORS = {
  work: [22, 163, 74],
  lunch: [217, 119, 6],
  off: [107, 114, 128],
  lock: [29, 78, 216]
};

// ---------- PNG 编码 ----------

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 图标绘制 ----------

function inRoundedRect(x, y, n, r) {
  const nx = Math.min(x, n - 1 - x);
  const ny = Math.min(y, n - 1 - y);
  if (nx < 0 || ny < 0) return false;
  if (nx >= r || ny >= r) return true;
  return (nx - r) ** 2 + (ny - r) ** 2 <= r * r;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function sample(px, py, n, rgb) {
  if (!inRoundedRect(px, py, n, n * 0.22)) return [0, 0, 0, 0];
  const cx = n / 2, cy = n / 2;
  const d = Math.hypot(px - cx, py - cy);
  let c = [rgb[0], rgb[1], rgb[2], 255];
  if (d <= n * 0.345 && d >= n * 0.29) c = [255, 255, 255, 255];
  if (distToSegment(px, py, cx, cy, cx, n * 0.29) < n * 0.033) c = [255, 255, 255, 255];
  if (distToSegment(px, py, cx, cy, n * 0.68, n * 0.60) < n * 0.033) c = [255, 255, 255, 255];
  if (d < n * 0.048) c = [255, 255, 255, 255];
  return c;
}

function renderRgba(size, rgb, ss = 4) {
  const out = Buffer.alloc(size * size * 4);
  const total = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss, size, rgb);
          r += c[0] * c[3] / 255;
          g += c[1] * c[3] / 255;
          b += c[2] * c[3] / 255;
          a += c[3];
        }
      }
      const i = (y * size + x) * 4;
      const alpha = a / 255;
      out[i] = alpha > 0 ? Math.min(255, Math.round(r / alpha / total)) : 0;
      out[i + 1] = alpha > 0 ? Math.min(255, Math.round(g / alpha / total)) : 0;
      out[i + 2] = alpha > 0 ? Math.min(255, Math.round(b / alpha / total)) : 0;
      out[i + 3] = Math.round(a / total);
    }
  }
  return out;
}

// ---------- ICO (BMP/DIB) ----------

function dibEntry(size, rgba) {
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;  // DIB 自下而上
      const dst = (y * size + x) * 4;
      xor[dst] = rgba[src + 2];      // B
      xor[dst + 1] = rgba[src + 1];  // G
      xor[dst + 2] = rgba[src];      // R
      xor[dst + 3] = rgba[src + 3];  // A
    }
  }
  const rowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(rowBytes * size);   // 全 0 = 使用 alpha 通道
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8);   // XOR + AND 高度
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(0, 16);        // BI_RGB
  hdr.writeUInt32LE(xor.length + mask.length, 20);
  return Buffer.concat([hdr, xor, mask]);
}

function buildIco() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const blobs = sizes.map(s => dibEntry(s, renderRgba(s, BRAND)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dirs = sizes.map((s, i) => {
    const d = Buffer.alloc(16);
    const b = s >= 256 ? 0 : s;
    d[0] = b; d[1] = b; d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(blobs[i].length, 8);
    d.writeUInt32LE(offset, 12);
    offset += blobs[i].length;
    return d;
  });
  return Buffer.concat([header, ...dirs, ...blobs]);
}

// ---------- 输出 ----------

function main() {
  const iconDir = path.join(ROOT, 'src', 'icons');
  fs.mkdirSync(iconDir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });

  for (const [name, rgb] of Object.entries(COLORS)) {
    const buf = encodePng(32, renderRgba(32, rgb));
    fs.writeFileSync(path.join(iconDir, name + '.png'), buf);
  }
  const ico = buildIco();
  fs.writeFileSync(path.join(ROOT, 'src', 'icon.ico'), ico);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
  console.log(`[gen-icons] 4 个托盘 PNG + 2 个 ICO (${ico.length} bytes) 已生成`);
}

main();
