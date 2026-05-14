/**
 * Generates icon-192.png and icon-512.png for Plated.
 * Pure Node.js — only uses built-in zlib. No npm packages needed.
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// CRC32 (required by PNG format)
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
  const crcIn = Buffer.concat([typeB, data]);
  const crcB  = Buffer.alloc(4); crcB.writeUInt32BE(crc32(crcIn));
  return Buffer.concat([len, typeB, data, crcB]);
}

function makePNG(size) {
  const cx = size / 2, cy = size / 2;

  // Design: dark bg + violet outer ring + dashed middle ring + filled center dot
  const outerR  = size * 0.40;
  const outerW  = size * 0.028;
  const midR    = size * 0.27;
  const midW    = size * 0.016;
  const dashLen = size * 0.07;
  const innerR  = size * 0.09;
  const cornerR = size * 0.22; // rounded square corners

  // BG: #0d0d0f, Accent: #c8b8ff
  const BG  = [13,  13,  15 ];
  const ACC = [200, 184, 255];

  // Rounded square mask (like an iOS icon)
  function inRoundedSquare(x, y) {
    const half = size / 2;
    const r    = cornerR;
    const ax   = Math.abs(x - cx);
    const ay   = Math.abs(y - cy);
    if (ax > half || ay > half) return false;
    if (ax <= half - r || ay <= half - r) return true;
    return (ax - (half - r)) ** 2 + (ay - (half - r)) ** 2 <= r * r;
  }

  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx   = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx  = (y * size + x) * 4;

      let [r, g, b, a] = [...BG, inRoundedSquare(x, y) ? 255 : 0];

      if (a === 255) {
        // Outer solid ring
        if (Math.abs(dist - outerR) <= outerW / 2) { [r, g, b] = ACC; }
        // Middle dashed ring
        else if (Math.abs(dist - midR) <= midW / 2) {
          const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
          const step  = (dashLen / midR) * (180 / Math.PI);
          if (Math.floor(angle / step) % 2 === 0) [r, g, b] = ACC;
        }
        // Inner filled dot
        else if (dist <= innerR) { [r, g, b] = ACC; }
      }

      pixels[idx]   = r;
      pixels[idx+1] = g;
      pixels[idx+2] = b;
      pixels[idx+3] = a;
    }
  }

  // Build raw scanline data (filter byte 0 + RGBA per row)
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // None filter
    pixels.copy(row, 1, y * size * 4, (y + 1) * size * 4);
    rows.push(row);
  }
  const compressed = zlib.deflateSync(Buffer.concat(rows), { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]), // PNG signature
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
