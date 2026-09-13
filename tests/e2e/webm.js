/**
 * A small, independent EBML/WebM reader.
 *
 * The bundled ffmpeg in this environment is a stripped build that cannot touch
 * VP9 at all, so it cannot validate the app's default output. This parses the
 * container directly instead, which is actually the more precise tool for the
 * question being asked: if the stored chunks were concatenated in the wrong
 * order, or one went missing, the element structure stops parsing — the bytes
 * would all still be present, and only a structural reader notices.
 *
 * Nothing here decodes video. Pixel-level proof comes from Chrome playing the
 * file back, and from the VP8 ffmpeg decode in the frame-accuracy spec.
 */
import fs from 'node:fs/promises';

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TRACKS: 0x1654ae6b,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  REFERENCE_BLOCK: 0xfb,
  POSITION: 0xa7,
  PREV_SIZE: 0xab,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
};

const CLUSTER_CHILDREN = new Set([
  ID.TIMECODE, ID.SIMPLE_BLOCK, ID.BLOCK_GROUP, ID.POSITION, ID.PREV_SIZE,
]);

const UNKNOWN_SIZE = -1;

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  get eof() { return this.pos >= this.buf.length; }

  /** Element IDs keep their length marker; sizes have it stripped. */
  readId() {
    const first = this.buf[this.pos];
    if (first === undefined) return null;
    const length = leadingZeros(first) + 1;
    if (length > 4 || this.pos + length > this.buf.length) return null;
    let value = 0;
    for (let i = 0; i < length; i++) value = value * 256 + this.buf[this.pos + i];
    this.pos += length;
    return value;
  }

  readSize() {
    const first = this.buf[this.pos];
    if (first === undefined) return null;
    const length = leadingZeros(first) + 1;
    if (length > 8 || this.pos + length > this.buf.length) return null;

    let value = first & (0xff >> length);
    let allOnes = value === (0xff >> length);
    for (let i = 1; i < length; i++) {
      const byte = this.buf[this.pos + i];
      if (byte !== 0xff) allOnes = false;
      value = value * 256 + byte;
    }
    this.pos += length;
    // An all-ones size means "unknown", which is how a streaming muxer writes
    // the Segment (and often every Cluster) when it does not know the end.
    return allOnes ? UNKNOWN_SIZE : value;
  }
}

function leadingZeros(byte) {
  for (let i = 0; i < 8; i++) if (byte & (0x80 >> i)) return i;
  return 8;
}

/**
 * Walks the whole file and reports what it found.
 * `clean` is true only if parsing consumed every byte without going astray.
 */
export function parseWebm(buffer) {
  const r = new Reader(buffer);
  const result = {
    bytes: buffer.length,
    hasEbmlHeader: false,
    hasSegment: false,
    hasTracks: false,
    clusters: [],
    blocks: 0,
    keyframes: 0,
    clean: false,
    error: null,
  };

  try {
    const headerId = r.readId();
    if (headerId !== ID.EBML) throw new Error(`expected EBML header, got 0x${(headerId ?? 0).toString(16)}`);
    const headerSize = r.readSize();
    r.pos += headerSize;
    result.hasEbmlHeader = true;

    const segmentId = r.readId();
    if (segmentId !== ID.SEGMENT) throw new Error(`expected Segment, got 0x${(segmentId ?? 0).toString(16)}`);
    const segmentSize = r.readSize();
    result.hasSegment = true;

    const segmentEnd = segmentSize === UNKNOWN_SIZE ? buffer.length : Math.min(buffer.length, r.pos + segmentSize);

    while (r.pos < segmentEnd) {
      const start = r.pos;
      const id = r.readId();
      if (id === null) throw new Error(`unreadable element id at ${start}`);
      const size = r.readSize();
      if (size === null) throw new Error(`unreadable element size at ${start}`);

      if (id === ID.TRACKS) result.hasTracks = true;

      if (id === ID.CLUSTER) {
        result.clusters.push(readCluster(r, size, segmentEnd, result));
      } else if (size === UNKNOWN_SIZE) {
        throw new Error(`unexpected unknown-size element 0x${id.toString(16)} at ${start}`);
      } else {
        r.pos += size;
      }

      if (r.pos <= start) throw new Error(`parser made no progress at ${start}`);
    }

    result.clean = r.pos === segmentEnd;
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

function readCluster(r, size, segmentEnd, result) {
  const cluster = { timecode: null, blocks: 0 };
  const end = size === UNKNOWN_SIZE ? segmentEnd : Math.min(segmentEnd, r.pos + size);

  while (r.pos < end) {
    const start = r.pos;
    const id = r.readId();
    if (id === null) break;

    // An unknown-size cluster ends where something that is not one of its own
    // children begins.
    if (size === UNKNOWN_SIZE && !CLUSTER_CHILDREN.has(id)) {
      r.pos = start;
      break;
    }

    const childSize = r.readSize();
    if (childSize === null || childSize === UNKNOWN_SIZE) break;

    if (id === ID.TIMECODE) {
      let value = 0;
      for (let i = 0; i < childSize; i++) value = value * 256 + r.buf[r.pos + i];
      cluster.timecode = value;
    } else if (id === ID.SIMPLE_BLOCK) {
      cluster.blocks++;
      result.blocks++;
      // Flags byte sits after the track-number vint and the 2-byte timecode.
      const trackLen = leadingZeros(r.buf[r.pos]) + 1;
      const flags = r.buf[r.pos + trackLen + 2];
      if (flags & 0x80) result.keyframes++;
    } else if (id === ID.BLOCK_GROUP) {
      // Chrome's MediaRecorder writes BlockGroup/Block rather than SimpleBlock.
      // A BlockGroup with no ReferenceBlock refers to nothing, i.e. a keyframe.
      cluster.blocks++;
      result.blocks++;
      if (!blockGroupHasReference(r.buf, r.pos, r.pos + childSize)) result.keyframes++;
    }

    r.pos += childSize;
    if (r.pos <= start) break;
  }

  return cluster;
}

/** Scans a BlockGroup's children for a ReferenceBlock. */
function blockGroupHasReference(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const idLength = leadingZeros(buf[pos]) + 1;
    let id = 0;
    for (let i = 0; i < idLength; i++) id = id * 256 + buf[pos + i];
    pos += idLength;

    const sizeLength = leadingZeros(buf[pos]) + 1;
    let size = buf[pos] & (0xff >> sizeLength);
    for (let i = 1; i < sizeLength; i++) size = size * 256 + buf[pos + i];
    pos += sizeLength;

    if (id === ID.REFERENCE_BLOCK) return true;
    pos += size;
  }
  return false;
}

export async function parseWebmFile(filePath) {
  return parseWebm(await fs.readFile(filePath));
}
