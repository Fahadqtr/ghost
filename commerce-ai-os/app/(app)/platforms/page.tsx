import Link from "next/link";
import { PLATFORMS } from "@/lib/constants";
import { getPlatformCounts } from "@/app/(app)/platforms/actions";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export default async function PlatformsPage() {
  const counts = await getPlatformCounts();
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{L("المنصات", "Platform Hubs")}</h2>
        <p className="text-sm text-muted">
          {L(
            "كل منصة لها Hub مستقل بحالة اعتماد/رفض خاصة بها. بيانات المنتج (الاسم/السعر/الصور/الوصف) مشتركة من ",
            "Each platform has an independent hub with its own approval/rejection status. Product data (name/price/images/description) is shared from "
          )}
          <strong>{L(" الماستر (مليكاس)", "the master (Malikas)")}</strong>
          {L(
            " — تعدّلها مرة وحدة وتنعكس للكل. الرفض على منصة ما يأثّر على الباقي.",
            " — edit it once and it reflects everywhere. Rejecting on one platform doesn’t affect the others."
          )}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {PLATFORMS.map((p) => {
          const c = counts[p.key];
          return (
            <Link key={p.key} href={`/platforms/${p.key}`} className="card flex items-center justify-between hover:bg-slate-50">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-ink">
                  {p.label}{p.master ? <span className="badge ml-2 bg-violet-100 text-brand-dark">{L("الماستر", "Master")}</span> : null}
                </h3>
                <p className="text-xs text-muted">
                  {p.master
                    ? L("مصدر بيانات المنتج + حالة مليكاس.", "Source of product data + Malikas status.")
                    : L("حالة اعتماد/رفض مستقلة فوق بيانات الماستر.", "Independent approval/rejection status on top of the master data.")}
                </p>
                {c ? (
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                    <span className="badge bg-green-100 text-green-700">{L("معتمد", "Approved")} {c.approved}</span>
                    <span className="badge bg-red-100 text-red-700">{L("مرفوض", "Rejected")} {c.rejected}</span>
                    <span className="badge bg-slate-100 text-slate-500">{L("بدون", "None")} {c.none}</span>
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 text-brand">→</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
