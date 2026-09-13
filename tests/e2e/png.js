/**
 * Minimal grayscale PNG reader.
 *
 * Used to read the timestamp barcode out of frames that ffmpeg decoded, which
 * is how the recording gets verified by something other than the browser that
 * produced it. ffmpeg is asked for `-pix_fmt gray`, so this only needs to
 * handle 8-bit greyscale — enough for black-and-white squares.
 */
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

export async function readGrayPng(filePath) {
  const buf = await fs.readFile(filePath);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length; // length + type + data + crc
  }

  if (bitDepth !== 8 || colorType !== 0) {
    throw new Error(`expected 8-bit greyscale, got depth ${bitDepth} colour type ${colorType}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height);

  // Undo the per-scanline filters. One byte per pixel keeps this simple.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    const line = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1));
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? pixels[y * width + x - 1] : 0;
      const b = y > 0 ? pixels[(y - 1) * width + x] : 0;
      const c = x > 0 && y > 0 ? pixels[(y - 1) * width + x - 1] : 0;
      let value = line[x];

      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);

      pixels[y * width + x] = value & 0xff;
    }
  }

  return { width, height, pixels, at: (x, y) => pixels[y * width + x] };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reads the 8-bit barcode the capture double burns into every frame. */
export function decodeBarcode(image) {
  const SQUARE = 44;
  const BITS = 8;
  let value = 0;
  for (let bit = 0; bit < BITS; bit++) {
    const x = Math.round(20 + bit * (SQUARE + 10) + SQUARE / 2);
    const y = Math.round(20 + SQUARE / 2);
    value = (value << 1) | (image.at(x, y) > 127 ? 1 : 0);
  }
  return value;
}
