// Scheduled availability sync (Vercel Cron). Propagates the master inventory
// truth — effective stock per product = max(inventory total, summed variant
// stock) — onto every overlay platform's `platform_status.availability`, so the
// whole system reflects real stock without a manual upload + apply each day.
//
// Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET
// is set in the environment; we require an exact match, so the endpoint can also
// be triggered manually with the same header. Reads/writes via the service-role
// client (a cron has no user session). The write is a minimal diff — only rows
// whose current availability differs from the master-derived one are upserted,
// so an unchanged run writes nothing.
import { createAdminClient } from "@/lib/supabase/admin";
import { PLATFORMS } from "@/lib/constants";
import {
  computeStockStatus,
  planStatusUpserts,
  statusKey,
  type InventoryRow,
  type VariantRow,
} from "@/lib/availability-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE = 1000;

// Overlay platforms carry an availability overlay; Malika is the master itself
// (its real stock lives in `inventory`), so we never write a fake row for it.
const OVERLAY = PLATFORMS.filter((p) => !p.master).map((p) => p.key);

async function pageAll<T>(run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let sb;
  try { sb = createAdminClient(); }
  catch (e: any) { return Response.json({ ok: false, error: e?.message ?? "service role unavailable" }, { status: 500 }); }

  try {
    const [inventory, variants, statusRows] = await Promise.all([
      pageAll<InventoryRow>((from, to) => sb.from("inventory").select("product_id, stock_quantity").range(from, to)),
      pageAll<VariantRow>((from, to) => sb.from("product_variants").select("parent_product_id, stock_quantity").range(from, to))
        .catch(() => [] as VariantRow[]), // product_variants may not exist in every project
      pageAll<{ product_id: string; platform: string; availability: string | null }>(
        (from, to) => sb.from("platform_status").select("product_id, platform, availability").range(from, to),
      ),
    ]);

    // Current overlay state, keyed by (product, platform) → availability.
    const current = new Map<string, string>();
    for (const r of statusRows) {
      if (r.availability) current.set(statusKey(r.product_id, r.platform), r.availability);
    }

    const statuses = computeStockStatus(inventory, variants);
    const { upserts, counts } = planStatusUpserts(statuses, OVERLAY, current, new Date().toISOString());

    let written = 0;
    let failed = 0;
    let firstErr = "";
    for (let i = 0; i < upserts.length; i += 500) {
      const chunk = upserts.slice(i, i + 500);
      const { error } = await sb.from("platform_status").upsert(chunk, { onConflict: "product_id,platform" });
      if (error) { failed += chunk.length; if (!firstErr) firstErr = error.message; }
      else written += chunk.length;
    }

    if (firstErr) {
      const hint = /availability/.test(firstErr)
        ? " — run once in Supabase: alter table platform_status add column if not exists availability text;"
        : "";
      return Response.json({ ok: false, error: firstErr + hint, platforms: OVERLAY.length, written, failed, ...counts }, { status: 500 });
    }

    return Response.json({
      ok: true,
      platforms: OVERLAY.length,
      products: counts.products,
      out: counts.out,
      inStock: counts.inStock,
      changed: upserts.length,
      written,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "sync failed" }, { status: 500 });
  }
}
