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
import { loadRafeeqPreview } from "./rafeeq/preview.server";
import {
  buildExportCenter,
  UNKNOWN,
  type DestinationAdapterCounts,
  type ExportCenterModel,
  type Unknownable,
} from "./export-center.ts";
import { loadMasterScope } from "@/lib/home/master-scope.server";
import { computeMasterReadiness } from "@/lib/readiness/master-readiness";

export async function loadExportCenter(now: Date = new Date()): Promise<{ model: ExportCenterModel } | { error: string }> {
  try {
    const client = createClient();

    // OPERATIONAL readiness baseline — restricted to the CURRENT MASTER (the
    // active snoonu:malikas membership), using the same certified readiness
    // output and the same shared counter Home uses. Previously this counted
    // every product row, so Launch and Export reported readiness over a
    // universe that included products outside the master.
    //
    // This baseline drives the OPERATIONAL cards only. Full-catalog exports are
    // produced by a separate route and are deliberately NOT scoped here.
    let eligible: Unknownable<number> = UNKNOWN;
    let blocked: Unknownable<number> = UNKNOWN;
    try {
      const scope = await loadMasterScope();
      // Fail closed: without membership we show UNKNOWN rather than falling back
      // to an unscoped count that would overstate readiness.
      if (scope.ok) {
        const dash = await loadOperationsDashboard(client as never);
        if (dash.status === "ok") {
          const baseline = computeMasterReadiness(dash.data.readiness, scope);
          if (baseline.available) {
            eligible = baseline.ready;
            blocked = baseline.blocked;
          }
        }
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

    // INT.2D — real Rafeeq card counts from ONE bounded read (reused adapter);
    // a failed/absent read leaves the card on the UNKNOWN foundation path.
    try {
      const rafeeq = await loadRafeeqPreview();
      if (rafeeq) {
        countsByDestination["rafeeq:malikas"] = {
          eligible: rafeeq.summary.ready,
          blocked: rafeeq.summary.blocked,
          warnings: rafeeq.summary.warnings,
        };
      }
    } catch {
      /* leave the Rafeeq card on the UNKNOWN foundation path */
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
