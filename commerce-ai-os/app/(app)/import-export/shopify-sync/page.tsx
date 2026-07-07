import Link from "next/link";
import ShopifySync from "@/components/ShopifySync";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // pulling + diffing the full store takes a while

export default function ShopifySyncPage() {
  return (
    <div className="space-y-4">
      <div>
        <Link href="/import-export" className="text-sm text-brand hover:underline">← Import / Export</Link>
        <h2 className="text-lg font-semibold text-ink">Shopify Sync</h2>
        <p className="text-sm text-muted">
          مقارنة حية بين الكتالوج ومتجر شوبي فاي عبر Admin API — الكتالوج هو مصدر الحقيقة، وتحديث الأسعار يتم بضغطة بعد المعاينة.
        </p>
      </div>
      <ShopifySync />
    </div>
  );
}
