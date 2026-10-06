#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 64;
const SUPERSAMPLE = 8;
const FILL = 0.85;
const OUTER_RADIUS = (SIZE / 2) * FILL;
const CENTER_RADIUS = 5.5;
const RAY_BASE_HALF_WIDTH = 3.4;
const RAY_TIP_RADIUS = 1.3;
const RAY_TAPER_POWER = 0.85;
const RAY_LENGTHS = [1.0, 0.78, 0.93, 0.74, 0.97, 0.82, 0.9, 0.76, 0.99, 0.8, 0.88, 0.72];
const RAY_ANGLE_JITTER_DEG = [0, 4, -3, 2, -2, 3, 0, -4, 2, -1, 3, -2];
const FIRST_RAY_DEG = 90;
const ORANGE = [0xd9, 0x77, 0x57];
const CENTER_ORANGE = [0xf0, 0x9e, 0x7e];
const CENTER_GLOW_RADIUS = 9;
const TGA_HEADER_SIZE = 18;
const TGA_TRUECOLOR = 2;
const TGA_BITS = 32;
const TGA_DESCRIPTOR_TOP_LEFT_8_ALPHA = 0x28;
const PREVIEW_SCALE = 4;
const PREVIEW_BACKDROP = [0x1c, 0x1a, 0x18];

const OUT_TGA = path.join(__dirname, '..', 'addon', 'ClaudeWoW', 'MinimapIcon.tga');

function rays() {
  return RAY_LENGTHS.map((share, i) => {
    const angle = ((FIRST_RAY_DEG + i * (360 / RAY_LENGTHS.length) + RAY_ANGLE_JITTER_DEG[i]) * Math.PI) / 180;
    return { dx: Math.cos(angle), dy: -Math.sin(angle), length: OUTER_RADIUS * share };
  });
}

function insideRay(x, y, ray) {
  const along = x * ray.dx + y * ray.dy;
  if (along < 0) return false;
  const across = Math.abs(-x * ray.dy + y * ray.dx);
  const tipCenter = ray.length - RAY_TIP_RADIUS;
  if (along > tipCenter) return Math.hypot(along - tipCenter, across) <= RAY_TIP_RADIUS;
  const halfWidth = RAY_TIP_RADIUS + (RAY_BASE_HALF_WIDTH - RAY_TIP_RADIUS) * Math.pow(1 - along / tipCenter, RAY_TAPER_POWER);
  return across <= halfWidth;
}

function insideSpark(x, y, allRays) {
  if (Math.hypot(x, y) <= CENTER_RADIUS) return true;
  return allRays.some(ray => insideRay(x, y, ray));
}

function colorAt(x, y) {
  const t = Math.min(1, Math.hypot(x, y) / CENTER_GLOW_RADIUS);
  const glow = 1 - t * t * (3 - 2 * t);
  return ORANGE.map((c, i) => c + (CENTER_ORANGE[i] - c) * glow);
}

function renderPixels() {
  const allRays = rays();
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const half = SIZE / 2;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let covered = 0;
      const sum = [0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = px + (sx + 0.5) / SUPERSAMPLE - half;
          const y = py + (sy + 0.5) / SUPERSAMPLE - half;
          if (!insideSpark(x, y, allRays)) continue;
          covered++;
          const c = colorAt(x, y);
          sum[0] += c[0];
          sum[1] += c[1];
          sum[2] += c[2];
        }
      }
      const at = (py * SIZE + px) * 4;
      if (covered === 0) continue;
      pixels[at] = Math.round(sum[0] / covered);
      pixels[at + 1] = Math.round(sum[1] / covered);
      pixels[at + 2] = Math.round(sum[2] / covered);
      pixels[at + 3] = Math.round((255 * covered) / samples);
    }
  }
  return pixels;
}

function encodeTga(rgba, size) {
  const header = Buffer.alloc(TGA_HEADER_SIZE);
  header[2] = TGA_TRUECOLOR;
  header.writeUInt16LE(size, 12);
  header.writeUInt16LE(size, 14);
  header[16] = TGA_BITS;
  header[17] = TGA_DESCRIPTOR_TOP_LEFT_8_ALPHA;
  const body = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    body[i * 4] = rgba[i * 4 + 2];
    body[i * 4 + 1] = rgba[i * 4 + 1];
    body[i * 4 + 2] = rgba[i * 4];
    body[i * 4 + 3] = rgba[i * 4 + 3];
  }
  return Buffer.concat([header, body]);
}

function decodeTga(buf) {
  const size = buf.readUInt16LE(12);
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const at = TGA_HEADER_SIZE + i * 4;
    rgba[i * 4] = buf[at + 2];
    rgba[i * 4 + 1] = buf[at + 1];
    rgba[i * 4 + 2] = buf[at];
    rgba[i * 4 + 3] = buf[at + 3];
  }
  return { size, rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

function previewPixels(rgba, size) {
  const plainWidth = size * PREVIEW_SCALE;
  const width = plainWidth * 2;
  const out = Buffer.alloc(width * plainWidth * 4);
  for (let y = 0; y < plainWidth; y++) {
    for (let x = 0; x < width; x++) {
      const onBackdrop = x >= plainWidth;
      const src = (Math.floor(y / PREVIEW_SCALE) * size + Math.floor((x % plainWidth) / PREVIEW_SCALE)) * 4;
      const at = (y * width + x) * 4;
      const alpha = rgba[src + 3] / 255;
      for (let c = 0; c < 3; c++) {
        out[at + c] = onBackdrop ? Math.round(rgba[src + c] * alpha + PREVIEW_BACKDROP[c] * (1 - alpha)) : rgba[src + c];
      }
      out[at + 3] = onBackdrop ? 255 : rgba[src + 3];
    }
  }
  return { rgba: out, width, height: plainWidth };
}

function makeIcon() {
  return encodeTga(renderPixels(), SIZE);
}

function main(argv) {
  const tga = makeIcon();
  fs.writeFileSync(OUT_TGA, tga);
  process.stdout.write(`${OUT_TGA}: ${SIZE}x${SIZE}, ${tga.length} bytes\n`);
  const previewAt = argv.indexOf('--preview');
  if (previewAt === -1) return;
  const previewPath = path.resolve(argv[previewAt + 1] || path.join(__dirname, 'minimap-icon-preview.png'));
  const preview = previewPixels(decodeTga(tga).rgba, SIZE);
  fs.writeFileSync(previewPath, encodePng(preview.rgba, preview.width, preview.height));
  process.stdout.write(`${previewPath}: ${preview.width}x${preview.height} preview\n`);
}

module.exports = { makeIcon, decodeTga, SIZE, ORANGE, OUT_TGA };

if (require.main === module) main(process.argv.slice(2));
