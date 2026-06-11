import Link from "next/link";
import PureSeoulSync from "@/components/PureSeoulSync";
import RejectByPaste from "@/components/RejectByPaste";

export const dynamic = "force-dynamic";

export default function PureSeoulPage() {
  return (
    <div className="space-y-4">
      <div>
        <Link href="/import-export" className="text-sm text-brand hover:underline">← Import / Export</Link>
        <h2 className="text-lg font-semibold text-ink">Pure Seoul — مطابقة مليكاس</h2>
        <p className="text-sm text-muted">
          مليكاس هي الأساس. ارفع تصدير Pure Seoul لتشوف الناقص/الزائد/فروق الأسعار، وتعدّلها على Pure Seoul.
        </p>
      </div>
      <PureSeoulSync />
      <RejectByPaste
        title="رفض المرفوضة من Pure Seoul (لصق / صورة شاشة)"
        description="حالة «Rejected» في Pure Seoul مب كاملة بالتصدير. الصق أسماء المنتجات المرفوضة (أو SKU)، سطر لكل منتج — أو ارفع صورة شاشة — نطابقها بكتالوج مليكاس وترفضها دفعة بنفس طريقة سنونو."
        uploadLabel="📷 ارفع صورة شاشة من Pure Seoul"
        defaultReason="مرفوض على Pure Seoul"
      />
    </div>
  );
}
