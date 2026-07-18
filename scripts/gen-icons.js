/**
 * Generates icon-192.png and icon-512.png for Plated.
 * Pure Node.js — only uses built-in zlib.
 *
 * Design: dark tile (#0d0d0f, matches the app's own background/theme
 * colour), thick violet ring with a bite taken out of it — "Ring + Bite."
 * Mirrors public/icons/icon-*.svg; keep the two in sync by hand if the
 * design changes again (the SVGs are the readable source, this is what
 * actually ships since manifest.json points at the PNGs).
 * Readable at 16x16 favicon size through 512x512 PWA icon.
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const len   = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcB  = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crcB]);
}

function makePNG(size) {
  const cx = size / 2, cy = size / 2;

  const BG     = [13,  13,  15];  // #0d0d0f — dark tile, matches app bg/theme colour
  const ACCENT = [200, 184, 255]; // #c8b8ff

  const cornerR   = size * 0.2148;                 // rounded-square corners, matches rx=110/512
  const ringR     = size * 0.3477;                 // ring centreline radius
  const ringHalfW = size * 0.1016 / 2;             // half of a 52/512 stroke width

  // Bite: two overlapping dark circles carved out of the ring — a bigger
  // bite plus a smaller offset one so the notch reads as torn, not drilled.
  const biteAngle1 = 120 * Math.PI / 180;          // clockwise from 12 o'clock, matches the app's own ring-progress convention (transform: rotate(-90deg))
  const bite1Dist  = ringR;
  const bite1R     = size * 0.1211;
  const biteAngle2 = 132 * Math.PI / 180;
  const bite2Dist  = size * 0.3203;
  const bite2R     = size * 0.0469;

  const bite1 = { x: cx + bite1Dist * Math.sin(biteAngle1), y: cy - bite1Dist * Math.cos(biteAngle1), r: bite1R };
  const bite2 = { x: cx + bite2Dist * Math.sin(biteAngle2), y: cy - bite2Dist * Math.cos(biteAngle2), r: bite2R };

  function inRoundedSquare(x, y) {
    const half = size / 2, r = cornerR;
    const ax = Math.abs(x - cx), ay = Math.abs(y - cy);
    if (ax >= half || ay >= half) return false;
    if (ax <= half - r || ay <= half - r) return true;
    return (ax - (half - r)) ** 2 + (ay - (half - r)) ** 2 <= r * r;
  }

  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      let r, g, b, a;

      if (!inRoundedSquare(x, y)) {
        [r, g, b, a] = [0, 0, 0, 0];
      } else {
        [r, g, b, a] = [...BG, 255];

        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        const onRing = Math.abs(dist - ringR) <= ringHalfW;
        const inBite = (x - bite1.x) ** 2 + (y - bite1.y) ** 2 <= bite1.r ** 2
                    || (x - bite2.x) ** 2 + (y - bite2.y) ** 2 <= bite2.r ** 2;

        if (onRing && !inBite) [r, g, b] = ACCENT;
      }

      pixels[idx]   = r;
      pixels[idx+1] = g;
      pixels[idx+2] = b;
      pixels[idx+3] = a;
    }
  }

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    pixels.copy(row, 1, y * size * 4, (y + 1) * size * 4);
    rows.push(row);
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows), { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const out = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(out, makePNG(size));
  console.log(`Generated ${out} (${fs.statSync(out).size} bytes)`);
}
