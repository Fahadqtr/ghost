// Malak proactive scan (Phase 3). READ-ONLY. A richer morning briefing: the
// same fast catalog head-counts PLUS the cross-platform channel mismatch, turned
// into a PRIORITIZED list of actionable issues. Each issue carries a `prompt`
// the UI fires with one tap (routes back through Malak → the matching tool).
// No writes here.
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { matchChannelsToMalika } from "@/app/(app)/inventory/actions";
import { getSalesSummary } from "@/lib/inventory/sales";
import { composeBriefing, partOfDayFromHour } from "@/lib/briefing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Issue {
  key: string;
  icon: string;
  title: string;
  count: number;
  prompt: string;            // fired with one tap → routed through Malak
  severity: "high" | "med" | "low";
}

export async function GET() {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return Response.json({ error: "غير مسجّل الدخول." }, { status: 401 });

  let sb;
  try { sb = createAdminClient(); }
  catch (e: any) { return Response.json({ error: e?.message ?? "service role unavailable" }, { status: 200 }); }

  try {
    const head = async (apply?: (b: any) => any) => {
      let b = sb.from("products").select("*", { count: "exact", head: true });
      if (apply) b = apply(b);
      const { count } = await b;
      return count ?? 0;
    };

    const [total, approved, rejected, missingImages, suspiciousPrice, outOfStockRows, lowRows, activity] = await Promise.all([
      head(),
      head((b) => b.eq("approval", "Approved")),
      head((b) => b.eq("approval", "Rejected")),
      head((b) => b.is("image_url", null)),
      head((b) => b.or("price.is.null,price.lte.0")),
      sb.from("inventory").select("product_id").lte("stock_quantity", 0).limit(20000),
      // Low stock = 1..9 ONLY. Out-of-stock (<=0) is its own category, not "low".
      sb.from("inventory").select("product_id").gt("stock_quantity", 0).lt("stock_quantity", 10).limit(20000),
      // Recent Malak actions for the activity feed (best-effort; table may be empty).
      sb.from("malak_audit").select("created_at, action_type, sku, old_value, new_value, status").order("created_at", { ascending: false }).limit(10),
    ]);
    const lowStock = (lowRows.data ?? []).length;
    const outOfStock = (outOfStockRows.data ?? []).length;
    const recentActivity = (activity.data ?? []) as { created_at: string; action_type: string; sku: string | null; old_value: string | null; new_value: string | null; status: string | null }[];

    // Cross-platform mismatch: out-of-stock products still Active on a channel.
    // Same preview the sync tool runs; tolerant of failure (count → 0).
    let channelMismatch = 0;
    try {
      const preview = await matchChannelsToMalika(false);
      if (!preview.error) channelMismatch = preview.products.length;
    } catch { /* best-effort */ }

    // Build the prioritized issue list (only non-zero), ordered by impact.
    const issues: Issue[] = [];
    if (channelMismatch > 0)
      issues.push({ key: "sync", icon: "🔁", title: "نافد لا زال ظاهر على المنصّات", count: channelMismatch, prompt: "زامني التوفّر بين المنصّات", severity: "high" });
    if (outOfStock > 0)
      issues.push({ key: "oos", icon: "⛔", title: "نافد (مخزون صفر)", count: outOfStock, prompt: "اعرض المنتجات النافدة", severity: "high" });
    if (suspiciousPrice > 0)
      issues.push({ key: "price", icon: "💸", title: "سعر ناقص أو صفر", count: suspiciousPrice, prompt: "افحص مشاكل الأسعار", severity: "high" });
    if (lowStock > 0)
      issues.push({ key: "low", icon: "📉", title: "ستوك منخفض (أقل من ١٠)", count: lowStock, prompt: "اعرض المنتجات منخفضة المخزون", severity: "med" });
    if (rejected > 0)
      issues.push({ key: "rejected", icon: "⛔", title: "منتج مرفوض يحتاج مراجعة", count: rejected, prompt: "اعرض المنتجات المرفوضة", severity: "med" });
    if (missingImages > 0)
      issues.push({ key: "images", icon: "🖼️", title: "بدون صورة", count: missingImages, prompt: "اعرض المنتجات بدون صورة", severity: "low" });

    // One-line spoken/headline priority (the single most important thing).
    const priority = issues.length ? `${issues[0].title} (${issues[0].count})` : "الوضع ممتاز — ما فيه بند عاجل اليوم";

    // Composed morning briefing (greeting + prioritized lines + TTS-safe speak),
    // built from the prioritized issues + today's sales. Best-effort sales.
    const sales = await getSalesSummary(1).catch(() => null);
    const briefing = composeBriefing({
      partOfDay: partOfDayFromHour((new Date().getUTCHours() + 3) % 24), // Qatar = UTC+3
      alerts: issues.map((i) => ({ ar: `${i.title} (${i.count})`, severity: i.severity })),
      sales: sales?.configured
        ? { units: sales.totalUnits, revenue: sales.totalRevenue, topSeller: sales.topByUnits?.[0]?.name ?? null }
        : null,
    });

    return Response.json({
      agent: "malak",
      total, approved, rejected, missingImages, lowStock, outOfStock,
      suspiciousPrice, channelMismatch,
      issues,
      recentActivity,
      allClear: issues.length === 0,
      priority,
      briefing,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "scan failed" }, { status: 200 });
  }
}
