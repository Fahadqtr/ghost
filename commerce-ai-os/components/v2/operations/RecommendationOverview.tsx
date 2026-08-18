// CAT.1D — read-only Recommendation overview (presentational). Catalog-wide
// counts by priority + type for Operations (§10). No actions, no fetching.

import type { RecommendationSummary } from "@/lib/catalog/recommendations/recommendation-engine";
import type { RecommendationPriority, RecommendationType } from "@/lib/catalog/recommendations/recommendation-model";
import { TYPE_LABEL } from "@/lib/catalog/recommendations/recommendation-model";

const PRIORITY_ORDER: RecommendationPriority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const PRIORITY_LABEL: Record<RecommendationPriority, string> = { CRITICAL: "حرِج", HIGH: "عالية", MEDIUM: "متوسطة", LOW: "منخفضة" };
const PRIORITY_TONE: Record<RecommendationPriority, string> = {
  CRITICAL: "border-rose-200 bg-rose-50 text-rose-700",
  HIGH: "border-orange-200 bg-orange-50 text-orange-700",
  MEDIUM: "border-amber-200 bg-amber-50 text-amber-700",
  LOW: "border-slate-200 bg-slate-50 text-slate-600",
};

export default function RecommendationOverview({ summary }: { summary: RecommendationSummary }) {
  const types = Object.entries(summary.byType).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...types.map(([, n]) => n));

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">نظرة عامة على التوصيات</h3>
        <span className="text-xs text-muted">{summary.total} توصية · {summary.productsWithRecommendations} منتج</span>
      </div>
      <p className="text-xs text-muted">توصيات معتمدة مشتقّة من الأدلة فقط — للقراءة فقط.</p>

      <div className="flex flex-wrap gap-2 text-xs">
        {PRIORITY_ORDER.map((p) => (
          <span key={p} className={`rounded-full border px-2 py-0.5 ${PRIORITY_TONE[p]}`}>
            {PRIORITY_LABEL[p]} {summary.byPriority[p]}
          </span>
        ))}
      </div>

      <div>
        <h4 className="mb-1 text-xs font-semibold text-muted">حسب النوع</h4>
        <ul className="space-y-1.5">
          {types.map(([type, n]) => (
            <li key={type} className="flex items-center gap-3 text-xs">
              <span className="w-40 shrink-0 truncate text-ink">{TYPE_LABEL[type as RecommendationType] ?? type}</span>
              <span className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
                <span className="block h-full bg-slate-400" style={{ width: `${Math.round((n / max) * 100)}%` }} />
              </span>
              <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-ink">{n}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
