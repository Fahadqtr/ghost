import Link from "next/link";
import LegacyShelfLabelsPage from "@/app/(app)/inventory/shelves/labels/page";

// INV.V2.3 — thin V2 wrapper (the proven INV.V2.2 pattern): the EXISTING legacy
// inventory surface renders inside the V2 shell with a breadcrumb only. Same
// reads, same server actions, same permissions — zero business logic here.

export const dynamic = "force-dynamic";

export default async function Page() {
  return (
    <div className="space-y-4" dir="rtl">
      <header className="flex flex-wrap items-center gap-2">
        <Link href="/v2/inventory" className="text-xs text-brand hover:underline">← مركز المخزون</Link>
        <h1 className="text-lg font-bold text-slate-900">ملصقات الرفوف</h1>
      </header>
      <LegacyShelfLabelsPage />
    </div>
  );
}
