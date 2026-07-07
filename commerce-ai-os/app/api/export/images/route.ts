// Streaming ZIP of every product image → one-click download for Talabat.
//
// Builds a valid ZIP on the fly (STORE / no compression — JPEGs don't shrink)
// and streams it to the browser, fetching ONE image at a time so memory stays
// flat regardless of catalog size. Each entry is named by image_filename, so the
// archive matches the "New Image Filename" column of the Talabat CSV exactly.
//
// Zero dependencies: a tiny ZIP writer (local headers + central directory +
// EOCD) and a CRC-32 are implemented inline. Standard ZIP (no ZIP64) — fine for
// < 4 GB total and < 65535 entries.
import { createClient } from "@/lib/supabase/server";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";
import { imageFileFor } from "@/lib/talabat-diff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // large archive; needs a generous budget (Pro plan)

const enc = new TextEncoder();

// ---- CRC-32 ---------------------------------------------------------------
let CRC_TABLE: Uint32Array | null = null;
function crcTable() {
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
function crc32(buf: Uint8Array) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- ZIP record builders --------------------------------------------------
function localHeader(name: Uint8Array, crc: number, size: number) {
  const h = new Uint8Array(30 + name.length);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);     // version needed
  dv.setUint16(6, 0x0800, true); // flag: UTF-8 filename
  dv.setUint16(8, 0, true);      // method: store
  dv.setUint16(10, 0, true);     // mod time
  dv.setUint16(12, 0, true);     // mod date
  dv.setUint32(14, crc, true);
  dv.setUint32(18, size, true);  // compressed size
  dv.setUint32(22, size, true);  // uncompressed size
  dv.setUint16(26, name.length, true);
  dv.setUint16(28, 0, true);     // extra length
  h.set(name, 30);
  return h;
}
function centralHeader(e: { name: Uint8Array; crc: number; size: number; offset: number }) {
  const h = new Uint8Array(46 + e.name.length);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, 0x02014b50, true);
  dv.setUint16(4, 20, true);     // version made by
  dv.setUint16(6, 20, true);     // version needed
  dv.setUint16(8, 0x0800, true); // flag: UTF-8
  dv.setUint16(10, 0, true);     // method: store
  dv.setUint16(12, 0, true);
  dv.setUint16(14, 0, true);
  dv.setUint32(16, e.crc, true);
  dv.setUint32(20, e.size, true);
  dv.setUint32(24, e.size, true);
  dv.setUint16(28, e.name.length, true);
  dv.setUint16(30, 0, true);     // extra
  dv.setUint16(32, 0, true);     // comment
  dv.setUint16(34, 0, true);     // disk #
  dv.setUint16(36, 0, true);     // internal attrs
  dv.setUint32(38, 0, true);     // external attrs
  dv.setUint32(42, e.offset, true);
  h.set(e.name, 46);
  return h;
}
function eocd(count: number, cdSize: number, cdOffset: number) {
  const h = new Uint8Array(22);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, count, true);
  dv.setUint16(10, count, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdOffset, true);
  return h;
}

const PAGE = 1000;
async function fetchAll(q: (from: number, to: number) => any) {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

function zipResponse(products: { image_filename: string | null; image_url: string | null }[], tag: string) {
  const central: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];
  let offset = 0;
  let i = 0;
  let phase: "files" | "central" | "done" = "files";

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (phase === "files") {
          if (i >= products.length) { phase = "central"; return; }
          const p = products[i++];
          const name = String(p.image_filename).trim().replace(/^.*\//, ""); // basename
          try {
            const safe = safeImageUrlOrNull(p.image_url);
            if (!safe) return; // skip unsafe/internal URL — no entry
            const res = await safeFetchImage(safe);
            if (!res.ok) return; // skip missing source — no entry
            const data = new Uint8Array(await res.arrayBuffer());
            const nameBytes = enc.encode(name);
            const crc = crc32(data);
            const lh = localHeader(nameBytes, crc, data.length);
            controller.enqueue(lh);
            controller.enqueue(data);
            central.push({ name: nameBytes, crc, size: data.length, offset });
            offset += lh.length + data.length;
          } catch {
            // network hiccup on one image → skip it rather than fail the zip
          }
          return;
        }
        if (phase === "central") {
          const cdStart = offset;
          let cdSize = 0;
          for (const e of central) { const ch = centralHeader(e); controller.enqueue(ch); cdSize += ch.length; }
          controller.enqueue(eocd(central.length, cdSize, cdStart));
          phase = "done";
          controller.close();
        }
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="talabat-images_${tag}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

/** ZIP of the images for an explicit SKU list (the "missing on Talabat" set). */
export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let skus: string[] = [];
  try {
    const body = await req.json();
    skus = Array.isArray(body?.skus) ? body.skus.map((v: unknown) => String(v ?? "").trim().toLowerCase()).filter(Boolean) : [];
  } catch { /* empty */ }
  if (!skus.length) return new Response("skus required", { status: 400 });
  const wanted = new Set(skus.slice(0, 5000));

  // No image_filename filter here: Shopify-imported products carry image_url
  // only — their entry name is derived from the SKU (same rule as the sheet).
  const products = (await fetchAll((from2, to2) =>
    supabase.from("products")
      .select("sku, image_filename, image_url")
      .order("sku", { ascending: true })
      .range(from2, to2)
  ))
    .filter((p) => wanted.has(String(p.sku ?? "").trim().toLowerCase()) && String(p.image_url ?? "").trim())
    .map((p) => ({ ...p, image_filename: imageFileFor(p.sku, p.image_filename, p.image_url) }))
    .filter((p) => p.image_filename);

  return zipResponse(products, `missing-${products.length}`);
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  // Optional batch window (?from=&count=) so each download finishes well under
  // the serverless time limit. No params → whole catalog (use only locally).
  const url = new URL(req.url);
  const from = Math.max(0, parseInt(url.searchParams.get("from") || "0", 10) || 0);
  const countParam = parseInt(url.searchParams.get("count") || "0", 10);
  const count = Number.isFinite(countParam) && countParam > 0 ? countParam : 0;

  // Products that have a target file name + a source URL. Name the archive
  // entry by image_filename so it matches the export's New Image Filename.
  let products = (await fetchAll((from2, to2) =>
    supabase.from("products")
      .select("sku, image_filename, image_url")
      .not("image_filename", "is", null)
      .order("sku", { ascending: true })
      .range(from2, to2)
  )).filter((p) => String(p.image_filename ?? "").trim() && String(p.image_url ?? "").trim());

  if (count > 0) products = products.slice(from, from + count);

  return zipResponse(products, count > 0 ? `${from + 1}-${from + products.length}` : "all");
}
