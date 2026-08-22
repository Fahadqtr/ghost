import "server-only";
import { isSignedIn } from "@/lib/auth/requireUser";
import { createClient } from "@/lib/supabase/server";
import { SNOONU_STOREFRONT_KEYS } from "./merchant-contract";
import type { ImagePreviewSummary, SnoonuStorefrontKey } from "./merchant-contract";
import type { MissingImageScanResult } from "./missing-image-scan";
import type { DiscoveryResult } from "./discovery-contract";
import { runSnoonuDiscovery } from "./discovery-engine";
import { createConfiguredSnoonuDiscoveryProvider } from "./live-adapter.server";
import type { LiveLookupTrace } from "./live-adapter.server";
import { buildRowModeTrace, discoveryResultToPreviewRow, unlinkedProductToPreviewRow } from "./recovery-model";

// MEDIA.1C-HOTFIX2 — LIVE missing-image batch scan (SERVER, READ-ONLY).
//
// Replaces the Media Center's legacy CH.6B scan path, which resolved the
// session through the no-op SnoonuMerchantSession SPI port (state() hardcoded
// to session_required) and therefore reported SESSION_REQUIRED for every
// candidate no matter what was provisioned. This scan runs the SAME live
// pipeline as the per-product discovery page: ONE configured provider per
// storefront (its session probe is memoized — one probe per scan; per-term
// reads are memoized too), the untouched MEDIA.1B engine per candidate, and a
// pure mapping into the existing CH.6B row/summary shape so the Media Center
// UI is unchanged. Read-only: no writes of any kind here; bulk apply goes
// through the MEDIA.1C recovery orchestrator per item.

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

interface Candidate {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string | null;
}

async function readLinkedProductIds(storefrontKey: SnoonuStorefrontKey): Promise<Set<string> | null> {
  const sb = createClient();
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("external_channel_listings")
      .select("product_id, external_product_id")
      .eq("storefront_key", storefrontKey)
      .eq("mapping_status", "active")
      .not("external_product_id", "is", null)
      .range(from, from + 999);
    if (error) return null;
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      const productId = str(row.product_id);
      const spi = str(row.external_product_id);
      if (productId && spi) ids.add(productId);
    }
    if (rows.length < 1000) break;
  }
  return ids;
}

async function readMissingImageCandidates(): Promise<Candidate[] | null> {
  const sb = createClient();
  const out: Candidate[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("products")
      .select("id, sku, barcode, name_en, name_ar, image_url, image_filename")
      .range(from, from + 999);
    if (error) return null;
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      const id = str(r.id);
      if (!id) continue;
      const hasImage = !!(str(r.image_url) || str(r.image_filename));
      if (hasImage) continue;
      out.push({ id, sku: str(r.sku), barcode: str(r.barcode), name: str(r.name_en) ?? str(r.name_ar) });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

const SCAN_CONCURRENCY = 4;

/**
 * READ-ONLY per-storefront missing-image scan via the LIVE discovery pipeline.
 * Returns the exact CH.6B result shape the Media Center already renders.
 */
export async function scanSnoonuMissingImagesLive(
  storefrontKey: SnoonuStorefrontKey,
): Promise<MissingImageScanResult | { error: string }> {
  if (!(await isSignedIn())) return { error: "غير مسجّل الدخول." };
  const key = SNOONU_STOREFRONT_KEYS.find((k) => k === storefrontKey);
  if (!key) return { error: "متجر غير معروف." };

  const candidates = await readMissingImageCandidates();
  if (!candidates) return { error: "تعذّر قراءة المنتجات." };
  const linkedProductIds = await readLinkedProductIds(key);
  if (!linkedProductIds) return { error: "تعذّر قراءة روابط Snoonu." };
  // ONE provider per scan: its session probe runs at most once, and repeated
  // terms reuse the same portal read. MEDIA.1C-HOTFIX3: every lookup emits a
  // trace (memo hits included) so each row can carry per-mode evidence —
  // attempted?, transport, raw rows, exact-equality survivors — attributed by
  // (mode, term). Product terms/counts only; never config/header material.
  const emitted: LiveLookupTrace[] = [];
  const provider = createConfiguredSnoonuDiscoveryProvider(key, (t) => { emitted.push(t); });

  const results = new Map<string, DiscoveryResult>();
  for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
    const chunk = candidates.slice(i, i + SCAN_CONCURRENCY);
    const settled = await Promise.all(
      chunk.map((c) => {
        return runSnoonuDiscovery(provider, {
          storefrontKey: key,
          // Preserve the certified engine order for every missing-image row:
          // barcode → SKU → exact name → contains name. Name outcomes remain
          // NEEDS_REVIEW by the engine and are never auto-approved.
          barcode: c.barcode,
          sku: c.sku,
          name: c.name,
        })
          .catch((): DiscoveryResult => ({
            storefrontKey: key,
            sessionState: "error",
            classification: "ERROR",
            matchReason: "error",
            confidence: "none",
            candidates: [],
            candidateCount: 0,
            error: "discovery failed",
          }));
      }),
    );
    settled.forEach((r, j) => { const candidate = chunk[j]; if (candidate) results.set(candidate.id, r); });
  }

  const rows = candidates.map((c) => {
    const result = results.get(c.id);
    if (!linkedProductIds.has(c.id)) {
      // Surface positive live evidence even before ECL is linked. Name matches
      // remain review-only; exact barcode/SKU keeps the engine's SAFE_MATCH.
      // A complete miss remains explicitly UNLINKED instead of NOT_FOUND.
      return result?.classification === "SAFE_MATCH" || result?.classification === "NEEDS_REVIEW"
        ? discoveryResultToPreviewRow(c, result, buildRowModeTrace(c, emitted))
        : unlinkedProductToPreviewRow(c, key);
    }
    return result
      ? discoveryResultToPreviewRow(c, result, buildRowModeTrace(c, emitted))
      : unlinkedProductToPreviewRow(c, key);
  });
  const summary: ImagePreviewSummary = {
    missing: rows.length,
    matched: rows.filter((r) => r.matchStatus === "MATCHED").length,
    needsReview: rows.filter((r) => r.matchStatus === "NEEDS_REVIEW").length,
    notFound: rows.filter((r) => r.matchStatus === "NOT_FOUND").length,
    unlinked: rows.filter((r) => r.matchStatus === "UNLINKED").length,
    sessionRequired: rows.filter((r) => r.matchStatus === "SESSION_REQUIRED").length,
  };
  return { storefrontKey: key, rows, summary };
}
