import Link from "next/link";
import { getCeoKpis, type NameCount, type ChannelBreak } from "@/lib/dashboard";
import { getStaffStats } from "@/lib/staff/stats";
import { getLowStockAlerts, type LowStockItem } from "@/lib/inventory/lowStock";
import { getT } from "@/lib/i18n-server";
import { recordAndDiffSnapshot } from "@/lib/kpiSnapshots";
import DashboardRefresh from "@/components/DashboardRefresh";

export const dynamic = "force-dynamic";

const nf = (n: number) => new Intl.NumberFormat("en-US").format(n);

export default async function DashboardPage() {
  const k = await getCeoKpis();
  const staff = await getStaffStats();
  const alerts = await getLowStockAlerts();
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const trends = k.configured ? await recordAndDiffSnapshot(k) : null;
  const healthIssues = k.missingPrice + k.missingImage + k.missingBarcode + k.missingCategory;

  return (
    <div className="space-y-6">
      {/* Header + live freshness indicator */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink">{L("لوحة المدير", "Manager dashboard")}</h2>
        {k.configured ? <DashboardRefresh generatedAt={k.generatedAt} /> : null}
      </div>

      {!k.configured ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          {L("لم يتم إعداد Supabase — أضِف المفاتيح لرؤية المؤشرات الحيّة.", "Supabase isn’t configured — add your keys to see live KPIs.")}
        </div>
      ) : null}

      {trends?.asOf ? (
        <p className="-mt-2 text-xs text-muted">{L(`▲▼ التغيّر منذ ${trends.asOf}`, `▲▼ change since ${trends.asOf}`)}</p>
      ) : null}

      {/* Open / overdue staff tasks */}
      {staff.configured && staff.tasks.open > 0 ? (
        <Link href="/tasks" className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 hover:bg-slate-50">
          <span className="text-sm font-semibold text-ink">
            📋 {L(`${staff.tasks.open} مهمة مفتوحة`, `${staff.tasks.open} open task${staff.tasks.open === 1 ? "" : "s"}`)}
            {staff.tasks.overdue > 0 ? <span className="ms-2 rounded-sm bg-red-100 px-1.5 py-0.5 text-xs font-bold text-red-700">🔴 {L(`${staff.tasks.overdue} متأخّرة`, `${staff.tasks.overdue} overdue`)}</span> : null}
          </span>
          <span className="text-xs font-medium text-brand">{L("المتابعة ←", "Manage →")}</span>
        </Link>
      ) : null}

      {/* New products submitted by staff, awaiting the owner's approval */}
      {staff.configured && staff.pendingProducts > 0 ? (
        <Link href="/products?review=staff" className="flex items-center justify-between gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 hover:bg-violet-100">
          <span className="text-sm font-semibold text-violet-900">🆕 {L(`${staff.pendingProducts} منتج جديد من الموظفين بانتظار اعتمادك`, `${staff.pendingProducts} new staff product${staff.pendingProducts === 1 ? "" : "s"} awaiting your approval`)}</span>
          <span className="text-xs font-medium text-violet-700">{L("مراجعة ←", "Review →")}</span>
        </Link>
      ) : null}

      {/* Low-stock alerts — the products that need restocking, front and centre */}
      {alerts.configured && alerts.items.length > 0 ? (
        <section dir={en ? "ltr" : "rtl"} className={`card border-amber-200 bg-amber-50/60 ${en ? "" : "text-right"}`}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-amber-900">
              ⚠️ {L("تنبيهات المخزون المنخفض", "Low-stock alerts")}
              <span className="ms-2 text-xs font-normal text-amber-700">
                {alerts.outCount > 0 ? L(`${alerts.outCount} نافد`, `${alerts.outCount} out`) : null}
                {alerts.outCount > 0 && alerts.lowCount > 0 ? " · " : null}
                {alerts.lowCount > 0 ? L(`${alerts.lowCount} منخفض`, `${alerts.lowCount} low`) : null}
              </span>
            </h3>
            <Link href="/inventory/out-of-stock" className="text-xs text-brand hover:underline whitespace-nowrap">{L("عرض الكل ←", "View all →")}</Link>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {alerts.items.map((it: LowStockItem, i: number) => {
              const body = (
                <>
                  <span className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-amber-200 bg-white">
                    {it.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.image} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-amber-300">📦</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-ink">{(en ? it.name : it.nameAr) || it.name || it.sku || "—"}</span>
                    <span className="block text-[11px] text-amber-700">
                      {it.out ? L("نافد", "Out of stock") : L(`متبقّي ${nf(it.stock)} · الحد ${nf(it.threshold)}`, `${nf(it.stock)} left · limit ${nf(it.threshold)}`)}
                    </span>
                  </span>
                  <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-bold ${it.out ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>{it.out ? "0" : nf(it.stock)}</span>
                </>
              );
              return it.productId ? (
                <Link key={it.productId} href={`/products/${it.productId}`} className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white p-2 hover:bg-amber-50">{body}</Link>
              ) : (
                <div key={`row-${i}`} className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white p-2">{body}</div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Staff stock movements (employees' IN/OUT + approval indicators) */}
      {staff.configured && (staff.week.in + staff.week.out > 0 || staff.review.pending > 0) ? (
        <section dir={en ? "ltr" : "rtl"} className={en ? "space-y-3" : "space-y-3 text-right"}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">{L("📦 حركات الموظفين (دخول/خروج)", "📦 Staff movements (in/out)")}</h3>
            <Link href="/inventory/approvals" className="text-xs text-brand hover:underline">{L("الاعتماد ←", "Approvals →")}</Link>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="card text-center">
              <p className="text-xs text-muted">{L("إدخال اليوم", "In today")}</p>
              <p className="text-2xl font-bold text-emerald-600">{nf(staff.today.in)}</p>
              <p className="text-[11px] text-muted">{nf(staff.today.inUnits)} {L("قطعة", "units")}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-muted">{L("إخراج اليوم", "Out today")}</p>
              <p className="text-2xl font-bold text-amber-600">{nf(staff.today.out)}</p>
              <p className="text-[11px] text-muted">{nf(staff.today.outUnits)} {L("قطعة", "units")}</p>
            </div>
            <div className={`card text-center ${staff.review.pending > 0 ? "border-amber-300 bg-amber-50" : ""}`}>
              <p className="text-xs text-muted">{L("بانتظار الاعتماد", "Pending approval")}</p>
              <p className="text-2xl font-bold text-amber-700">{nf(staff.review.pending)}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-muted">{L("معتمدة / معكوسة (الأسبوع)", "Approved / reversed (week)")}</p>
              <p className="text-2xl font-bold text-emerald-700">{nf(staff.review.approved)} <span className="text-base text-red-500">/ {nf(staff.review.reversed)}</span></p>
            </div>
          </div>
          {staff.byEmployeeToday.length ? (
            <div className="card">
              <p className="mb-2 text-xs font-semibold text-muted">{L("حركات اليوم حسب الموظف", "Today by employee")}</p>
              <div className="space-y-1.5">
                {staff.byEmployeeToday.map((e) => (
                  <div key={e.name} className="flex items-center justify-between text-sm">
                    <span className="font-medium text-ink">👤 {e.name}</span>
                    <span className="flex gap-2 text-xs">
                      <span className="rounded-sm bg-emerald-100 px-1.5 py-0.5 font-bold text-emerald-700">➕ {e.in}</span>
                      <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 font-bold text-amber-700">➖ {e.out}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Kpi title={L("إجمالي المنتجات", "Total products")} value={nf(k.totalProducts)} icon="📦" hint={L("في الكتالوج", "In the catalog")}
          delta={trends?.totalProducts ?? undefined} goodWhen="up" />
        <Kpi title={L("منشور عبر القنوات", "Published across channels")} value={nf(k.publishedActive)} icon="🚀"
          hint={L(`إعلانات فعّالة على ${k.publishedChannels} قناة`, `Active listings on ${k.publishedChannels} channel${k.publishedChannels === 1 ? "" : "s"}`)} accent="green"
          delta={trends?.publishedActive ?? undefined} goodWhen="up" />
        <Kpi title={L("الفئات · العلامات", "Categories · Brands")} value={`${k.categoriesCount} · ${k.brandsCount}`} icon="🗂️"
          hint={L(`${nf(k.productsWithBrand)} منتج له علامة تجارية`, `${nf(k.productsWithBrand)} products have a brand assigned`)} />
        <Kpi title={L("مميّز · مروّج", "Featured · Promoted")} value={`${nf(k.featuredCount)} · ${nf(k.promotedCount)}`} icon="⭐"
          hint="is_featured · is_promoted" />
        {k.inventoryTracked ? (
          <Kpi title={L("وحدات المخزون", "Inventory units")} value={nf(k.inventoryUnits)} icon="🏷️"
            hint={L(`عبر ${nf(k.inventoryRows)} منتج متتبَّع`, `across ${nf(k.inventoryRows)} tracked products`)} />
        ) : (
          <Kpi title={L("المخزون", "Inventory")} value="—" icon="🏷️"
            hint={L(`${nf(k.inventoryRows)} منتج مبدئيًا 50 · بانتظار الجرد`, `${nf(k.inventoryRows)} products seeded at 50 · pending stocktake`)} accent="muted" />
        )}
      </div>

      {/* Catalog health strip — data quality at a glance */}
      <Section title={L("جودة الكتالوج", "Catalog health")}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <HealthChip label={L("بدون سعر", "Missing price")} value={k.missingPrice} />
          <HealthChip label={L("بدون صورة", "Missing image")} value={k.missingImage} />
          <HealthChip label={L("بدون باركود", "Missing barcode")} value={k.missingBarcode} />
          <HealthChip label={L("بدون فئة", "Missing category")} value={k.missingCategory} />
        </div>
        {healthIssues === 0 ? (
          <p className="mt-3 text-sm text-green-600">{L("كل المنتجات لها سعر وصورة وباركود وفئة 🎉", "All products have a price, image, barcode, and category 🎉")}</p>
        ) : (
          <p className="mt-3 text-sm text-amber-700">{L(`${nf(healthIssues)} حقل ناقص للإصلاح.`, `${nf(healthIssues)} field gap${healthIssues === 1 ? "" : "s"} to fix.`)}</p>
        )}
      </Section>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title={L(`المنتجات لكل فئة (${k.categoryBreakdown.length})`, `Products per category (${k.categoryBreakdown.length})`)}>
          <Bars items={k.categoryBreakdown} color="bg-brand" />
        </Section>

        <Section title={L("العلامات حسب عدد المنتجات (أعلى 10)", "Brands by product count (top 10)")}>
          {k.brandBreakdown.length === 0 ? (
            <Empty text={L("لا يوجد منتجات لها علامة تجارية بعد.", "No products have a brand assigned yet.")} />
          ) : (
            <Bars items={k.brandBreakdown} color="bg-indigo-500" />
          )}
        </Section>
      </div>

      <Section title={L("حالة الإدراج لكل قناة", "Channel listing status (per channel)")}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
                <th className="px-3 py-2 font-medium">{L("القناة", "Channel")}</th>
                <th className="px-3 py-2 font-medium">{L("فعّال", "Active")}</th>
                <th className="px-3 py-2 font-medium">{L("مسودة", "Draft")}</th>
                <th className="px-3 py-2 font-medium">{L("غير مُدرَج", "Not Listed")}</th>
                <th className="px-3 py-2 font-medium">{L("الإجمالي", "Total")}</th>
                <th className="px-3 py-2 font-medium">{L("نسبة الفعّال", "Active share")}</th>
              </tr>
            </thead>
            <tbody>
              {k.channelBreakdown.map((c: ChannelBreak) => {
                const pct = c.total ? Math.round((c.active / c.total) * 100) : 0;
                return (
                  <tr key={c.channel} className="border-b border-slate-100">
                    <td className="px-3 py-2 font-medium text-ink">{c.channel}</td>
                    <td className="px-3 py-2 text-green-700">{nf(c.active)}</td>
                    <td className="px-3 py-2 text-amber-700">{nf(c.draft)}</td>
                    <td className="px-3 py-2 text-slate-500">{nf(c.notListed)}</td>
                    <td className="px-3 py-2 text-slate-600">{nf(c.total)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-muted">{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Kpi({ title, value, hint, icon, accent, delta, goodWhen }: { title: string; value: string | number; hint?: string; icon?: string; accent?: "green" | "amber" | "muted"; delta?: number; goodWhen?: "up" | "down" }) {
  const color = accent === "green" ? "text-green-700" : accent === "amber" ? "text-amber-700" : accent === "muted" ? "text-slate-500" : "text-ink";
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted">{title}</p>
        {icon ? <span className="text-lg">{icon}</span> : null}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <p className={`text-2xl font-semibold ${color}`}>{value}</p>
        {typeof delta === "number" && delta !== 0 ? <Delta value={delta} goodWhen={goodWhen ?? "up"} /> : null}
      </div>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function Delta({ value, goodWhen }: { value: number; goodWhen: "up" | "down" }) {
  const up = value > 0;
  const good = goodWhen === "up" ? up : !up;
  const cls = good ? "text-green-600" : "text-red-600";
  return (
    <span className={`text-xs font-medium ${cls}`} title="vs previous day">
      {up ? "▲" : "▼"} {nf(Math.abs(value))}
    </span>
  );
}

function HealthChip({ label, value }: { label: string; value: number }) {
  const ok = value === 0;
  const cls = ok ? "border-green-100 bg-green-50 text-green-700" : "border-amber-100 bg-amber-50 text-amber-700";
  return (
    <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${cls}`}>
      <span className="text-sm font-medium">{label}</span>
      <span className="text-lg font-semibold">{ok ? "✓" : nf(value)}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3 className="mb-3 text-sm font-semibold text-ink">{title}</h3>
      {children}
    </div>
  );
}

function Bars({ items, color }: { items: NameCount[]; color: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.name} className="flex items-center gap-2 text-sm">
          <span className="w-40 shrink-0 truncate text-slate-600" title={it.name}>{it.name}</span>
          <div className="h-4 flex-1 overflow-hidden rounded-sm bg-slate-100">
            <div className={`h-full ${color}`} style={{ width: `${(it.count / max) * 100}%` }} />
          </div>
          <span className="w-10 shrink-0 text-right font-medium text-ink">{it.count}</span>
        </div>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) { return <p className="text-sm text-slate-400">{text}</p>; }
