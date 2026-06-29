import Link from "next/link";
import { notFound } from "next/navigation";
import { PLATFORMS, platformBy } from "@/lib/constants";
import { getPlatformProducts } from "@/app/(app)/platforms/actions";
import PlatformHub from "@/components/PlatformHub";

export const dynamic = "force-dynamic";

export default async function PlatformHubPage({ params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const meta = platformBy(platform);
  if (!meta) notFound();

  const { error, products } = await getPlatformProducts(platform);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/platforms" className="text-sm text-brand hover:underline">← كل المنصات</Link>
        <h2 className="text-lg font-semibold text-ink">
          {meta.label} {meta.master ? <span className="badge ml-1 bg-violet-100 text-brand-dark">الماستر</span> : <span className="text-muted">— Hub مستقل</span>}
        </h2>
        <p className="text-sm text-muted">
          {meta.master
            ? "هذي المنصة هي الماستر: تعديل بيانات المنتج هنا ينعكس لكل المنصات. الاعتماد/الرفض هنا خاص بمليكاس."
            : "حالة الاعتماد/الرفض هنا خاصة بهذه المنصة فقط — ما تلمس مليكاس ولا باقي المنصات. بيانات المنتج من الماستر."}
        </p>
      </div>

      {/* Quick switch between platforms. */}
      <div className="flex flex-wrap gap-2">
        {PLATFORMS.map((p) => (
          <Link
            key={p.key}
            href={`/platforms/${p.key}`}
            className={`badge ${p.key === meta.key ? "bg-brand text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {p.label}
          </Link>
        ))}
      </div>

      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">تعذّر التحميل: {error}</div>
      ) : (
        <PlatformHub platform={meta.key} products={products} />
      )}
    </div>
  );
}
