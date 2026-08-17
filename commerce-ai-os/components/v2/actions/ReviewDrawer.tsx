"use client";
// AI.1 — Review Drawer (§6). Presentational only. Selecting an Action opens this
// panel showing Reason, Evidence, Current State, Suggested State and a link to
// Open the Original Workflow. There are deliberately NO execution buttons yet —
// AI.1 is read-only; nothing here mutates or runs anything.

import Link from "next/link";
import type { Action, ActionSeverity } from "@/lib/actions/action-model";

const SEVERITY_STYLE: Record<ActionSeverity, string> = {
  critical: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
  info: "bg-slate-100 text-slate-600",
};

const SEVERITY_LABEL: Record<ActionSeverity, string> = {
  critical: "حرِج",
  warning: "تحذير",
  info: "معلومة",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

export default function ReviewDrawer({ action, onClose }: { action: Action | null; onClose: () => void }) {
  if (!action) return null;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="مراجعة الإجراء">
      <button type="button" aria-label="إغلاق" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div className="absolute inset-y-0 left-0 flex w-full max-w-md flex-col overflow-y-auto border-e border-[#efe3d6] bg-[#fffaf4] shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-[#efe3d6] p-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className={"rounded-full px-2 py-0.5 text-[11px] font-semibold " + SEVERITY_STYLE[action.severity]}>
                {SEVERITY_LABEL[action.severity]}
              </span>
              <span className="text-[11px] text-muted">{action.type}</span>
            </div>
            <h2 className="text-base font-bold text-slate-800">{action.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="shrink-0 rounded-lg border border-[#e7d9c9] bg-white px-2 py-1 text-sm text-muted hover:bg-[#faf3ec]"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 p-4">
          <Field label="السبب">{action.reason}</Field>

          <Field label="الدليل">
            {action.evidence.length > 0 ? (
              <ul className="space-y-1">
                {action.evidence.map((e, i) => (
                  <li key={i} className="flex justify-between gap-3 rounded-lg bg-white/70 px-2.5 py-1.5">
                    <span className="text-muted">{e.label}</span>
                    <span className="font-medium">{e.value}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted">—</span>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="الحالة الحالية">{action.currentState ?? <span className="text-muted">—</span>}</Field>
            <Field label="الحالة المقترحة">{action.suggestedState ?? <span className="text-muted">—</span>}</Field>
          </div>

          {action.impact ? <Field label="الأثر">{action.impact}</Field> : null}

          {action.entityLabel ? <Field label="العنصر">{action.entityLabel}</Field> : null}

          <div className="border-t border-[#efe3d6] pt-4">
            {action.workflowHref ? (
              <Link
                href={action.workflowHref}
                className="inline-flex items-center gap-2 rounded-xl bg-brand px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                {action.source === "lifecycle" ? "فتح مراجعة دورة الحياة" : "فتح سير العمل الأصلي"}
                <span aria-hidden="true">↗</span>
              </Link>
            ) : (
              <span className="text-xs text-muted">لا يوجد سير عمل مرتبط</span>
            )}
            {/* No execution buttons in AI.1 — this drawer only reviews. */}
            <p className="mt-2 text-[11px] text-muted">
              المركز للقراءة والمراجعة فقط. لا يوجد تنفيذ في هذه المرحلة.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
