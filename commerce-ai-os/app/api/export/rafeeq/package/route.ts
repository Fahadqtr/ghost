// INT.2D + RAFEEQ.FULLSYNC.1 — Rafeeq package download (SERVER-ONLY, writer-gated).
//
// POST → generates a Rafeeq package from the certified preview and streams it
// as a ZIP. WRITER authorization is required (no anonymous/public generation,
// no service-role secret to the client).
//
// Modes:
//   • "all" | "new" | "selected" — the original INT.2D package (unchanged);
//   • "full"        — RAFEEQ.FULLSYNC.1 FULL catalog (rafeeq-full-YYYY-MM-DD.zip,
//     /rafeeq_catalog.xlsx + /images/ + /manifest.json). Rows blocked ONLY by
//     the identity review are included with the "new product" marker;
//   • "new_pending" — the pending-NEW package (rafeeq-new-products-YYYY-MM-DD.zip,
//     /rafeeq_new_products.xlsx). Pending = exportable AND not in any package
//     the owner marked SENT — it REQUIRES the durable sent-state to be readable
//     (503 otherwise; never a guessed baseline).
//
// After a successful fullsync generation the durable package row + item
// snapshot are recorded (sent_at NULL = "Generated — not sent"); recording is
// best-effort and never blocks the download. It mutates no catalog/inventory/
// availability/ECL data, resolves no Rafeeq conflict, and performs no Rafeeq
// API publish. Errors are safe sentinels.

import { requireMalakWriter } from "@/lib/malak/authz";
import {
  generateRafeeqPackage,
  generateRafeeqFullSyncPackage,
  type GeneratePackageError,
} from "@/lib/rafeeq/package.server";
import { loadRafeeqDeliveryState, recordRafeeqPackage } from "@/lib/rafeeq/fullsync.server";
import { RAFEEQ_UPDATES_SUPPORTED, type RafeeqGenerationMode } from "@/lib/export/rafeeq/package";
import type { RafeeqFullSyncMode } from "@/lib/export/rafeeq/fullsync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODES: readonly RafeeqGenerationMode[] = ["all", "new", "selected"];
const FULLSYNC_MODE: Record<string, RafeeqFullSyncMode> = { full: "FULL", new_pending: "NEW" };

const SAFE_ERROR: Record<GeneratePackageError, { status: number; message: string }> = {
  preview_unavailable: { status: 503, message: "Rafeeq preview is temporarily unavailable" },
  no_exportable_rows: { status: 422, message: "No ready product rows to package" },
  filename_collision: { status: 409, message: "Image filename collision detected — resolve duplicate SKUs before exporting" },
  integrity_failed: { status: 500, message: "Package integrity check failed — nothing was generated" },
  generation_failed: { status: 500, message: "Rafeeq package generation failed" },
};

export async function POST(req: Request) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return new Response(writer.error, { status: writer.status });

  let mode: RafeeqGenerationMode = "all";
  let selectedKeys: string[] | undefined;
  let fullSyncMode: RafeeqFullSyncMode | null = null;
  try {
    const body = await req.json();
    // "updates" is explicitly UNSUPPORTED for Rafeeq (no durable change evidence).
    if (body?.mode === "updates" && !RAFEEQ_UPDATES_SUPPORTED) {
      return new Response("Updates mode is not supported for Rafeeq (no reliable change evidence)", { status: 422 });
    }
    if (typeof body?.mode === "string" && FULLSYNC_MODE[body.mode]) fullSyncMode = FULLSYNC_MODE[body.mode];
    if (MODES.includes(body?.mode)) mode = body.mode;
    if (mode === "selected") {
      selectedKeys = Array.isArray(body?.selectedKeys) ? body.selectedKeys.map((v: unknown) => String(v ?? "")).filter(Boolean) : [];
    }
  } catch {
    /* no body → default: All */
  }

  // ── RAFEEQ.FULLSYNC.1 — FULL catalog / NEW pending packages ─────────────────
  if (fullSyncMode) {
    const delivery = await loadRafeeqDeliveryState();
    // The NEW package is DEFINED by the sent baseline; without a readable
    // durable state it cannot be derived honestly — refuse, never guess.
    if (fullSyncMode === "NEW" && delivery.availability === "UNAVAILABLE") {
      return new Response("Rafeeq sent-state is unavailable (migration not applied) — the NEW package cannot be derived", { status: 503 });
    }

    const result = await generateRafeeqFullSyncPackage({
      mode: fullSyncMode,
      sentSellableKeys: delivery.sentSellableKeys,
      actor: writer.email,
    });
    if (!result.ok) {
      const e = SAFE_ERROR[result.error];
      return new Response(e.message, { status: e.status });
    }

    // Durable "Generated — not sent" record (best-effort; never blocks the file).
    const recorded = await recordRafeeqPackage({
      mode: fullSyncMode,
      outputFilename: result.filename,
      manifestFingerprint: result.summary.manifestFingerprint,
      productCount: result.summary.productRowCount,
      imageCount: result.summary.imageCount,
      generatedAt: result.summary.generatedAt,
      actor: writer.email,
      items: result.items,
    });

    const s = result.summary;
    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        "X-Rafeeq-FullSync-Mode": s.mode,
        "X-Rafeeq-Output-Filename": result.filename,
        "X-Rafeeq-Product-Rows": String(s.productRowCount),
        "X-Rafeeq-Mapped-Ids": String(s.mappedIdCount),
        "X-Rafeeq-New-Marker": String(s.newMarkerCount),
        "X-Rafeeq-Needs-Review-Included": String(s.needsReviewIncluded),
        "X-Rafeeq-True-Blockers-Excluded": String(s.trueBlockersExcluded),
        "X-Rafeeq-Image-Count": String(s.imageCount),
        "X-Rafeeq-Package-Id": recorded.packageId ?? "",
        "X-Rafeeq-Package-Recorded": recorded.persisted ? "1" : "0",
        "X-Rafeeq-Items-Recorded": String(recorded.itemsPersisted),
        "X-Rafeeq-Superseded-Count": String(recorded.supersededCount),
        "X-Rafeeq-Generated-At": s.generatedAt,
        "X-Rafeeq-Generated-By": s.actor ?? "",
      },
    });
  }

  const result = await generateRafeeqPackage({ mode, selectedKeys, actor: writer.email });
  if (!result.ok) {
    const e = SAFE_ERROR[result.error];
    return new Response(e.message, { status: e.status });
  }

  const s = result.summary;
  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
      "X-Rafeeq-Mode": s.mode,
      "X-Rafeeq-Output-Filename": result.filename,
      "X-Rafeeq-Product-Rows": String(s.productRowCount),
      "X-Rafeeq-Mapped": String(s.mappedCount),
      "X-Rafeeq-Unmapped": String(s.unmappedCount),
      "X-Rafeeq-Needs-Review-Excluded": String(s.needsReviewExcluded),
      "X-Rafeeq-Image-Count": String(s.imageCount),
      "X-Rafeeq-Warning-Count": String(s.warningCount),
      "X-Rafeeq-Excluded-Blocked": String(s.excludedBlockedCount),
      "X-Rafeeq-Generated-At": s.generatedAt,
      "X-Rafeeq-Generated-By": s.actor ?? "",
    },
  });
}
