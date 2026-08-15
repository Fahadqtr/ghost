import "server-only";
// CH.6B — Snoonu missing-image recovery orchestrator (SERVER).
//
// Two operations: a READ-ONLY scan/preview and a WRITER-GATED apply. The apply
// only ever touches confirmed MATCHED rows, fetches the source image through the
// repo SSRF guard (safeFetchImage) restricted to allow-listed Snoonu hosts,
// validates it is a real image, and writes through the EXISTING media boundary
// (storePrimaryProductImage) — no second storage system, no bypass of the CH.3b
// writer allow-list. Detailed errors are logged server-side; callers get safe
// public messages.
//
// NOT wired into any UI/route in CH.6B (additive). With the default session
// (session_required) it performs no fetch and no write.

import { isSignedIn } from "@/lib/auth/requireUser";
import { requireMalakWriter } from "@/lib/malak/authz";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeFetchImage } from "@/lib/net/safeImage";
import { storePrimaryProductImage } from "@/lib/products/imageStore";
import { safeError } from "@/lib/security/safe-error";
import {
  type ApplyItemResult,
  type ImageCandidateProduct,
  type MerchantListing,
  type SnoonuMerchantSession,
  type SnoonuStorefrontKey,
} from "./merchant-contract.ts";
import { scanMissingImages, type MissingImageScanResult } from "./missing-image-scan.ts";
import { planImageImport, plannedNonImportResult } from "./import-plan.ts";
import { isAllowedSnoonuImageUrl } from "./image-host-policy.ts";
import { validateFetchedImage } from "./image-safety.ts";
import { createSnoonuMerchantSession } from "./session.server.ts";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

interface ProductRow { id: string; sku: string | null; barcode: string | null; hasPrimaryImage: boolean }

async function pageAll(make: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown | null }>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make(from, from + 999);
    if (error || !Array.isArray(data)) break;
    out.push(...data.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object"));
    if (data.length < 1000) break;
  }
  return out;
}

function toProductRow(r: Record<string, unknown>): ProductRow {
  return { id: str(r.id) ?? "", sku: str(r.sku), barcode: str(r.barcode), hasPrimaryImage: !!(str(r.image_url) || str(r.image_filename)) };
}

/** ECL SPI (this storefront, active) for the given product ids. */
async function spiMap(sb: ReturnType<typeof createClient>, storefrontKey: string, productIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (!productIds.length) return map;
  for (let i = 0; i < productIds.length; i += 300) {
    const chunk = productIds.slice(i, i + 300);
    const { data } = await (sb as unknown as { from: (t: string) => any })
      .from("external_channel_listings")
      .select("product_id, external_product_id")
      .eq("storefront_key", storefrontKey)
      .eq("mapping_status", "active")
      .in("product_id", chunk);
    for (const r of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
      const pid = str(r.product_id); const spi = str(r.external_product_id);
      if (pid && spi) map.set(pid, spi);
    }
  }
  return map;
}

async function merchantListings(session: SnoonuMerchantSession, spiByProduct: Map<string, string | null>): Promise<Map<string, MerchantListing | null>> {
  const out = new Map<string, MerchantListing | null>();
  for (const [pid, spi] of spiByProduct) {
    if (!spi) { out.set(pid, null); continue; }
    try { const r = await session.findListingBySpi(spi); out.set(pid, r.listing); }
    catch { out.set(pid, null); }
  }
  return out;
}

/** READ-ONLY per-storefront missing-image preview. No writes. */
export async function scanSnoonuMissingImages(
  storefrontKey: SnoonuStorefrontKey,
  opts: { session?: SnoonuMerchantSession } = {},
): Promise<MissingImageScanResult | { error: string }> {
  if (!(await isSignedIn())) return { error: "غير مسجّل الدخول." };
  const sb = createClient();
  const productRows = (await pageAll((f, t) => sb.from("products").select("id, sku, barcode, image_url, image_filename").range(f, t))).map(toProductRow).filter((p) => p.id);
  const candidates: ImageCandidateProduct[] = productRows.filter((p) => !p.hasPrimaryImage).map((p) => ({ id: p.id, sku: p.sku, barcode: p.barcode, hasPrimaryImage: false }));

  const spiByProduct = await spiMap(sb, storefrontKey, candidates.map((c) => c.id));
  const session = opts.session ?? createSnoonuMerchantSession(storefrontKey);
  const sessionState = await session.state();
  const listingByProduct = sessionState === "authenticated" ? await merchantListings(session, spiByProduct) : new Map<string, MerchantListing | null>();

  return scanMissingImages({ storefrontKey, products: candidates, spiByProduct, listingByProduct, sessionState });
}

/** WRITER-GATED apply: import only confirmed MATCHED rows. */
export async function applySnoonuImageImports(
  storefrontKey: SnoonuStorefrontKey,
  selectedProductIds: string[],
  opts: { session?: SnoonuMerchantSession } = {},
): Promise<{ results: ApplyItemResult[] } | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };

  const selected = new Set(selectedProductIds.filter(Boolean));
  if (selected.size === 0) return { results: [] };

  const scan = await scanSnoonuMissingImages(storefrontKey, opts);
  if ("error" in scan) return { error: scan.error };

  // Fresh image state (idempotency / stale-preview protection).
  const sb = createClient();
  const freshRows = (await pageAll((f, t) => sb.from("products").select("id, image_url, image_filename").in("id", [...selected]).range(f, t))).map(toProductRow);
  const hasImageNow = new Map(freshRows.map((r) => [r.id, r.hasPrimaryImage]));

  const results: ApplyItemResult[] = [];
  const inScan = new Set(scan.rows.map((r) => r.productId));
  for (const pid of selected) {
    if (!inScan.has(pid)) results.push({ productId: pid, status: "SKIPPED", reason: "already has a valid image or not a candidate" });
  }

  const plan = planImageImport({ rows: scan.rows, selected, hasImageNow });
  const admin = createAdminClient();
  for (const item of plan) {
    if (item.action !== "import") { results.push(plannedNonImportResult(item)); continue; }
    try {
      if (!isAllowedSnoonuImageUrl(item.merchantImageUrl)) {
        results.push({ productId: item.productId, status: "FAILED", reason: "image source host not allowed" });
        continue;
      }
      const res = await safeFetchImage(item.merchantImageUrl as string);
      if (!res.ok) { results.push({ productId: item.productId, status: "FAILED", reason: safeError("ch6b.fetch", `status ${res.status}`, "تعذّر جلب الصورة.") }); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      const ct = res.headers.get("content-type");
      const safe = validateFetchedImage({ contentType: ct, byteLength: buf.byteLength, headBytes: buf.subarray(0, 16) });
      if (!safe.ok) { results.push({ productId: item.productId, status: "FAILED", reason: safeError("ch6b.validate", safe.reason ?? "", "الملف ليس صورة صالحة.") }); continue; }
      const type = (ct ?? "image/jpeg").split(";")[0].trim();
      const file = new File([buf], `snoonu-${item.spi ?? item.productId}.img`, { type });
      const stored = await storePrimaryProductImage(admin, item.productId, file, `CH.6B Snoonu image recovery (${storefrontKey})`);
      if ("error" in stored) { results.push({ productId: item.productId, status: "FAILED", reason: safeError("ch6b.store", stored.error, "تعذّر حفظ الصورة.") }); continue; }
      results.push({ productId: item.productId, status: "IMPORTED", url: stored.url });
    } catch (e) {
      results.push({ productId: item.productId, status: "FAILED", reason: safeError("ch6b.apply", e, "تعذّر استيراد الصورة.") });
    }
  }
  return { results };
}
