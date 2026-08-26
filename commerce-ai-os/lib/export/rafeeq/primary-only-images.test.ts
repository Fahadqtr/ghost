// RAFEEQ IMAGES — PRIMARY ONLY + ORIGINAL QUALITY (owner contract) tests.
// Proves, end-to-end through the chunked job engine with fake ports:
//   1. simple product  → exactly 1 primary image
//   2. gallery product → only the primary is packaged
//   3. option product  → exactly 1 shared parent image (options add none)
//   4. gallery URLs are NEVER fetched
//   5. variant image URLs are NEVER fetched
//   6+7. packaged bytes === downloaded bytes (SHA-256 equal — no resize/
//        recompress/re-encode; STORE keeps them verbatim)
//   8. no duplicate image entries
//   9. data + Malikas Reference + Options Overview all reference the ONE
//      packaged parent primary filename
//   10. manifest image_count = primary-only count; product_identity_count =
//       included parents
// node --conditions=react-server --experimental-strip-types --test lib/export/rafeeq/primary-only-images.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { crc32 } from "../../net/zip.ts";
import { buildRafeeqPreview, type RafeeqPreviewProduct, type RafeeqPreviewVariant } from "./preview.ts";
import { createRafeeqPackageJob, advanceRafeeqPackageJob, type RafeeqPackageJobState, type RafeeqPackageJobPlan, type RafeeqJobPorts } from "./package-job.ts";
import { NATIVE_COL } from "./native-template.ts";
import { REFERENCE_COL } from "./reference.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function variant(id: string, sku: string, over: Partial<RafeeqPreviewVariant> = {}): RafeeqPreviewVariant {
  return { id, sku, barcode: "6291041500301", nameEn: `Option ${id}`, nameAr: `خيار ${id}`, price: null, ...over };
}
function product(id: string, sku: string, over: Partial<RafeeqPreviewProduct> = {}): RafeeqPreviewProduct {
  return {
    id, sku, barcode: "6291041500213",
    nameEn: `Product ${sku}`, nameAr: `منتج ${sku}`,
    category: "Makeup", price: 100, discountPrice: null,
    descriptionEn: "en", descriptionAr: "ar",
    imageUrl: `https://cdn.example.com/${sku}-primary.jpg`, imageFilename: `${sku}.jpg`,
    galleryImageUrls: [], imageCount: 1,
    lifecycleState: "ACTIVE", platformStatus: "Active",
    ...over,
  };
}

// simple product with 3 canonical gallery URLs + option product with gallery:
// the contract must package exactly ONE primary each and fetch nothing else.
const PRODUCTS = [
  product("p1", "mk10", { galleryImageUrls: [
    "https://cdn.example.com/mk10-g1.jpg",
    "https://cdn.example.com/mk10-g2.jpg",
    "https://cdn.example.com/mk10-g3.jpg",
  ], imageCount: 4 }),
  product("p2", "mk20", {
    galleryImageUrls: ["https://cdn.example.com/mk20-g1.jpg"],
    imageCount: 2,
    variants: [variant("v1", "mk20-1-red", { nameEn: "Red" }), variant("v2", "mk20-2-gold", { nameEn: "Gold" })],
  }),
];

interface World { ports: RafeeqJobPorts; parts: Map<string, Uint8Array>; fetches: string[]; imageBytes: Map<string, Uint8Array> }
function world(): World {
  const w: World = {
    parts: new Map(), fetches: [], imageBytes: new Map(),
    ports: {
      async fetchImage(url: string) {
        w.fetches.push(url);
        // deterministic, URL-unique, binary-ish bytes (with high bit values)
        const bytes = new Uint8Array(2048).map((_, i) => (i * 31 + url.length * 7 + url.charCodeAt(i % url.length)) % 256);
        w.imageBytes.set(url, bytes.slice());
        return { bytes, ext: "jpg" };
      },
      async putPart(path: string, bytes: Uint8Array) {
        w.parts.set(path, bytes.slice());
      },
    },
  };
  return w;
}

async function generate(): Promise<{ state: RafeeqPackageJobState; plan: RafeeqPackageJobPlan; w: World; zip: Uint8Array }> {
  const rows = buildRafeeqPreview({ products: PRODUCTS }).rows;
  const created = createRafeeqPackageJob({ jobId: "job-pri", mode: "FULL", previewRows: rows, sentBaseline: new Map(), actor: null, nowIso: "2026-08-26T00:00:00.000Z" });
  assert.ok(created.ok);
  const w = world();
  let s = created.state;
  let guard = 0;
  while (s.status === "running" && guard++ < 20) {
    s = await advanceRafeeqPackageJob(JSON.parse(JSON.stringify(s)), created.plan, { ports: w.ports });
  }
  assert.equal(s.status, "complete");
  const total = s.parts.reduce((n, p) => n + p.bytes, 0);
  const zip = new Uint8Array(total);
  let at = 0;
  for (const p of s.parts) { zip.set(w.parts.get(p.path)!, at); at += p.bytes; }
  return { state: s, plan: created.plan, w, zip };
}

