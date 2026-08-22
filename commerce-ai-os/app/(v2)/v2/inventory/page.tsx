import Link from "next/link";
import { INVENTORY_HUB_LINKS } from "@/lib/inventory/hub";

export default function InventoryHubPage() {
  return (
    <div className="space-y-5" dir="rtl">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-slate-900">مركز المخزون</h1>
          <span className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700">
            INV.V2.1 Foundation
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-muted">
          مدخل موحّد لوظائف المخزون المعتمدة حاليًا. تفتح البطاقات الأدوات الموجودة كما هي، بنفس مصادر البيانات والصلاحيات وقواعد الكميات والحركات والجرد والباركود، إلى أن يثبت تكافؤ كل واجهة داخل V2.
        </p>
      </header>

      <nav aria-label="تبويبات المخزون" className="flex gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-white p-2">
        {INVENTORY_HUB_LINKS.map((item) => (
          <Link key={item.key} href={item.href} className="shrink-0 rounded-lg px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-violet-50 hover:text-violet-700">
            {item.label}
          </Link>
        ))}
      </nav>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="وظائف المخزون الحالية">
        {INVENTORY_HUB_LINKS.map((item) => (
          <Link key={item.key} href={item.href} className="card group flex min-h-36 flex-col justify-between border border-slate-200 transition hover:border-violet-300 hover:shadow-sm">
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-sm font-bold text-slate-800 group-hover:text-violet-700">{item.label}</h2>
                <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-700">إعادة استخدام</span>
              </div>
              <p className="text-xs leading-5 text-muted">{item.description}</p>
            </div>
            <span className="mt-4 text-xs font-semibold text-violet-700">فتح الأداة الحالية ←</span>
          </Link>
        ))}
      </section>

      <aside className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
        المسارات القديمة باقية عمدًا ولم تُحوّل أو تُحذف: هذا الـHub يثبت الاكتشاف والتنقّل فقط، ولا يدّعي تكافؤ واجهات V2 بعد.
      </aside>
    </div>
  );
}

