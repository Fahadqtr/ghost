import KpiCard from "@/components/KpiCard";
import { getDashboardKpis } from "@/lib/dashboard";

// Always render fresh data from the DB.
export const dynamic = "force-dynamic";

function money(n: number | null): string | null {
  if (n === null) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "QAR",
    maximumFractionDigits: 0,
  }).format(n);
}

export default async function DashboardPage() {
  const kpi = await getDashboardKpis();

  return (
    <div className="space-y-6">
      {!kpi.configured ? (
        <div className="card border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">
            Supabase isn’t configured yet. Add your project URL and anon key to{" "}
            <code className="rounded bg-amber-100 px-1">.env.local</code> to see
            live KPIs.
          </p>
        </div>
      ) : null}

      {/* KPI grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          title="Sales Today"
          value={kpi.salesToday === null ? null : money(kpi.salesToday)}
          icon="💰"
          hint="Sum of today’s orders"
        />
        <KpiCard
          title="Orders Today"
          value={kpi.ordersToday}
          icon="🧾"
          hint="Orders created today"
        />
        <KpiCard
          title="Low Stock"
          value={kpi.lowStock}
          icon="⚠️"
          hint="At or below threshold"
          emptyLabel="0"
        />
        <KpiCard
          title="Missing Images"
          value={kpi.missingImages}
          icon="🖼️"
          hint="Products without an image"
          emptyLabel="0"
        />
        <KpiCard
          title="Products"
          value={kpi.productsTotal}
          icon="📦"
          hint="Total in catalog"
          emptyLabel="0"
        />
        <KpiCard
          title="Alerts"
          value={kpi.alerts.length === 0 ? "All clear" : kpi.alerts.length}
          icon="🔔"
          hint="Items needing attention"
        />
      </div>

      {/* Top products + alerts detail */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-ink">Top Products</h2>
          {kpi.topProducts.length === 0 ? (
            <p className="text-sm text-slate-400">No sales data yet</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {kpi.topProducts.map((p, i) => (
                <li
                  key={`${p.name}-${i}`}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <span className="text-slate-700">{p.name}</span>
                  <span className="font-medium text-ink">{p.sold} sold</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-ink">Alerts</h2>
          {kpi.alerts.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing needs attention 🎉</p>
          ) : (
            <ul className="space-y-2">
              {kpi.alerts.map((a, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"
                >
                  <span>⚠️</span>
                  {a}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