/** Minimal structural ZIP reader (EOCD → central directory → entry data). */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocdOff = zip.length - 22;
  assert.equal(dv.getUint32(eocdOff, true), 0x06054b50);
  const count = dv.getUint16(eocdOff + 10, true);
  let at = dv.getUint32(eocdOff + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const crc = dv.getUint32(at + 16, true);
    const size = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const offset = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    const lhNameLen = dv.getUint16(offset + 26, true);
    const data = zip.subarray(offset + 30 + lhNameLen, offset + 30 + lhNameLen + size);
    assert.equal(crc32(data) >>> 0, crc >>> 0, `CRC ok for ${name}`);
    assert.ok(!out.has(name), `no duplicate entry: ${name}`);
    out.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test("1+2+3+8: exactly ONE primary image per included product — gallery/option products add none, no duplicates", async () => {
  const { state, zip } = await generate();
  const entries = readZip(zip);
  const images = [...entries.keys()].filter((n) => n.startsWith("images/"));
  assert.deepEqual(images.sort(), ["images/mk10.jpg", "images/mk20.jpg"], "one parent-SKU primary per product");
  assert.equal(state.summary?.imageCount, 2, "image_count counts primaries only");
  assert.equal(state.summary?.productRowCount, 2, "product_identity_count = included parents");
  assert.ok(!images.some((n) => /_\d+\.[a-z]+$/i.test(n)), "no gallery (_position) file in the ZIP");
  assert.ok(!images.some((n) => n.includes("mk20-1") || n.includes("mk20-2")), "no variant image in the ZIP");
});

test("4+5: gallery URLs and variant image URLs are NEVER fetched", async () => {
  const { w } = await generate();
  assert.deepEqual(
    [...w.fetches].sort(),
    ["https://cdn.example.com/mk10-primary.jpg", "https://cdn.example.com/mk20-primary.jpg"],
    "exactly the two canonical primary URLs — nothing else was requested",
  );
  assert.ok(!w.fetches.some((u) => u.includes("-g")), "no gallery URL fetched");
  assert.ok(!w.fetches.some((u) => u.includes("mk20-1") || u.includes("mk20-2")), "no variant URL fetched");
});

test("6+7: packaged image bytes are EXACTLY the downloaded bytes — SHA-256 equal, no re-encoding", async () => {
  const { w, zip } = await generate();
  const entries = readZip(zip);
  const pairs: [string, string][] = [
    ["https://cdn.example.com/mk10-primary.jpg", "images/mk10.jpg"],
    ["https://cdn.example.com/mk20-primary.jpg", "images/mk20.jpg"],
  ];
  for (const [url, entry] of pairs) {
    const src = w.imageBytes.get(url)!;
    const packaged = entries.get(entry)!;
    assert.equal(sha256(packaged), sha256(src), `SHA-256 identical before/after packaging: ${entry}`);
    assert.deepEqual(packaged, src, "byte-for-byte identical (STORE, no recompression)");
  }
});

test("9+10: all three sheets reference the ONE packaged primary; manifest counts are primary-only", async () => {
  const { zip } = await generate();
  const entries = readZip(zip);
  const wb = XLSX.read(entries.get("rafeeq_catalog.xlsx"), { type: "array" });

  const data: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets["data"], { header: 1 });
  const imageRefs = new Set(data.slice(1).map((r) => String(r[NATIVE_COL.productImage])));
  assert.deepEqual([...imageRefs].sort(), ["mk10.jpg", "mk20.jpg"], "every data row (option rows included) references the parent primary");
  const mk20Rows = data.slice(1).filter((r) => String(r[NATIVE_COL.barcode]) === "mk20");
  assert.equal(mk20Rows.length, 2, "option product repeats one row per option");
  assert.ok(mk20Rows.every((r) => String(r[NATIVE_COL.productImage]) === "mk20.jpg"), "all option rows share the ONE parent image");

  const ref: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets["Malikas Reference"], { header: 1 });
  assert.ok(ref.slice(1).every((r) => ["mk10.jpg", "mk20.jpg"].includes(String(r[REFERENCE_COL.imageFilename]))), "reference IMAGE FILENAME = the packaged primary");

  const ov: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets["Options Overview"], { header: 1 });
  const ovImages = ov.filter((r) => r[4] === "IMAGE FILENAME").map((r) => String(r[5]));
  assert.deepEqual(ovImages, ["mk20.jpg"], "overview block references the same packaged primary");

  const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")));
  assert.equal(manifest.image_count, 2, "manifest image_count = unique parent primaries only");
  assert.equal(manifest.product_identity_count, 2, "manifest product_identity_count = included parents");
});
