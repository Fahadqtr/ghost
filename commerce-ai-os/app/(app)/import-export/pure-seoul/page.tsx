import Link from "next/link";
import PureSeoulSync from "@/components/PureSeoulSync";

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
    </div>
  );
}
