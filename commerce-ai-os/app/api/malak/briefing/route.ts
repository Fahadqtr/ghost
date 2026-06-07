// Morning briefing (Rashid). READ-ONLY store status summary, gathered from the
// same catalog data the existing read tools use. No writes, no Claude — just a
// few fast head-count queries. Shown once per session when /malak opens.
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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

    // Today's single priority (by business impact).
    let priority: string;
    if (lowStock > 0) priority = `تعبئة ${lowStock} منتج ستوكهم منخفض قبل ما ينفد`;
    else if (rejected > 0) priority = `مراجعة ${rejected} منتج مرفوض لتفعيلهم`;
    else if (missingImages > 0) priority = `إضافة صور لـ ${missingImages} منتج ناقص صورة`;
    else if (suspiciousPrice > 0) priority = `مراجعة ${suspiciousPrice} منتج سعرهم ناقص أو صفر`;
    else priority = "الوضع ممتاز — ما فيه بند عاجل اليوم";

    return Response.json({
      agent: "rashid",
      total,
      missingImages,
      lowStock,
      rejected,
      suspiciousPrice,
      priority,
    });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "briefing failed" }, { status: 200 });
  }
}
