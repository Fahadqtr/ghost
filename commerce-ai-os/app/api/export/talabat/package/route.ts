// INT.2B.2 — Talabat outbound package download (SERVER-ONLY, writer-gated).
//
// POST → generates the Talabat package (talabat-products.xlsx + images/ +
// manifest.json) from the certified INT.2B preview and streams it back as one
// ZIP. WRITER authorization is required (the same boundary the Talabat CSV
// export uses) — no anonymous/public generation, no service-role secret ever
// reaches the client. It mutates no catalog/inventory/availability/lifecycle/ECL
// data and performs no Talabat publish — the only side effect is a best-effort
// audit-trail row written inside the generator. Errors are safe sentinels
// (never a table/column name, id, URL, or raw DB error).

import { requireMalakWriter } from "@/lib/malak/authz";
import { generateTalabatPackage, type GeneratePackageError } from "@/lib/talabat/package.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // bounded server-side generation (Pro plan budget)

const SAFE_ERROR: Record<GeneratePackageError, { status: number; message: string }> = {
  preview_unavailable: { status: 503, message: "Talabat preview is temporarily unavailable" },
  no_exportable_rows: { status: 422, message: "No ready sellable rows to package" },
  integrity_failed: { status: 500, message: "Package integrity check failed — nothing was generated" },
  generation_failed: { status: 500, message: "Talabat package generation failed" },
};

export async function POST(req: Request) {
  const writer = await requireMalakWriter();
  if (!writer.ok) return new Response(writer.error, { status: writer.status });

  let mode: "ready" | "selected" = "ready";
  let selectedKeys: string[] | undefined;
  try {
    const body = await req.json();
    if (body?.mode === "selected") {
      mode = "selected";
      selectedKeys = Array.isArray(body?.selectedKeys)
        ? body.selectedKeys.map((v: unknown) => String(v ?? "")).filter(Boolean)
        : [];
    }
  } catch {
    /* no body → default: Generate Ready Only */
  }

  const result = await generateTalabatPackage({ mode, selectedKeys, actor: writer.email });
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
      // Summary surfaced to the client for the post-generation display (§17).
      "X-Talabat-Output-Filename": result.filename,
      "X-Talabat-Sellable-Rows": String(s.sellableRowCount),
      "X-Talabat-Simple-Rows": String(s.simpleProductCount),
      "X-Talabat-Variant-Rows": String(s.variantRowCount),
      "X-Talabat-Image-Count": String(s.imageCount),
      "X-Talabat-Warning-Count": String(s.warningCount),
      "X-Talabat-Excluded-Blocked": String(s.excludedBlockedCount),
      "X-Talabat-Excluded-No-Image": String(s.excludedNoImageCount),
      "X-Talabat-Generated-At": s.generatedAt,
      "X-Talabat-Generated-By": s.actor ?? "",
    },
  });
}
