// Morning briefing. READ-ONLY store status summary, gathered from the same
// catalog data the existing read tools use. No writes, no Claude — just a few
// fast head-count queries plus the shared notifications/sales sources. Shown
// once per session when /malak opens; the composed `briefing` (headline +
// priority + speakable Arabic) is what Malak greets you with each morning.
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getNotifications } from "@/lib/notifications";
import { getSalesSummary } from "@/lib/inventory/sales";
import { composeBriefing, partOfDayFromHour, type BriefingAlert } from "@/lib/briefing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Read-only catalog counts, but still store data — require a signed-in user.
  const {
    data: { user },
  } = await createClient().auth.getUser();
  if (!user) return Response.json({ error: "غير مسجّل الدخول." }, { status: 401 });

  let sb;
  try {
    sb = createAdminClient();
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "service role unavailable" }, { status: 200 });
  }

  try {
    const head = async (apply?: (b: any) => any) => {
      let b = sb.from("products").select("*", { count: "exact", head: true });
      if (apply) b = apply(b);
      const { count } = await b;
      return count ?? 0;
    };

    const [total, rejected, missingImages, suspiciousPrice, lowRows] = await Promise.all([
      head(),
      head((b) => b.eq("approval", "Rejected")),
      head((b) => b.is("image_url", null)),
      head((b) => b.or("price.is.null,price.lte.0")), // missing/zero price = clearly off
      sb.from("inventory").select("product_id").lt("stock_quantity", 10).limit(1000),
    ]);
    const lowStock = (lowRows.data ?? []).length;

    // Today's single priority (by business impact) — kept for the existing UI.
    let priority: string;
    if (lowStock > 0) priority = `تعبئة ${lowStock} منتج ستوكهم منخفض قبل ما ينفد`;
    else if (rejected > 0) priority = `مراجعة ${rejected} منتج مرفوض لتفعيلهم`;
    else if (missingImages > 0) priority = `إضافة صور لـ ${missingImages} منتج ناقص صورة`;
    else if (suspiciousPrice > 0) priority = `مراجعة ${suspiciousPrice} منتج سعرهم ناقص أو صفر`;
    else priority = "الوضع ممتاز — ما فيه بند عاجل اليوم";

    // ---- Composed morning briefing -----------------------------------------
    // Gather the richer store pulse (shared sources) and the catalog-count
    // signals, then compose a greeting + prioritized lines + speakable Arabic.
    // Each source degrades to empty on failure, so the briefing never blocks.
    const [notif, sales] = await Promise.all([
      getNotifications().catch(() => ({ items: [] as { ar: string; severity: BriefingAlert["severity"] }[] })),
      getSalesSummary(1).catch(() => null),
    ]);

    const alerts: BriefingAlert[] = [
      ...notif.items.map((i) => ({ ar: i.ar, severity: i.severity })),
    ];
    if (suspiciousPrice > 0) alerts.push({ ar: `${suspiciousPrice} منتج سعره ناقص أو صفر`, severity: "high" });
    if (rejected > 0) alerts.push({ ar: `${rejected} منتج مرفوض بانتظار المراجعة`, severity: "med" });
    if (missingImages > 0) alerts.push({ ar: `${missingImages} منتج ناقص صورة`, severity: "med" });

    const topSeller = sales?.topByUnits?.[0]?.name ?? null;
    const briefing = composeBriefing({
      partOfDay: partOfDayFromHour((new Date().getUTCHours() + 3) % 24), // Qatar = UTC+3
      alerts,
      sales: sales?.configured
        ? { units: sales.totalUnits, revenue: sales.totalRevenue, topSeller }
        : null,
    });

    return Response.json({
      agent: "malak",
      total,
      missingImages,
      lowStock,
      rejected,
      suspiciousPrice,
      priority,
      briefing,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "briefing failed" }, { status: 200 });
  }
}
