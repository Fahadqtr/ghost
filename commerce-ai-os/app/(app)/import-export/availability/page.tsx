import Link from "next/link";
import AvailabilityReconcile from "@/components/AvailabilityReconcile";

export const dynamic = "force-dynamic";

export default function AvailabilityReconcilePage() {
  return (
    <div className="space-y-4">
      <div>
        <Link href="/import-export" className="text-sm text-brand hover:underline">← Import / Export</Link>
        <h2 className="text-lg font-semibold text-ink">مطابقة التوفّر بين المنصّات</h2>
        <p className="text-sm text-muted">
          ارفع قائمة كل منصّة (مليكاس · Pure Seoul · Talabat · Rafeeq)، نقارنها ونوحّدها بقاعدة
          <b> «نافد بأي مكان = نافد بالكل»</b>، ثم نطبّقها على كل المنصّات وندفعها لـ Shopify عشان يصير الكل مطابق.
        </p>
      </div>
      <AvailabilityReconcile />
    </div>
  );
}
