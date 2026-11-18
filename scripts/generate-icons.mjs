import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function renderIconRgba(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.44;
  const corner = size * 0.19;

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // PNG filter type 0
    for (let x = 0; x < size; x += 1) {
      const px = rowStart + 1 + x * 4;
      const dx = Math.max(0, Math.abs(x - cx) - (radius - corner));
      const dy = Math.max(0, Math.abs(y - cy) - (radius - corner));
      const dist = Math.hypot(dx, dy);

      if (dist > corner) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      // Base indigo squircle #6D4AFF -> #4F32D6 vertical gradient
      const t = y / size;
      let r = Math.round(109 * (1 - t) + 79 * t);
      let g = Math.round(74 * (1 - t) + 50 * t);
      let b = Math.round(255 * (1 - t) + 214 * t);

      // Subtle inner border highlight
      if (dist > corner - Math.max(1.5, size * 0.015)) {
        r = Math.min(255, r + 28);
        g = Math.min(255, g + 28);
        b = Math.min(255, b + 15);
      }

      // Crisp geometric "V" glyph in white
      const nx = (x - cx) / size;
      const ny = (y - cy) / size;
      if (ny >= -0.22 && ny <= 0.24) {
        const expectedX = Math.abs(nx);
        const targetX = (0.24 - ny) * 0.56;
        if (Math.abs(expectedX - targetX) <= 0.068 && expectedX <= 0.28) {
          r = 255;
          g = 255;
          b = 255;
        }
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }
  return raw;
}

function encodePng(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(renderIconRgba(size));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIcoFromPngs(pngEntries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngEntries.length, 4);

  const dir = Buffer.alloc(16 * pngEntries.length);
  let offset = 6 + dir.length;

  pngEntries.forEach(({ size, data }, idx) => {
    const base = idx * 16;
    dir[base] = size >= 256 ? 0 : size;
    dir[base + 1] = size >= 256 ? 0 : size;
    dir[base + 2] = 0;
    dir[base + 3] = 0;
    dir.writeUInt16LE(1, base + 4);
    dir.writeUInt16LE(32, base + 6);
    dir.writeUInt32LE(data.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...pngEntries.map((e) => e.data)]);
}

const outDir = path.resolve(process.cwd(), 'electron', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const png256 = encodePng(256);
const png64 = encodePng(64);
const png32 = encodePng(32);
const png16 = encodePng(16);

fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
fs.writeFileSync(
  path.join(outDir, 'icon.ico'),
  buildIcoFromPngs([
    { size: 256, data: png256 },
    { size: 64, data: png64 },
    { size: 32, data: png32 },
    { size: 16, data: png16 },
  ])
);

console.log(`Generated desktop icons in ${outDir}`);
