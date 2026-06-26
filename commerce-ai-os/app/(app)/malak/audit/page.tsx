// سجل ملاك — كل كتابة نفّذتها ملاك (من malak_audit)، أحدث أولًا.
// شفافية كاملة: وش عدّلت · متى · قبل/بعد · وهل تجاوزت حدّ ±15%.
import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "سجل ملاك — Malak Audit" };

interface AuditRow {
  id: string;
  created_at: string;
  action_type: string;
  agent: string | null;
  sku: string | null;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  status: string | null;
  details: { overBand?: number } | null;
}

const ACTION_LABEL: Record<string, string> = {
  update_stock: "تحديث مخزون",
  set_price: "تعديل سعر",
  set_approval: "تغيير اعتماد",
  add_product: "إضافة منتج",
  set_image: "ربط صورة",
};

function fmtTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("ar", {
      dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Qatar",
    }).format(new Date(iso));
  } catch { return iso; }
}

export default async function MalakAuditPage() {
  // Require a signed-in user, then read with the service role (same posture as
  // /api/malak/* ) so the log shows regardless of malak_audit RLS.
  const { data: { user } } = await createClient().auth.getUser();
  let data: AuditRow[] | null = null;
  let error: { message: string } | null = null;
  if (!user) {
    error = { message: "غير مسجّل الدخول." };
  } else {
    try {
      const sb = createAdminClient();
      const res = await sb
        .from("malak_audit")
        .select("id, created_at, action_type, agent, sku, field, old_value, new_value, status, details")
        .order("created_at", { ascending: false })
        .limit(200);
      data = (res.data ?? null) as AuditRow[] | null;
      error = res.error ? { message: res.error.message } : null;
    } catch (e: any) {
      error = { message: e?.message ?? "service role unavailable" };
    }
  }

  const rows = (data ?? []) as AuditRow[];
  const overBand = rows.filter((r) => r.status === "committed_over_band").length;

  return (
    <div dir="rtl" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">سجل ملاك</h1>
          <p className="text-sm text-muted">كل تعديل نفّذته ملاك بعد التأكيد — أحدث أولًا (آخر ٢٠٠).</p>
        </div>
        <Link href="/malak" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">← رجوع لملاك</Link>
      </div>

      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          تعذّر قراءة السجل: {error.message}. تأكد إن جدول <code>malak_audit</code> موجود وإنك مسجّل الدخول.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="card"><p className="text-xs text-muted">إجمالي العمليات</p><p className="text-xl font-semibold text-ink">{rows.length}</p></div>
            <div className="card"><p className="text-xs text-muted">تجاوزت حدّ ±١٥٪</p><p className={`text-xl font-semibold ${overBand ? "text-amber-700" : "text-ink"}`}>{overBand}</p></div>
            <div className="card"><p className="text-xs text-muted">آخر عملية</p><p className="text-sm font-medium text-ink">{rows[0] ? fmtTime(rows[0].created_at) : "—"}</p></div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-muted">
                  <th className="py-1.5 pl-2 font-medium">الوقت</th>
                  <th className="px-2 font-medium">العملية</th>
                  <th className="px-2 font-medium">المنتج (SKU)</th>
                  <th className="px-2 font-medium">الحقل</th>
                  <th className="px-2 font-medium">قبل ← بعد</th>
                  <th className="px-2 font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const over = r.status === "committed_over_band";
                  return (
                    <tr key={r.id} className={`border-b border-slate-50 ${over ? "bg-amber-50" : ""}`}>
                      <td className="py-1.5 pl-2 whitespace-nowrap text-muted">{fmtTime(r.created_at)}</td>
                      <td className="px-2 whitespace-nowrap text-ink">{ACTION_LABEL[r.action_type] ?? r.action_type}</td>
                      <td className="px-2 font-mono text-[10px] text-muted">{r.sku ?? "—"}</td>
                      <td className="px-2 text-muted">{r.field ?? "—"}</td>
                      <td className="px-2">
                        <span className="text-slate-400">{r.old_value ?? "—"}</span>
                        <span className="mx-1">←</span>
                        <span className="font-medium text-ink">{r.new_value ?? "—"}</span>
                      </td>
                      <td className="px-2 whitespace-nowrap">
                        {over ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800">
                            فوق ±١٥٪{r.details?.overBand != null ? ` (${r.details.overBand > 0 ? "+" : ""}${r.details.overBand}٪)` : ""}
                          </span>
                        ) : (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">تم</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 ? <p className="py-3 text-center text-sm text-slate-400">ما في عمليات مسجّلة بعد.</p> : null}
          </div>
        </>
      )}
    </div>
  );
}
