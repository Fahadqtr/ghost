// INT.2B.2 — pure ZIP writer tests.
// node --conditions=react-server --experimental-strip-types --test lib/net/zip.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { buildZip, crc32 } from "./zip.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);

test("crc32 matches the known 'hello' checksum", () => {
  assert.equal(crc32(enc.encode("hello")) >>> 0, 0x3610a686);
});

test("buildZip writes local headers, central directory and EOCD", () => {
  const zip = buildZip([
    { name: "Talabat/talabat-products.xlsx", data: enc.encode("SHEET") },
    { name: "Talabat/images/mk1.jpg", data: enc.encode("JPEGBYTES") },
  ]);
  // first local file header signature
  assert.equal(u32(zip, 0), 0x04034b50, "starts with a local file header");
  // EOCD lives at the tail (fixed 22 bytes, no comment)
  const eocdOff = zip.length - 22;
  assert.equal(u32(zip, eocdOff), 0x06054b50, "ends with EOCD");
  assert.equal(u16(zip, eocdOff + 8), 2, "records 2 entries on this disk");
  assert.equal(u16(zip, eocdOff + 10), 2, "records 2 entries total");
});

test("entry order is deterministic and names round-trip as UTF-8", () => {
  const zip = buildZip([
    { name: "Talabat/images/عربي.jpg", data: enc.encode("A") },
    { name: "Talabat/manifest.json", data: enc.encode("{}") },
  ]);
  const nameLen = u16(zip, 26);
  const name = dec.decode(zip.subarray(30, 30 + nameLen));
  assert.equal(name, "Talabat/images/عربي.jpg", "UTF-8 entry name preserved, first entry first");
});

test("each entry stores its own CRC + size", () => {
  const data = enc.encode("JPEGBYTES");
  const zip = buildZip([{ name: "a.bin", data }]);
  assert.equal(u32(zip, 14), crc32(data) >>> 0, "local header carries the entry CRC");
  assert.equal(u32(zip, 18), data.length, "compressed size = stored size (STORE)");
  assert.equal(u32(zip, 22), data.length, "uncompressed size");
});

// ── incremental (segmented) assembly ─────────────────────────────────────────

test("segmented assembly is byte-identical to buildZip for the same entries", async () => {
  const { zipEntrySegment, zipDirectorySegment } = await import("./zip.ts");
  const entries = [
    { name: "rafeeq_catalog.xlsx", data: enc.encode("SHEETBYTES") },
    { name: "images/mk1.jpg", data: enc.encode("JPEG-ONE") },
    { name: "images/عربي.webp", data: enc.encode("WEBP-TWO-LONGER") },
    { name: "manifest.json", data: enc.encode("{\"a\":1}") },
  ];
  const whole = buildZip(entries);

  const segments: Uint8Array[] = [];
  const records: { name: string; crc: number; size: number; offset: number }[] = [];
  let offset = 0;
  for (const e of entries) {
    const seg = zipEntrySegment(e.name, e.data);
    segments.push(seg.bytes);
    records.push({ name: e.name, crc: seg.crc, size: seg.size, offset });
    offset += seg.bytes.length;
  }
  segments.push(zipDirectorySegment(records));
  const total = segments.reduce((n, s) => n + s.length, 0);
  const assembled = new Uint8Array(total);
  let at = 0;
  for (const s of segments) { assembled.set(s, at); at += s.length; }

  assert.equal(assembled.length, whole.length, "same total size");
  assert.deepEqual(assembled, whole, "concat(entry segments) + directory === buildZip");
});

test("segments can be produced in independent chunks (parts) and still assemble", async () => {
  const { zipEntrySegment, zipDirectorySegment } = await import("./zip.ts");
  // two "parts" produced separately, as the chunked package job does
  const a = zipEntrySegment("p1.bin", enc.encode("AAAA"));
  const b = zipEntrySegment("p2.bin", enc.encode("BBBBBBBB"));
  const dir = zipDirectorySegment([
    { name: "p1.bin", crc: a.crc, size: a.size, offset: 0 },
    { name: "p2.bin", crc: b.crc, size: b.size, offset: a.bytes.length },
  ]);
  const whole = buildZip([
    { name: "p1.bin", data: enc.encode("AAAA") },
    { name: "p2.bin", data: enc.encode("BBBBBBBB") },
  ]);
  const assembled = new Uint8Array(a.bytes.length + b.bytes.length + dir.length);
  assembled.set(a.bytes, 0);
  assembled.set(b.bytes, a.bytes.length);
  assembled.set(dir, a.bytes.length + b.bytes.length);
  assert.deepEqual(assembled, whole);
});
