// INT.2A — Export Center server assembler (SERVER-ONLY, read-only).
//
// Reuses the certified read models — the operations readiness scan (one bounded
// products+variants read, NO Shopify presence) for the global catalog-readiness
// baseline, and the ECL gap-count reader for per-destination warnings. It runs
// NO destination-specific scan and writes nothing. Anything it cannot produce
// cheaply & correctly is left UNKNOWN by the pure composer.

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { loadOperationsDashboard } from "@/lib/operations/read-model";
import { loadChannelGapCounts } from "@/lib/operations/channels/gap-counts.server";
import { loadTalabatPreview } from "./talabat/preview.server";
import {
  buildExportCenter,
  UNKNOWN,
  type DestinationAdapterCounts,
  type ExportCenterModel,
  type Unknownable,
} from "./export-center.ts";

export async function loadExportCenter(now: Date = new Date()): Promise<{ model: ExportCenterModel } | { error: string }> {
  try {
    const client = createClient();

    // Global catalog-readiness baseline (reused; no Shopify presence, no new scan).
    let eligible: Unknownable<number> = UNKNOWN;
    let blocked: Unknownable<number> = UNKNOWN;
    try {
      const dash = await loadOperationsDashboard(client as never);
      if (dash.status === "ok") {
        const readiness = dash.data.readiness;
        const total = readiness.length;
        const ready = readiness.filter((r) => r.readyToPublish).length;
        eligible = ready;
        blocked = total - ready;
      }
    } catch {
      /* leave UNKNOWN */
    }

    // Per-destination ECL gap warnings (needs_review). Missing/failed ⇒ UNKNOWN.
    const warningsByDestination: Record<string, number> = {};
    try {
      // Shopify presence is not needed here (Shopify is not an ECL-gap storefront);
      // pass a neutral presence so the ECL needs_review counts still populate.
      const gaps = await loadChannelGapCounts(client as never, { available: false, mapped: 0, missing: 0, review: 0 });
      for (const [key, g] of Object.entries(gaps)) {
        if (g && typeof g.needsReview === "number") warningsByDestination[key] = g.needsReview;
      }
    } catch {
      /* leave the map empty ⇒ per-card UNKNOWN */
    }

    // Real per-destination adapter counts (INT.2B): the Talabat adapter reports
    // its own sellable-listing eligible/blocked/warnings from ONE bounded read
    // (reused here — the detail route reads it again on demand; no per-card scan).
    // A failed/absent read leaves the card UNKNOWN via the foundation path.
    const countsByDestination: Record<string, DestinationAdapterCounts> = {};
    try {
      const talabat = await loadTalabatPreview();
      if (talabat) {
        countsByDestination["talabat:malikas"] = {
          eligible: talabat.summary.ready,
          blocked: talabat.summary.blocked,
          warnings: talabat.summary.warnings,
        };
      }
    } catch {
      /* leave the Talabat card on the UNKNOWN foundation path */
    }

    const model = buildExportCenter({
      eligible,
      blocked,
      warningsByDestination,
      countsByDestination,
      generatedAt: now.toISOString(),
    });
    return { model };
  } catch {
    return { error: "export_center_failed" };
  }
}
