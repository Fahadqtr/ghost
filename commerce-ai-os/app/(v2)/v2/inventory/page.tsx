import LegacyInventoryPage from "@/app/(app)/inventory/page";

export const dynamic = "force-dynamic";

export default async function InventoryHubPage() {
  return (
    <div className="space-y-5" dir="rtl">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-slate-900">مركز المخزون</h1>
          <span className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700">
            INV.V2.2
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted">
          الكميات وحالة التوفّر داخل V2، مع إعادة استخدام مصدر البيانات والإجراءات والصلاحيات المعتمدة نفسها دون اشتقاق التوفّر من الكمية.
        </p>
      </header>
      <LegacyInventoryPage />
    </div>
  );
}

