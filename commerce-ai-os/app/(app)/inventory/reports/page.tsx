import Link from "next/link";
import { getSalesSummary, type SoldProduct } from "@/lib/inventory/sales";
import { getShrinkageReport, type NameUnits } from "@/lib/inventory/shrinkage";
import { getInventoryAnalytics, type DeadStockItem, type MarginItem } from "@/lib/inventory/analytics";
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

  const [sales, shrink, analytics] = await Promise.all([
    getSalesSummary(),
    getShrinkageReport(days),
    getInventoryAnalytics(),
  ]);

  return (
    <div className="space-y-6" dir={en ? "ltr" : "rtl"}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{L("التقارير", "Reports")}</h2>
          <p className="text-sm text-muted">{L("المبيعات + الهوامش + المخزون الميت + قيمة المخزون + الفاقد.", "Sales + margins + dead stock + valuation + shrinkage.")}</p>
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

      {/* ── Margins & profitability ──────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">📊 {L("الهوامش والربحية", "Margins & profitability")}</h3>
        {analytics.margins.withCost === 0 ? (
          <div className="card py-8 text-center text-sm text-slate-400">
            {L("ما فيه تكلفة (cost) مسجّلة على المنتجات بعد — عبّئ التكلفة عشان تشوف الهوامش والأرباح.", "No product costs recorded yet — fill the cost column to unlock margins & profit.")}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Kpi title={L("الربح التقديري (من المبيعات)", "Estimated profit (sales)")} value={money(analytics.margins.estProfit)} icon="💵" accent="green" />
              <Kpi title={L("هامش الربح", "Profit margin")} value={`${analytics.margins.profitMarginPct}%`} icon="📈" accent={analytics.margins.profitMarginPct < 0 ? "amber" : "green"} />
              <Kpi title={L("تحت التكلفة", "Below cost")} value={nf(analytics.margins.belowCost.length)} icon="🚨" accent={analytics.margins.belowCost.length > 0 ? "amber" : undefined} />
              <Kpi title={L("تغطية التكلفة", "Cost coverage")} value={`${Math.round(analytics.margins.costCoveragePct)}%`} icon="🏷️" />
            </div>
            <p className="text-[11px] text-muted">{L("الربح = المباع × (السعر الفعلي − التكلفة) للمنتجات اللي لها تكلفة فقط.", "Profit = sold × (effective price − cost), cost-known products only.")}</p>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {analytics.margins.belowCost.length > 0 ? (
                <div className="card border-rose-200 bg-rose-50/50">
                  <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-rose-700">🚨 {L("سعر البيع أقل من التكلفة — يحتاج تصحيح", "Selling below cost — fix these")}</h4>
                  <MarginList items={analytics.margins.belowCost} en={en} money={money} />
                </div>
              ) : null}
              <div className="card">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{L("أضعف الهوامش", "Thinnest margins")}</h4>
                <MarginList items={analytics.margins.lowest} en={en} money={money} />
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Dead stock ───────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">🧊 {L("المخزون الميت", "Dead stock")}</h3>
        <p className="text-[11px] text-muted">{L("منتجات في المخزون وما انباع منها ولا قطعة — فلوس واقفة على الرف.", "In stock but never sold a single unit — money sitting on the shelf.")}</p>
        {analytics.deadStock.count === 0 ? (
          <div className="card py-8 text-center text-sm text-emerald-600">{L("ما فيه مخزون ميت 🎉 كل اللي بالمخزون له مبيعات.", "No dead stock 🎉 everything in stock has sold.")}</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Kpi title={L("منتجات ميتة", "Dead products")} value={nf(analytics.deadStock.count)} icon="🧊" accent="amber" />
              <Kpi title={L("قطع واقفة", "Units sitting")} value={nf(analytics.deadStock.units)} icon="📦" />
              <Kpi title={L("قيمتها بسعر البيع", "Value at price")} value={money(analytics.deadStock.tiedUpAtPrice)} icon="💸" accent="amber" />
            </div>
            <div className="card">
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{L("الأعلى قيمة واقفة (تكلفة إن وُجدت، وإلا سعر)", "Most money tied up (cost when known, else price)")}</h4>
              <DeadList items={analytics.deadStock.items} en={en} money={money} />
            </div>
          </>
        )}
      </section>

      {/* ── Inventory valuation ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-ink">🏦 {L("قيمة المخزون", "Inventory valuation")}</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Kpi title={L("منتجات", "SKUs")} value={nf(analytics.valuation.skus)} icon="🏷️" />
          <Kpi title={L("إجمالي القطع", "Total units")} value={nf(analytics.valuation.units)} icon="📦" />
          <Kpi title={L("القيمة بسعر البيع", "Value at price")} value={money(analytics.valuation.atPrice)} icon="💰" accent="green" />
          <Kpi title={L("القيمة بالتكلفة", "Value at cost")} value={analytics.margins.withCost > 0 ? money(analytics.valuation.atCost) : L("— (بدون تكلفة)", "— (no costs)")} icon="🧾" />
        </div>
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
            <span className="h-8 w-8 shrink-0 overflow-hidden rounded-sm border border-slate-200 bg-slate-50">
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

function DeadList({ items, en, money }: { items: DeadStockItem[]; en: boolean; money: (n: number) => string }) {
  if (items.length === 0) return <p className="text-sm text-slate-400">—</p>;
  const max = Math.max(1, ...items.map((i) => i.tiedUp));
  return (
    <div className="space-y-2">
      {items.map((it, i) => {
        const label = (en ? it.name : it.nameAr) || it.name || it.sku || "—";
        const row = (
          <>
            <span className="w-4 shrink-0 text-[11px] text-slate-400">{i + 1}</span>
            <span className="h-8 w-8 shrink-0 overflow-hidden rounded-sm border border-slate-200 bg-slate-50">
              {it.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.image} alt="" className="h-full w-full object-cover" />
              ) : <span className="flex h-full w-full items-center justify-center text-slate-300">📦</span>}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{label}</span>
              <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                <span className="block h-full bg-sky-500" style={{ width: `${(it.tiedUp / max) * 100}%` }} />
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-slate-400">×{it.stock}</span>
            <span className="shrink-0 text-xs font-semibold text-ink">{money(it.tiedUp)}</span>
          </>
        );
        return it.productId ? (
          <Link key={it.productId} href={`/products/${it.productId}`} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-slate-50">{row}</Link>
        ) : (
          <div key={`d-${i}`} className="flex items-center gap-2 px-1 py-1">{row}</div>
        );
      })}
    </div>
  );
}

function MarginList({ items, en, money }: { items: MarginItem[]; en: boolean; money: (n: number) => string }) {
  if (items.length === 0) return <p className="text-sm text-slate-400">—</p>;
  return (
    <div className="space-y-2">
      {items.map((it, i) => {
        const label = (en ? it.name : it.nameAr) || it.name || it.sku || "—";
        const neg = it.margin < 0;
        const row = (
          <>
            <span className="w-4 shrink-0 text-[11px] text-slate-400">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{label}</span>
              <span className="block text-[11px] text-slate-400">
                {money(it.price)} − {money(it.cost)}
              </span>
            </span>
            <span className={`shrink-0 text-xs font-semibold ${neg ? "text-rose-600" : it.marginPct < 15 ? "text-amber-700" : "text-emerald-700"}`}>
              {money(it.margin)} · {it.marginPct}%
            </span>
          </>
        );
        return it.productId ? (
          <Link key={it.productId} href={`/products/${it.productId}`} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-slate-50">{row}</Link>
        ) : (
          <div key={`m-${i}`} className="flex items-center gap-2 px-1 py-1">{row}</div>
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
