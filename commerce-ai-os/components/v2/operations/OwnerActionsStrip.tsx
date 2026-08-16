// OPS.7 — Owner Actions strip (PRESENTATIONAL). A compact summary of the AI.1
// Action Center lanes near the top of Operations, so the operator sees "what
// needs attention / approval" at a glance and clicks through to /v2/actions.
// It reuses the AI.1 read model (the page passes the already-built summary) and
// duplicates NO action list — just four counts, each a lane deep-link.

import Link from "next/link";
import type { ActionSummary } from "@/lib/actions/action-model";

const LANES: { key: keyof ActionSummary; lane: string; label: string; tone: string }[] = [
  { key: "critical", lane: "critical", label: "حرِج", tone: "border-rose-200 bg-rose-50 text-rose-700" },
  { key: "approvalRequired", lane: "approval_required", label: "بحاجة لموافقة", tone: "border-amber-200 bg-amber-50 text-amber-700" },
  { key: "autoEligible", lane: "auto_eligible", label: "مؤهّل للتنفيذ الآلي", tone: "border-sky-200 bg-sky-50 text-sky-700" },
  { key: "waiting", lane: "waiting", label: "بالانتظار", tone: "border-slate-200 bg-slate-50 text-slate-600" },
];

export default function OwnerActionsStrip({ summary }: { summary: ActionSummary }) {
  return (
    <section className="card space-y-2" aria-label="ملخّص إجراءات المالك">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-700">إجراءات المالك</h2>
        <Link href="/v2/actions" className="text-xs font-semibold text-brand hover:underline">
          مركز الإجراءات ↗
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {LANES.map((l) => (
          <Link
            key={l.lane}
            href={`/v2/actions?lane=${l.lane}`}
            className={"flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 transition hover:brightness-95 " + l.tone}
          >
            <span className="text-2xl font-bold">{summary[l.key]}</span>
            <span className="text-[11px] font-medium opacity-80">{l.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
