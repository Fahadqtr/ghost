// STAFF COPY PANEL — "download all images" as one ZIP. READ-ONLY.
//
// GET /api/catalog/copy-panel/images?productId=<uuid>
//
// The request carries a PRODUCT ID, never image URLs. Every URL is resolved
// server-side from that product's own rows, so the archive cannot be steered to
// fetch someone else's photo — or any non-catalog address — by editing a query
// string. Each fetch goes through the shared SSRF guard, and the extension is
// decided by the SAME helpers channel packaging uses: the real magic bytes
// first, then the validated MIME, then the URL. Nothing is written anywhere.

import { isSignedIn } from "@/lib/auth/requireUser";
import { createClient } from "@/lib/supabase/server";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";
import { buildZip, type ZipEntry } from "@/lib/net/zip";
import { loadProductMedia } from "@/lib/products/product-media-read";
import { loadCopyPanelData } from "@/lib/catalog/copy-panel/copy-panel-read.server";
import { planProductImageZip, imagesZipFilename, type CopyPanelImage } from "@/lib/catalog/copy-panel/copy-panel";
import { sniffImageExtension, mimeToExt } from "@/lib/export/talabat/package";
import { extensionFromUrl } from "@/lib/export/image-naming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Bounded by one product's own photos — a handful of fetches, not a catalog.
export const maxDuration = 60;

/** A single product's archive is small; this only guards against a pathological row set. */
const MAX_IMAGES = 60;
const MAX_BYTES_PER_IMAGE = 25 * 1024 * 1024;

const fail = (message: string, status: number) =>
  new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function GET(req: Request) {
  if (!(await isSignedIn())) return fail("يلزم تسجيل الدخول.", 401);

  const productId = new URL(req.url).searchParams.get("productId");
  if (typeof productId !== "string" || productId.trim() === "") return fail("معرّف منتج غير صالح.", 400);

  const supabase = await createClient();

  const panel = await loadCopyPanelData(supabase as never, productId);
  if (panel.status === "notfound") return fail("لا يوجد منتج بهذا المعرّف.", 404);
  if (panel.status === "error") return fail("تعذر تحميل بيانات المنتج.", 500);

  const media = await loadProductMedia(supabase as never, productId);
  const images: CopyPanelImage[] = (media.status === "ok" ? media.state.images : []).map((i) => ({
    url: i.url,
    filename: i.filename,
    isPrimary: i.isPrimary,
  }));

  const sku = panel.data.product.sku ?? "product";
  const plan = planProductImageZip(sku, images, panel.data.variants).slice(0, MAX_IMAGES);
  if (plan.length === 0) return fail("لا توجد صور قابلة للتنزيل لهذا المنتج.", 404);

  const entries: ZipEntry[] = [];
  for (const item of plan) {
    const target = safeImageUrlOrNull(item.url);
    if (!target) continue; // not a fetchable public image — skipped, never guessed

    let res: Response;
    try {
      res = await safeFetchImage(target);
    } catch {
      continue; // one unreachable photo must not fail the whole archive
    }
    if (!res.ok) continue;

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES_PER_IMAGE) continue;

    // Real bytes win over the URL's claim — the catalog holds .jpg names over
    // PNG bytes, and an archive that lies about its contents is worse than one
    // that is a byte larger.
    const sniffed = sniffImageExtension(buf);
    if (sniffed === null) continue; // not a recognized image — skipped, not renamed
    const ext = sniffed || mimeToExt(res.headers.get("content-type")) || extensionFromUrl(target);

    const dot = item.name.lastIndexOf(".");
    const stem = dot > 0 ? item.name.slice(0, dot) : item.name;
    entries.push({ name: `${stem}.${ext}`, data: buf });
  }

  if (entries.length === 0) return fail("تعذر تنزيل أي صورة لهذا المنتج.", 502);

  const zip = buildZip(entries);
  const filename = imagesZipFilename(sku);
  return new Response(zip as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(zip.length),
      "Cache-Control": "no-store",
      "X-Image-Count": String(entries.length),
    },
  });
}
