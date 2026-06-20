import { getCeoKpis, type NameCount, type ChannelBreak } from "@/lib/dashboard";
import { recordAndDiffSnapshot } from "@/lib/kpiSnapshots";
import DashboardRefresh from "@/components/DashboardRefresh";

export const dynamic = "force-dynamic";

const nf = (n: number) => new Intl.NumberFormat("en-US").format(n);

export default async function DashboardPage() {
  const k = await getCeoKpis();
  const trends = k.configured ? await recordAndDiffSnapshot(k) : null;
  const healthIssues = k.missingPrice + k.missingImage + k.missingBarcode + k.missingCategory;

  return (
    <div className="space-y-6">
      {/* Header + live freshness indicator */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink">Manager dashboard</h2>
        {k.configured ? <DashboardRefresh generatedAt={k.generatedAt} /> : null}
      </div>

      {!k.configured ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Supabase isn’t configured — add your keys to see live KPIs.
        </div>
      ) : null}

      {trends?.asOf ? (
        <p className="-mt-2 text-xs text-muted">▲▼ change since {trends.asOf}</p>
      ) : null}

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Kpi title="Total products" value={nf(k.totalProducts)} icon="📦" hint="In the catalog"
          delta={trends?.totalProducts ?? undefined} goodWhen="up" />
        <Kpi title="Published across channels" value={nf(k.publishedActive)} icon="🚀"
          hint={`Active listings on ${k.publishedChannels} channel${k.publishedChannels === 1 ? "" : "s"}`} accent="green"
          delta={trends?.publishedActive ?? undefined} goodWhen="up" />
        <Kpi title="Categories · Brands" value={`${k.categoriesCount} · ${k.brandsCount}`} icon="🗂️"
          hint={`${nf(k.productsWithBrand)} products have a brand assigned`} />
        <Kpi title="Featured · Promoted" value={`${nf(k.featuredCount)} · ${nf(k.promotedCount)}`} icon="⭐"
          hint="is_featured · is_promoted" />
        {k.inventoryTracked ? (
          <Kpi title="Inventory units" value={nf(k.inventoryUnits)} icon="🏷️"
            hint={`across ${nf(k.inventoryRows)} tracked products`} />
        ) : (
          <Kpi title="Inventory" value="—" icon="🏷️"
            hint={`${nf(k.inventoryRows)} products seeded at 50 · pending stocktake`} accent="muted" />
        )}
      </div>

      {/* Catalog health strip — data quality at a glance */}
      <Section title="Catalog health">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <HealthChip label="Missing price" value={k.missingPrice} />
          <HealthChip label="Missing image" value={k.missingImage} />
          <HealthChip label="Missing barcode" value={k.missingBarcode} />
          <HealthChip label="Missing category" value={k.missingCategory} />
        </div>
        {healthIssues === 0 ? (
          <p className="mt-3 text-sm text-green-600">All products have a price, image, barcode, and category 🎉</p>
        ) : (
          <p className="mt-3 text-sm text-amber-700">{nf(healthIssues)} field gap{healthIssues === 1 ? "" : "s"} to fix.</p>
        )}
      </Section>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title={`Products per category (${k.categoryBreakdown.length})`}>
          <Bars items={k.categoryBreakdown} color="bg-brand" />
        </Section>

        <Section title="Brands by product count (top 10)">
          {k.brandBreakdown.length === 0 ? (
            <Empty text="No products have a brand assigned yet." />
          ) : (
            <Bars items={k.brandBreakdown} color="bg-indigo-500" />
          )}
        </Section>
      </div>

      <Section title="Channel listing status (per channel)">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Active</th>
                <th className="px-3 py-2 font-medium">Draft</th>
                <th className="px-3 py-2 font-medium">Not Listed</th>
                <th className="px-3 py-2 font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Active share</th>
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
          <div className="h-4 flex-1 overflow-hidden rounded bg-slate-100">
            <div className={`h-full ${color}`} style={{ width: `${(it.count / max) * 100}%` }} />
          </div>
          <span className="w-10 shrink-0 text-right font-medium text-ink">{it.count}</span>
        </div>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) { return <p className="text-sm text-slate-400">{text}</p>; }
