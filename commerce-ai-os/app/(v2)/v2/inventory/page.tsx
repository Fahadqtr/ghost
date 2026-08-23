import Link from "next/link";
import LegacyInventoryPage from "@/app/(app)/inventory/page";
import { INVENTORY_HUB_LINKS } from "@/lib/inventory/hub";

export const dynamic = "force-dynamic";

export default async function InventoryHubPage() {
  return (
    <div className="space-y-5" dir="rtl">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-slate-900">مركز المخزون</h1>
          <span className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700">
            INV.V2.3
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted">
          الكميات وحالة التوفّر داخل V2، مع إعادة استخدام مصدر البيانات والإجراءات والصلاحيات المعتمدة نفسها دون اشتقاق التوفّر من الكمية.
        </p>
        {/* INV.V2.3 — quick links to the daily inventory workflows. Every href is
            a canonical /v2/inventory/* wrapper around the existing certified
            surface; the hub model is the single source of these destinations. */}
        <nav aria-label="أقسام المخزون" className="flex flex-wrap gap-2">
          {INVENTORY_HUB_LINKS.filter((l) => l.key !== "overview").map((l) => (
            <Link
              key={l.key}
              href={l.href}
              title={l.description}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <LegacyInventoryPage />
    </div>
  );
}
