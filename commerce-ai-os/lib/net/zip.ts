// Minimal, dependency-free ZIP writer (PURE).
//
// Builds a standard ZIP (local headers + central directory + EOCD) with the
// STORE method (no compression — JPEG/PNG/WebP don't shrink and STORE keeps the
// writer trivial and fast). It mirrors the proven inline writer in the image
// export route, extracted here so the Talabat package generator can reuse it.
// UTF-8 entry names (flag bit 11). No ZIP64 — fine for < 4 GB total and < 65535
// entries. Framework-free (Uint8Array/DataView only) so node:test loads it and
// it runs in any server runtime.

const enc = new TextEncoder();

// ── CRC-32 ──────────────────────────────────────────────────────────────────
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

/** CRC-32 of a byte buffer (the checksum every ZIP record header carries). */
export function crc32(buf: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── record builders ───────────────────────────────────────────────────────────
function localHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const h = new Uint8Array(30 + name.length);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true); // version needed
  dv.setUint16(6, 0x0800, true); // flag: UTF-8 filename
  dv.setUint16(8, 0, true); // method: store
  dv.setUint16(10, 0, true); // mod time
  dv.setUint16(12, 0, true); // mod date
  dv.setUint32(14, crc, true);
  dv.setUint32(18, size, true); // compressed size
  dv.setUint32(22, size, true); // uncompressed size
  dv.setUint16(26, name.length, true);
  dv.setUint16(28, 0, true); // extra length
  h.set(name, 30);
  return h;
}

function centralHeader(e: { name: Uint8Array; crc: number; size: number; offset: number }): Uint8Array {
  const h = new Uint8Array(46 + e.name.length);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, 0x02014b50, true);
  dv.setUint16(4, 20, true); // version made by
  dv.setUint16(6, 20, true); // version needed
  dv.setUint16(8, 0x0800, true); // flag: UTF-8
  dv.setUint16(10, 0, true); // method: store
  dv.setUint16(12, 0, true);
  dv.setUint16(14, 0, true);
  dv.setUint32(16, e.crc, true);
  dv.setUint32(20, e.size, true);
  dv.setUint32(24, e.size, true);
  dv.setUint16(28, e.name.length, true);
  dv.setUint16(30, 0, true); // extra
  dv.setUint16(32, 0, true); // comment
  dv.setUint16(34, 0, true); // disk #
  dv.setUint16(36, 0, true); // internal attrs
  dv.setUint32(38, 0, true); // external attrs
  dv.setUint32(42, e.offset, true);
  h.set(e.name, 46);
  return h;
}

function eocd(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const h = new Uint8Array(22);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, count, true);
  dv.setUint16(10, count, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdOffset, true);
  return h;
}

export interface ZipEntry {
  /** archive path, e.g. "Talabat/images/mk1.jpg" (forward slashes only). */
  name: string;
  data: Uint8Array;
}

// ── incremental (segmented) assembly ─────────────────────────────────────────
//
// A ZIP can be assembled from independently-produced SEGMENTS: each entry
// segment is `local header + data` (STORE, CRC known upfront — no data
// descriptor), and the archive is the ordered concatenation of entry segments
// followed by one directory segment (central directory + EOCD) whose records
// carry each entry's absolute byte offset. This lets a large archive be built
// chunk-by-chunk in durable storage without ever holding all bytes in memory:
// concat(part files) + directory === buildZip(entries) for the same input.

/** Central-directory bookkeeping for one already-written entry segment. */
export interface ZipSegmentEntry {
  name: string;
  crc: number;
  size: number;
  /** absolute offset of the entry's local header in the final archive. */
  offset: number;
}

/** One entry as a self-contained byte segment (local header + STORE data). */
export function zipEntrySegment(name: string, data: Uint8Array): { bytes: Uint8Array; crc: number; size: number } {
  const nameBytes = enc.encode(name);
  const crc = crc32(data);
  return { bytes: concat([localHeader(nameBytes, crc, data.length), data]), crc, size: data.length };
}

/** The closing directory segment (central directory + EOCD) for entries whose
 *  segments were written, in order, starting at archive offset 0. */
export function zipDirectorySegment(entries: readonly ZipSegmentEntry[]): Uint8Array {
  const cdOffset = entries.reduce((at, e) => Math.max(at, e.offset + 30 + enc.encode(e.name).length + e.size), 0);
  const chunks: Uint8Array[] = [];
  let cdSize = 0;
  for (const e of entries) {
    const ch = centralHeader({ name: enc.encode(e.name), crc: e.crc, size: e.size, offset: e.offset });
    chunks.push(ch);
    cdSize += ch.length;
  }
  chunks.push(eocd(entries.length, cdSize, cdOffset));
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Build a complete ZIP archive from in-memory entries and return its bytes.
 * Entries are written in the given order (deterministic). Duplicate names are
 * the caller's responsibility — this writer does not de-duplicate.
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const lh = localHeader(nameBytes, crc, e.data.length);
    chunks.push(lh, e.data);
    central.push({ name: nameBytes, crc, size: e.data.length, offset });
    offset += lh.length + e.data.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const e of central) {
    const ch = centralHeader(e);
    chunks.push(ch);
    cdSize += ch.length;
  }
  chunks.push(eocd(central.length, cdSize, cdStart));

  return concat(chunks);
}
