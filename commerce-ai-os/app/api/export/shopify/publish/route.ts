// INT.2E.2 — Shopify publish API route (writer-gated, server-only).
//
// POST /api/export/shopify/publish — executes the operator-confirmed Shopify plan
// for shopify:malikas. It delegates ENTIRELY to executeShopifyPublish, which
// re-reads + re-plans through the certified INT.2E planner, hard-stops
// CONFLICT/BLOCKED/UNKNOWN, verifies per-row fingerprints (stale protection),
// writes durable identity via ECL + a durable export_runs row, and never writes
// inventory/availability/lifecycle. The route itself performs no Shopify diff and
// no mutation of its own. Errors are returned as fixed, safe JSON — never a raw
// Shopify/DB payload.

import { requireMalakWriter } from "@/lib/malak/authz";
import { executeShopifyPublish, type PublishSelection } from "@/lib/export/shopify/publish.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Gate first (defense in depth — executeShopifyPublish also gates).
  const writer = await requireMalakWriter();
  if (!writer.ok) return json({ ok: false, error: writer.error }, writer.status);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "طلب غير صالح." }, 400);
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const rawSelections = Array.isArray(b.selections) ? b.selections : [];
  const selections: PublishSelection[] = rawSelections
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const id = typeof o.internalProductId === "string" ? o.internalProductId : "";
      const fp = typeof o.expectedFingerprint === "string" ? o.expectedFingerprint : "";
      return { internalProductId: id, expectedFingerprint: fp };
    })
    .filter((s) => s.internalProductId !== "" && s.expectedFingerprint !== "");

  const result = await executeShopifyPublish({
    selections,
    confirm: b.confirm === true,
    confirmCreate: b.confirmCreate === true,
  });

  return json(result, result.ok ? 200 : 409);
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
