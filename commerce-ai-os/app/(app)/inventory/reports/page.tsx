import Link from "next/link";
import { getSalesSummary, type SoldProduct } from "@/lib/inventory/sales";
import { getShrinkageReport, type NameUnits } from "@/lib/inventory/shrinkage";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

const nf = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const money = (n: number) => (en ? `${nf(n)} QAR` : `${nf(n)} ر.ق`);

  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 30;

  const [sales, shrink] = await Promise.all([getSalesSummary(), getShrinkageReport(days)]);

  return (
    <div className="space-y-6" dir={en ? "ltr" : "rtl"}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{L("التقارير", "Reports")}</h2>
          <p className="text-sm text-muted">{L("المبيعات والأكثر مبيعًا + تقرير الفاقد.", "Sales & best-sellers + loss (shrinkage) report.")}</p>
        </div>
        <Link href="/inventory" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">{L("← المخزون", "Inventory →")}</Link>
      </div>

      {/* ── Sales & best-sellers ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">🧾 {L("المبيعات والأكثر مبيعًا", "Sales & best-sellers")}</h3>
        {!sales.configured ? (
          <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{L("لم يتم إعداد Supabase.", "Supabase isn’t configured.")}</div>
        ) : sales.totalUnits === 0 ? (
          <div className="card py-8 text-center text-sm text-slate-400">{L("ما فيه مبيعات مسجّلة بعد. سجّل حركة خروج بسبب «بيع» عشان تبدأ.", "No sales recorded yet. Log an OUT movement with reason “Sale” to start.")}</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Kpi title={L("إجمالي القطع المباعة", "Total units sold")} value={nf(sales.totalUnits)} icon="📦" />
              <Kpi title={L("إجمالي الإيراد", "Total revenue")} value={money(sales.totalRevenue)} icon="💰" accent="green" />
              <Kpi title={L("منتجات مباعة", "Products sold")} value={nf(sales.distinctProducts)} icon="🏷️" />
            </div>
            <p className="text-[11px] text-muted">{L("الإيراد = الكمية المباعة × السعر (بعد الخصم إن وُجد). بدون تكلفة.", "Revenue = units sold × price (discounted where set). No cost applied.")}</p>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="card">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{L("الأكثر مبيعًا (بالكمية)", "Top by units")}</h4>
                <ProductList items={sales.topByUnits} metric="units" en={en} money={money} />
              </div>
              <div className="card">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{L("الأعلى إيرادًا", "Top by revenue")}</h4>
                <ProductList items={sales.topByRevenue} metric="revenue" en={en} money={money} />
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Shrinkage / loss ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">📉 {L("تقرير الفاقد", "Loss (shrinkage) report")}</h3>
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
            {[7, 30, 90].map((d) => (
              <Link key={d} href={`/inventory/reports?days=${d}`} scroll={false}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${d === days ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                {L(`${d} يوم`, `${d}d`)}
              </Link>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-muted">{L("الفاقد = حركات الخروج بأسباب غير البيع وغير التحويل (تالف/مفقود…).", "Loss = OUT movements with reasons other than sale or transfer (damaged/lost…).")}</p>

        {!shrink.configured ? (
          <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{L("الخادم غير مهيأ لقراءة السجل.", "Server isn’t configured to read the ledger.")}</div>
        ) : shrink.lossUnits === 0 ? (
          <div className="card py-8 text-center text-sm text-emerald-600">{L(`ما فيه فاقد مسجّل خلال ${days} يوم 🎉`, `No loss recorded in the last ${days} days 🎉`)}</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Kpi title={L("قطع مفقودة", "Units lost")} value={nf(shrink.lossUnits)} icon="⚠️" accent="amber" />
              <Kpi title={L("عدد الحركات", "Loss events")} value={nf(shrink.lossEvents)} icon="🧾" />
              <Kpi title={L("قطع مباعة (للمقارنة)", "Units sold (context)")} value={nf(shrink.salesUnits)} icon="🧮" />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="card">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{L("حسب السبب", "By reason")}</h4>
                <UnitsList items={shrink.byReason} en={en} empty={L("—", "—")} />
              </div>
              <div className="card">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{L("أكثر المنتجات فاقدًا", "Most-lost products")}</h4>
                <UnitsList items={shrink.byProduct} en={en} empty={L("—", "—")} />
              </div>
              <div className="card">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{L("حسب الموظف", "By employee")}</h4>
                <UnitsList items={shrink.byEmployee} en={en} empty={L("—", "—")} />
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Kpi({ title, value, icon, accent }: { title: string; value: string | number; icon?: string; accent?: "green" | "amber" }) {
  const color = accent === "green" ? "text-emerald-700" : accent === "amber" ? "text-amber-700" : "text-ink";
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{title}</p>
        {icon ? <span className="text-lg">{icon}</span> : null}
      </div>
      <p className={`mt-1 text-xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function ProductList({ items, metric, en, money }: { items: SoldProduct[]; metric: "units" | "revenue"; en: boolean; money: (n: number) => string }) {
  if (items.length === 0) return <p className="text-sm text-slate-400">—</p>;
  const max = Math.max(1, ...items.map((i) => (metric === "units" ? i.units : i.revenue)));
  return (
    <div className="space-y-2">
      {items.map((it, i) => {
        const v = metric === "units" ? it.units : it.revenue;
        const label = (en ? it.name : it.nameAr) || it.name || it.sku || "—";
        const row = (
          <>
            <span className="w-4 shrink-0 text-[11px] text-slate-400">{i + 1}</span>
            <span className="h-8 w-8 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-50">
              {it.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.image} alt="" className="h-full w-full object-cover" />
              ) : <span className="flex h-full w-full items-center justify-center text-slate-300">📦</span>}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{label}</span>
              <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                <span className="block h-full bg-violet-500" style={{ width: `${(v / max) * 100}%` }} />
              </span>
            </span>
            <span className="shrink-0 text-xs font-semibold text-ink">{metric === "units" ? nf(it.units) : money(it.revenue)}</span>
          </>
        );
        return it.productId ? (
          <Link key={it.productId} href={`/products/${it.productId}`} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-slate-50">{row}</Link>
        ) : (
          <div key={`r-${i}`} className="flex items-center gap-2 px-1 py-1">{row}</div>
        );
      })}
    </div>
  );
}

function UnitsList({ items, en, empty }: { items: NameUnits[]; en: boolean; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-slate-400">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.units));
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={`${it.key}-${i}`} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ink" title={it.key}>{it.key}</span>
            <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-slate-100">
              <span className="block h-full bg-amber-500" style={{ width: `${(it.units / max) * 100}%` }} />
            </span>
          </span>
          <span className="shrink-0 text-xs font-semibold text-amber-700">{nf(it.units)}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{en ? `×${it.count}` : `×${it.count}`}</span>
        </div>
      ))}
    </div>
  );
}
