// CAT.1B — unified read-only Evidence section (presentational). Replaces scattered
// product warnings with ONE evidence list grouped by severity, expandable. No
// actions, no fetching — renders an EvidenceResult the server already computed.

import type { EvidenceResult } from "@/lib/catalog/evidence/evidence-engine";
import type { Evidence, EvidenceSeverity } from "@/lib/catalog/evidence/evidence-model";

const GROUPS: { severity: EvidenceSeverity; label: string; tone: string }[] = [
  { severity: "CRITICAL", label: "حرِج", tone: "border-rose-300 bg-rose-50 text-rose-800" },
  { severity: "ERROR", label: "خطأ", tone: "border-orange-300 bg-orange-50 text-orange-800" },
  { severity: "WARNING", label: "تحذير", tone: "border-amber-300 bg-amber-50 text-amber-800" },
  { severity: "INFO", label: "معلومة", tone: "border-slate-300 bg-slate-50 text-slate-700" },
];

function Item({ e }: { e: Evidence }) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">{e.domain}</span>
        <span className="text-ink" dir="ltr">{e.summary}</span>
        <span className="text-[10px] text-muted">· {e.confidence} · {e.source}</span>
      </div>
      {e.recommendedAction ? <p className="mt-1 text-muted" dir="ltr">→ {e.recommendedAction}</p> : null}
    </li>
  );
}

export default function EvidenceSection({ result }: { result: EvidenceResult }) {
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">الأدلة</h3>
        <span className="text-xs text-muted">{result.summary}</span>
      </div>
      {result.total === 0 ? (
        <p className="text-xs text-emerald-700">لا توجد أدلة نشطة — كل المجالات سليمة.</p>
      ) : (
        <div className="space-y-2">
          {GROUPS.map(({ severity, label, tone }) => {
            const items = result.evidence.filter((e) => e.severity === severity);
            if (items.length === 0) return null;
            return (
              <details key={severity} className="group" open={severity === "CRITICAL" || severity === "ERROR"}>
                <summary className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-1.5 text-xs font-semibold ${tone}`}>
                  <span>{label}</span>
                  <span className="tabular-nums">{items.length}</span>
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {items.map((e) => <Item key={e.id} e={e} />)}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
