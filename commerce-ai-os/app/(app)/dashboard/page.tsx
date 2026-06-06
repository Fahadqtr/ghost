import Link from "next/link";
import { getCeoKpis, type NameCount, type ChannelBreak } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

const nf = (n: number) => new Intl.NumberFormat("en-US").format(n);

export default async function DashboardPage() {
  const k = await getCeoKpis();

  return (
    <div className="space-y-6">
      {!k.configured ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          Supabase isn’t configured — add your keys to see live KPIs.
        </div>
      ) : null}

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Kpi title="Total products" value={nf(k.totalProducts)} icon="📦" hint="In the catalog" />
        <Kpi title="Categories · Brands" value={`${k.categoriesCount} · ${k.brandsCount}`} icon="🗂️"
          hint={`${nf(k.productsWithBrand)} products have a brand assigned`} />
        <Kpi title="Live on Snoonu" value={nf(k.approvedCount)} icon="🟢" hint="approval = Approved" accent="green" />
        <Kpi title="Missing image" value={nf(k.missingImage)} icon="🖼️"
          hint="image_url is null" accent={k.missingImage > 0 ? "amber" : undefined} />
        <Kpi title="Featured · Promoted" value={`${nf(k.featuredCount)} · ${nf(k.promotedCount)}`} icon="⭐"
          hint="is_featured · is_promoted" />
        <Kpi title="Inventory units" value={nf(k.inventoryUnits)} icon="🏷️"
          hint={`across ${nf(k.inventoryRows)} products — placeholder, pending stocktake`} accent="muted" />
      </div>

      {/* Approval breakdown */}
      <Section title="Approval status (Snoonu)">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ApprovalChip label="Approved" value={k.approvedCount} tone="green" />
          <ApprovalChip label="Rejected" value={k.rejectedCount} tone="red" />
          <ApprovalChip label="SentAI" value={k.sentAiCount} tone="amber" />
          <ApprovalChip label="No status" value={k.noApprovalCount} tone="slate" />
        </div>

        {k.rejectedCount > 0 ? (
          <details className="mt-3 rounded-lg border border-red-100 bg-red-50/50">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-red-700">
              View rejected ({k.rejectedCount})
            </summary>
            <ul className="divide-y divide-red-100 px-3 pb-2">
              {k.rejectedList.map((r) => (
                <li key={r.id} className="py-2">
                  <Link href={`/products/${r.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline">
                    <span className="truncate text-ink">{r.name_en ?? "—"}</span>
                    <span className="shrink-0 font-mono text-xs text-muted">{r.sku ?? "—"}</span>
                  </Link>
                </li>
              ))}
              {k.rejectedCount > k.rejectedList.length ? (
                <li className="py-2 text-xs text-muted">…and {k.rejectedCount - k.rejectedList.length} more</li>
              ) : null}
            </ul>
          </details>
        ) : (
          <p className="mt-3 text-sm text-slate-400">No rejected products 🎉</p>
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

function Kpi({ title, value, hint, icon, accent }: { title: string; value: string | number; hint?: string; icon?: string; accent?: "green" | "amber" | "muted" }) {
  const color = accent === "green" ? "text-green-700" : accent === "amber" ? "text-amber-700" : accent === "muted" ? "text-slate-500" : "text-ink";
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted">{title}</p>
        {icon ? <span className="text-lg">{icon}</span> : null}
      </div>
      <p className={`mt-2 text-2xl font-semibold ${color}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function ApprovalChip({ label, value, tone }: { label: string; value: number; tone: "green" | "red" | "amber" | "slate" }) {
  const cls =
    tone === "green" ? "bg-green-50 text-green-700"
    : tone === "red" ? "bg-red-50 text-red-700"
    : tone === "amber" ? "bg-amber-50 text-amber-700"
    : "bg-slate-50 text-slate-500";
  return (
    <div className={`rounded-lg px-3 py-2 ${cls}`}>
      <p className="text-xs font-medium">{label}</p>
      <p className="text-xl font-semibold">{nf(value)}</p>
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
