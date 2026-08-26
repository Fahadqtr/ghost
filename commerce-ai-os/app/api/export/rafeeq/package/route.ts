// INT.2D + RAFEEQ.FULLSYNC.1 — Rafeeq package download (SERVER-ONLY, writer-gated).
//
// POST → generates a Rafeeq package from the certified preview and streams it
// as a ZIP. WRITER authorization is required (no anonymous/public generation,
// no service-role secret to the client).
//
// Modes:
//   • "all" | "new" | "selected" — the original INT.2D package (unchanged);
//   • "full" | "new_pending"     — MOVED to the chunked job flow at
//     /api/export/rafeeq/package/jobs (RAFEEQ.PKGJOB): the full native catalog
//     is too large for one buffered request (proven OOM kill + 300 s timeout
//     in the runtime logs), so this endpoint now refuses those modes with a
//     structured JSON pointer instead of ever buffering the archive again.
//
// It mutates no catalog/inventory/availability/ECL data, resolves no Rafeeq
// conflict, and performs no Rafeeq API publish. Errors are safe sentinels.

import { requireMalakWriter } from "@/lib/malak/authz";
import { generateRafeeqPackage, type GeneratePackageError } from "@/lib/rafeeq/package.server";
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

  // ── RAFEEQ.PKGJOB — FULL/NEW packages are JOB-BASED now ─────────────────────
  // The full native catalog (~1419 products, ~2535 images, ~500 MiB) cannot be
  // generated inside one request: the in-memory single-shot path was OOM-killed
  // by the runtime ("instance was killed because it ran out of available
  // memory", 2026-08-25) and previously hit the 300 s ceiling. FULL/NEW
  // generation lives at /api/export/rafeeq/package/jobs (bounded steps +
  // durable storage + streamed download); this legacy entry point refuses with
  // structured JSON so no caller can reach the buffered path again.
  if (fullSyncMode) {
    return new Response(
      JSON.stringify({ error: "use_jobs", jobs_endpoint: "/api/export/rafeeq/package/jobs", mode: fullSyncMode }),
      { status: 409, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  }

  // Mode "all" (also the bodyless default) is the FULL catalog too — the same
  // buffered single-request path that was OOM-killed. It is refused identically,
  // so the buffered full-catalog generator is unreachable from any caller; only
  // the bounded subset modes ("new" / "selected") remain on this endpoint.
  if (mode === "all") {
    return new Response(
      JSON.stringify({ error: "use_jobs", jobs_endpoint: "/api/export/rafeeq/package/jobs", mode: "FULL" }),
      { status: 409, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
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
