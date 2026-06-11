import Link from "next/link";
import { PLATFORMS } from "@/lib/constants";

export const dynamic = "force-dynamic";

export default function PlatformsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">المنصات · Platform Hubs</h2>
        <p className="text-sm text-muted">
          كل منصة لها Hub مستقل بحالة اعتماد/رفض خاصة بها. بيانات المنتج (الاسم/السعر/الصور/الوصف) مشتركة من
          <strong> الماستر (مليكاس)</strong> — تعدّلها مرة وحدة وتنعكس للكل. الرفض على منصة ما يأثّر على الباقي.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {PLATFORMS.map((p) => (
          <Link key={p.key} href={`/platforms/${p.key}`} className="card flex items-center justify-between hover:bg-slate-50">
            <div>
              <h3 className="text-sm font-semibold text-ink">
                {p.label}{p.master ? <span className="badge ml-2 bg-violet-100 text-brand-dark">الماستر</span> : null}
              </h3>
              <p className="text-xs text-muted">
                {p.master ? "مصدر بيانات المنتج + حالة مليكاس." : "حالة اعتماد/رفض مستقلة فوق بيانات الماستر."}
              </p>
            </div>
            <span className="text-brand">→</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
