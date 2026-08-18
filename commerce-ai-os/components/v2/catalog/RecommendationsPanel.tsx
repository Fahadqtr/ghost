// CAT.1D — read-only Recommendations panel (presentational). Shows the certified
// per-product recommendations grouped by priority, expandable, each linked back
// to the supporting CAT.1B evidence (§9/§13). NO actions, no mutation, no data
// fetching — it renders recommendations + evidence the server already computed.

import type { Recommendation, RecommendationPriority } from "@/lib/catalog/recommendations/recommendation-model";
import { TYPE_LABEL, PRIORITY_LABEL } from "@/lib/catalog/recommendations/recommendation-model";
import type { Evidence } from "@/lib/catalog/evidence/evidence-model";

const PRIORITY_ORDER: RecommendationPriority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

const PRIORITY_TONE: Record<RecommendationPriority, string> = {
  CRITICAL: "border-rose-200 bg-rose-50 text-rose-700",
  HIGH: "border-orange-200 bg-orange-50 text-orange-700",
  MEDIUM: "border-amber-200 bg-amber-50 text-amber-700",
  LOW: "border-slate-200 bg-slate-50 text-slate-600",
};

const CONFIDENCE_LABEL: Record<string, string> = { HIGH: "عالية", MEDIUM: "متوسطة", LOW: "منخفضة", UNKNOWN: "غير معروفة" };

export default function RecommendationsPanel({
  recommendations,
  evidence,
}: {
  recommendations: Recommendation[];
  /** the supporting evidence, for linking each recommendation back to its facts. */
  evidence: Evidence[];
}) {
  if (recommendations.length === 0) return null;
  const evById = new Map(evidence.map((e) => [e.id, e]));
  const groups = PRIORITY_ORDER
    .map((priority) => ({ priority, items: recommendations.filter((r) => r.priority === priority) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">التوصيات</h3>
        <span className="text-xs text-muted">{recommendations.length} توصية — للقراءة فقط</span>
      </div>
      <p className="text-xs text-muted">توصيات معتمدة مشتقّة من الأدلة فقط — كل توصية موضّحة بأدلتها الداعمة (بلا قرارات صندوق أسود).</p>

      {groups.map((g) => (
        <section key={g.priority} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${PRIORITY_TONE[g.priority]}`}>
              {PRIORITY_LABEL[g.priority]}
            </span>
            <span className="text-[11px] text-muted">{g.items.length}</span>
          </div>
          <ul className="space-y-2">
            {g.items.map((r) => (
              <li key={r.id}>
                <details className="rounded-lg border border-[#efe3d6] bg-white/60 p-2">
                  <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-medium text-ink">
                    <span>{TYPE_LABEL[r.type] ?? r.type}</span>
                    <span className="text-[11px] text-muted">ثقة: {CONFIDENCE_LABEL[r.confidence] ?? r.confidence}</span>
                  </summary>
                  <div className="mt-2 space-y-2 text-xs">
                    <p className="text-ink">{r.details}</p>
                    <div className="text-muted">
                      <span className="font-semibold">القاعدة:</span> {r.rule}
                      {r.ownerApprovalRequired ? <span className="ms-2 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">تتطلّب موافقة المالك</span> : null}
                    </div>
                    <div className="space-y-1">
                      <span className="font-semibold text-muted">الأدلة الداعمة:</span>
                      <ul className="space-y-1">
                        {r.sourceEvidenceIds.map((id) => {
                          const e = evById.get(id);
                          return (
                            <li key={id} className="rounded bg-[#faf3ec] px-2 py-1 text-ink">
                              {e ? e.summary : id}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    <a href={r.workflow} className="inline-flex items-center gap-1 text-brand hover:underline">
                      فتح سير العمل ↗
                    </a>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
