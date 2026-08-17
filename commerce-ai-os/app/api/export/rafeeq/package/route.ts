// INT.2D — Rafeeq package download (SERVER-ONLY, writer-gated).
//
// POST → generates the Rafeeq package (rafeeq-products.xlsx + images/ +
// manifest.json) from the certified preview and streams it as a ZIP. WRITER
// authorization is required (no anonymous/public generation, no service-role
// secret to the client). It mutates no catalog/inventory/availability/ECL data,
// resolves no Rafeeq conflict, and performs no Rafeeq API publish — the only side
// effect is a best-effort audit row in the generator. Errors are safe sentinels.

import { requireMalakWriter } from "@/lib/malak/authz";
import { generateRafeeqPackage, type GeneratePackageError } from "@/lib/rafeeq/package.server";
import { RAFEEQ_UPDATES_SUPPORTED, type RafeeqGenerationMode } from "@/lib/export/rafeeq/package";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODES: readonly RafeeqGenerationMode[] = ["all", "new", "selected"];

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
  try {
    const body = await req.json();
    // "updates" is explicitly UNSUPPORTED for Rafeeq (no durable change evidence).
    if (body?.mode === "updates" && !RAFEEQ_UPDATES_SUPPORTED) {
      return new Response("Updates mode is not supported for Rafeeq (no reliable change evidence)", { status: 422 });
    }
    if (MODES.includes(body?.mode)) mode = body.mode;
    if (mode === "selected") {
      selectedKeys = Array.isArray(body?.selectedKeys) ? body.selectedKeys.map((v: unknown) => String(v ?? "")).filter(Boolean) : [];
    }
  } catch {
    /* no body → default: All */
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
