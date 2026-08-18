// CAT.1A — read-only Catalog Health distribution (presentational). Renders the
// grade counts + mean score across the catalog. No actions, no fetching.

import type { HealthDistribution } from "@/lib/catalog/health/health-engine";
import type { HealthGrade } from "@/lib/catalog/health/health-model";

const ROWS: { grade: HealthGrade; tone: string }[] = [
  { grade: "Excellent", tone: "bg-emerald-500" },
  { grade: "Good", tone: "bg-lime-500" },
  { grade: "Fair", tone: "bg-amber-500" },
  { grade: "Poor", tone: "bg-orange-500" },
  { grade: "Critical", tone: "bg-rose-500" },
];

export default function CatalogHealthDistribution({ dist }: { dist: HealthDistribution }) {
  const max = Math.max(1, ...ROWS.map((r) => dist.byGrade[r.grade]));
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">توزيع صحة الكتالوج</h3>
        <span className="text-xs text-muted">متوسط {dist.averageScore}/100 · {dist.total} منتج</span>
      </div>
      <p className="text-xs text-muted">
        توزيع للقراءة فقط لمجالات محتوى الكتالوج. (ربط ECL/القنوات/المخزون تُقيَّم لكل منتج على صفحة المنتج.)
      </p>
      <ul className="space-y-2">
        {ROWS.map((r) => {
          const n = dist.byGrade[r.grade];
          return (
            <li key={r.grade} className="flex items-center gap-3 text-xs">
              <span className="w-20 shrink-0 text-ink">{r.grade}</span>
              <span className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
                <span className={`block h-full ${r.tone}`} style={{ width: `${Math.round((n / max) * 100)}%` }} />
              </span>
              <span className="w-12 shrink-0 text-right font-semibold tabular-nums text-ink">{n}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
