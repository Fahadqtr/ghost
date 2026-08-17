// INT.2C — Snoonu multi-store package download (SERVER-ONLY, writer-gated).
//
// POST → generates ONE Snoonu storefront's package (snoonu-products.xlsx +
// images/ + manifest.json) from the certified preview and streams it as a ZIP.
// The storefront is chosen by the [unit] path segment (malikas | pure-seoul), so
// Malikas and Pure Seoul are fully isolated. WRITER authorization is required (no
// anonymous/public generation, no service-role secret to the client). It mutates
// no catalog/inventory/availability/ECL data and performs no Snoonu API publish —
// the only side effect is a best-effort audit row in the generator. Errors are
// safe sentinels.

import { requireMalakWriter } from "@/lib/malak/authz";
import { generateSnoonuPackage, type GeneratePackageError } from "@/lib/snoonu/package.server";
import type { SnoonuStorefrontKey } from "@/lib/export/snoonu/preview";
import type { SnoonuGenerationMode } from "@/lib/export/snoonu/package";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UNIT_TO_STOREFRONT: Record<string, SnoonuStorefrontKey> = {
  malikas: "snoonu:malikas",
  "pure-seoul": "snoonu:pure_seoul",
};
const MODES: readonly SnoonuGenerationMode[] = ["all", "new", "updates", "selected"];

const SAFE_ERROR: Record<GeneratePackageError, { status: number; message: string }> = {
  preview_unavailable: { status: 503, message: "Snoonu preview is temporarily unavailable" },
  no_exportable_rows: { status: 422, message: "No ready product rows to package" },
  integrity_failed: { status: 500, message: "Package integrity check failed — nothing was generated" },
  generation_failed: { status: 500, message: "Snoonu package generation failed" },
};

export async function POST(req: Request, { params }: { params: Promise<{ unit: string }> }) {
  const { unit } = await params;
  const storefrontKey = UNIT_TO_STOREFRONT[unit];
  if (!storefrontKey) return new Response("Unknown Snoonu storefront", { status: 400 });

  const writer = await requireMalakWriter();
  if (!writer.ok) return new Response(writer.error, { status: writer.status });

  let mode: SnoonuGenerationMode = "all";
  let selectedKeys: string[] | undefined;
  try {
    const body = await req.json();
    if (MODES.includes(body?.mode)) mode = body.mode;
    if (mode === "selected") {
      selectedKeys = Array.isArray(body?.selectedKeys)
        ? body.selectedKeys.map((v: unknown) => String(v ?? "")).filter(Boolean)
        : [];
    }
  } catch {
    /* no body → default: All */
  }

  const result = await generateSnoonuPackage({ storefrontKey, mode, selectedKeys, actor: writer.email });
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
      "X-Snoonu-Storefront": s.storefrontKey,
      "X-Snoonu-Mode": s.mode,
      "X-Snoonu-Output-Filename": result.filename,
      "X-Snoonu-Product-Rows": String(s.productRowCount),
      "X-Snoonu-Mapped": String(s.mappedCount),
      "X-Snoonu-Unmapped": String(s.unmappedCount),
      "X-Snoonu-Image-Count": String(s.imageCount),
      "X-Snoonu-Warning-Count": String(s.warningCount),
      "X-Snoonu-Excluded-Blocked": String(s.excludedBlockedCount),
      "X-Snoonu-Excluded-No-Image": String(s.excludedNoImageCount),
      "X-Snoonu-Generated-At": s.generatedAt,
      "X-Snoonu-Generated-By": s.actor ?? "",
    },
  });
}
