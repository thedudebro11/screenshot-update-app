/**
 * Generates build/icon.ico — a multi-size Windows icon file.
 * Embeds green PNG blobs at 16, 32, 48, and 256px inside an ICO container.
 * Run automatically via the `predist` npm script before electron-builder packs.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES   = [16, 32, 48, 256];
const [R, G, B] = [34, 197, 94]; // same green as the runtime tray icon

function makePNG(size) {
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3]     = R;
    row[1 + x * 3 + 1] = G;
    row[1 + x * 3 + 2] = B;
  }
  const raw        = Buffer.concat(Array.from({ length: size }, () => row));
  const compressed = zlib.deflateSync(raw);

  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  function crc32(buf) {
    let v = 0xFFFFFFFF;
    for (const b of buf) v = table[(v ^ b) & 0xFF] ^ (v >>> 8);
    return (v ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const t   = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Build ICO container
const pngs = SIZES.map(makePNG);

const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);           // reserved
icoHeader.writeUInt16LE(1, 2);           // type: ICO
icoHeader.writeUInt16LE(pngs.length, 4); // image count

let offset = 6 + pngs.length * 16;
const dirEntries = pngs.map((png, i) => {
  const sz    = SIZES[i];
  const entry = Buffer.alloc(16);
  entry[0] = sz === 256 ? 0 : sz; // width  (0 encodes 256)
  entry[1] = sz === 256 ? 0 : sz; // height (0 encodes 256)
  entry[2] = 0;                    // colorCount (0 = true-color)
  entry[3] = 0;                    // reserved
  entry.writeUInt16LE(1,          4);  // planes
  entry.writeUInt16LE(32,         6);  // bit depth
  entry.writeUInt32LE(png.length, 8);  // data size
  entry.writeUInt32LE(offset,    12);  // data offset from file start
  offset += png.length;
  return entry;
});

const outPath = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.concat([icoHeader, ...dirEntries, ...pngs]));
console.log(`[generate-icon] Wrote ${outPath} (${SIZES.join(', ')}px)`);
