import "server-only";
import { requireMalakWriter } from "@/lib/malak/authz";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeFetchImage } from "@/lib/net/safeImage";
import { storePrimaryProductImage } from "@/lib/products/imageStore";
import { safeError } from "@/lib/security/safe-error";
import { insertAuditRow } from "@/lib/audit";
import { SNOONU_STOREFRONT_KEYS } from "./merchant-contract";
import type { SnoonuStorefrontKey } from "./merchant-contract";
import { runSnoonuDiscovery } from "./discovery-engine";
import { createConfiguredSnoonuDiscoveryProvider } from "./live-adapter.server";
import { testSnoonuSession } from "./session-status.server";
import { isAllowedSnoonuImageUrl } from "./image-host-policy";
import { validateFetchedImage } from "./image-safety";
import { decideSnoonuRecovery } from "./recovery-model";
import type { RecoveryOutcome } from "./recovery-model";

// MEDIA.1C — Snoonu image recovery orchestrator (SERVER, WRITER-GATED).
//
// Recovers ONE product's missing primary image from ONE Snoonu storefront.
// Everything is reused, nothing re-invented:
//   • discovery = MEDIA.1B engine + the MEDIA.1A-P2/P3 live provider (re-run
//     FRESH here — search order and classification are untouched);
//   • eligibility = the pure decision model (SAFE_MATCH one-confirm; NEEDS_REVIEW
//     requires an explicit operator-selected SPI; no name-only auto-accept);
//   • image safety = allow-listed Snoonu hosts (image-host-policy) + the repo
//     SSRF guard (safeFetchImage) + byte validation (image-safety);
//   • the ONLY write is the certified media boundary storePrimaryProductImage —
//     no direct product_images insert, no direct products.image_url update, no
//     second storage path; no ECL / inventory / availability / lifecycle /
//     channel mutation of any kind (readiness surfaces update naturally).
// Stale protection: the product's image state and the discovery result are both
// re-established here, immediately before the write; an existing image is never
// overwritten. Storefronts stay isolated (this storefront's provider/session
// only). The audit row carries identifiers only — never headers/session material.

export interface RecoverImageInput {
  productId: string;
  storefrontKey: SnoonuStorefrontKey;
  /** Operator-selected candidate SPI (required for NEEDS_REVIEW; pins identity for SAFE_MATCH). */
  confirmedSpi?: string | null;
}

interface FreshProduct {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string | null;
  hasPrimaryImage: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

async function readFreshProduct(productId: string): Promise<FreshProduct | null> {
  try {
    const sb = createClient();
    const { data, error } = await sb
      .from("products")
      .select("id, sku, barcode, name_en, name_ar, image_url, image_filename")
      .eq("id", productId)
      .limit(1);
    if (error) return null;
    const r = (data ?? [])[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      sku: str(r.sku),
      barcode: str(r.barcode),
      name: str(r.name_en) ?? str(r.name_ar),
      hasPrimaryImage: !!(str(r.image_url) || str(r.image_filename)),
    };
  } catch {
    return null;
  }
}

/**
 * WRITER-GATED single-product image recovery. Returns a safe outcome per
 * MEDIA.1C's fixed result states; never throws, never returns secret material.
 */
export async function recoverSnoonuImage(input: RecoverImageInput): Promise<RecoveryOutcome> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { status: "FAILED", reason: writer.error };

  const storefrontKey = SNOONU_STOREFRONT_KEYS.find((k) => k === input.storefrontKey);
  if (!storefrontKey) return { status: "FAILED", reason: "متجر غير معروف." };
  const productId = str(input.productId);
  if (!productId) return { status: "FAILED", reason: "منتج غير محدد." };

  // 1) The storefront's OWN session must be proven CONNECTED (real read).
  const session = await testSnoonuSession(storefrontKey);
  const sessionConnected = session.state === "CONNECTED";

  // 2) FRESH product read — stale protection (an existing image is never replaced).
  const product = await readFreshProduct(productId);
  if (!product) return { status: "FAILED", reason: "المنتج غير موجود." };

  // 3) FRESH discovery for THIS storefront only (MEDIA.1B order + classification).
  const result = sessionConnected
    ? await runSnoonuDiscovery(createConfiguredSnoonuDiscoveryProvider(storefrontKey), {
        storefrontKey,
        barcode: product.barcode,
        sku: product.sku,
        name: product.name,
      }).catch(() => null)
    : null;

  // 4) Pure eligibility decision on the fresh facts.
  const decision = decideSnoonuRecovery({
    hasPrimaryImage: product.hasPrimaryImage,
    sessionConnected,
    classification: result?.classification ?? "ERROR",
    candidates: result?.candidates ?? [],
    confirmedSpi: str(input.confirmedSpi ?? null),
  });
  if (!decision.allow) return { status: decision.status, reason: decision.reason };
  const candidate = decision.candidate;
  const imageUrl = candidate.imageUrl as string;

  // 5) Image safety: allow-listed Snoonu host + SSRF-guarded fetch + byte checks.
  if (!isAllowedSnoonuImageUrl(imageUrl)) {
    return { status: "FAILED", reason: "مصدر الصورة ليس من مضيف Snoonu المسموح." };
  }
  try {
    const res = await safeFetchImage(imageUrl);
    if (!res.ok) return { status: "FAILED", reason: safeError("media1c.fetch", `status ${res.status}`, "تعذّر جلب الصورة من المصدر.") };
    const buf = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type");
    const safe = validateFetchedImage({ contentType, byteLength: buf.byteLength, headBytes: buf.subarray(0, 16) });
    if (!safe.ok) return { status: "FAILED", reason: safeError("media1c.validate", safe.reason ?? "", "الملف ليس صورة صالحة.") };

    // 6) The ONLY write: the certified media boundary (bucket + product_images +
    //    primary flag all handled inside storePrimaryProductImage).
    const type = (contentType ?? "image/jpeg").split(";")[0].trim();
    const file = new File([buf], `snoonu-${candidate.spi ?? productId}.img`, { type });
    const admin = createAdminClient();
    const stored = await storePrimaryProductImage(admin, productId, file, `MEDIA.1C Snoonu recovery (${storefrontKey})`);
    if ("error" in stored) return { status: "FAILED", reason: safeError("media1c.store", stored.error, "تعذّر حفظ الصورة.") };

    // 7) Best-effort audit: identifiers only — NO headers, NO session material.
    await insertAuditRow(admin, {
      agent: "snoonu_media_recovery",
      action: "IMAGE_RECOVERED_FROM_SNOONU",
      action_type: "IMAGE_RECOVERED_FROM_SNOONU",
      actor: writer.email,
      sku: product.sku,
      product_id: productId,
      status: "done",
      details: {
        productId,
        storefrontKey,
        externalProductId: candidate.spi,
        matchReason: result?.matchReason ?? null,
        at: new Date().toISOString(),
      },
    }).catch(() => {});

    return { status: "RECOVERED", reason: "تم استيراد الصورة وتعيينها أساسية.", url: stored.url };
  } catch (e) {
    return { status: "FAILED", reason: safeError("media1c.recover", e, "تعذّر استرجاع الصورة.") };
  }
}
