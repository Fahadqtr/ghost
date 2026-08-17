"use client";

// OPS.8B — product lifecycle panel + review UX (client). Presents the DERIVED
// lifecycle picture (current state, readiness, approval, blocking reasons) and
// the available transitions. Every transition opens a confirmation showing the
// target and its IMPACT before calling the single server-side boundary. It holds
// no lifecycle logic — the server re-validates auth, readiness, and the state
// graph, and is the only writer of lifecycle_state.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  LIFECYCLE_DISPLAY_LABEL,
  TRANSITION_ACTION_LABEL,
  type AvailableTransition,
  type LifecycleDisplay,
} from "@/lib/lifecycle/transitions";
import type { LifecycleState } from "@/lib/lifecycle/state";
import type { ProductLifecycleView } from "@/lib/lifecycle/lifecycle-read.server";
import type { TransitionInput, TransitionResult } from "@/lib/lifecycle/transition.server";

type ActionFn = (input: TransitionInput) => Promise<TransitionResult>;

const BADGE_TONE: Record<LifecycleDisplay, string> = {
  DRAFT: "border-slate-200 bg-slate-50 text-slate-700",
  READY: "border-sky-200 bg-sky-50 text-sky-700",
  ACTIVE: "border-emerald-200 bg-emerald-50 text-emerald-700",
  STOPPED: "border-amber-200 bg-amber-50 text-amber-700",
  ARCHIVED: "border-slate-300 bg-slate-100 text-slate-600",
};

// Fixed, honest impact copy per target. Channel publication is NEVER touched by
// a lifecycle transition in this phase — say so explicitly (OPS.8B §13).
function impactFor(to: LifecycleState): string[] {
  if (to === "STOPPED") {
    return [
      "يبقى المنتج في الكتالوج، ويحتفظ بالمخزون والوسائط والسجل والربط بالمنصات.",
      "يخرج المنتج من دورة البيع النشطة فقط.",
      "لا يتم إخفاء أو إلغاء نشر المنتج على أي متجر تلقائياً في هذه المرحلة.",
    ];
  }
  if (to === "ACTIVE") {
    return [
      "يدخل المنتج دورة البيع النشطة.",
      "التفعيل لا ينشر المنتج على أي متجر تلقائياً — النشر على المنصات يتطلب إجراءً منفصلاً.",
    ];
  }
  return [
    "يعود المنتج إلى مسودة للتعديل، ويخرج من دورة البيع النشطة.",
    "لا يتم تغيير النشر على المنصات تلقائياً.",
  ];
}

const OUTCOME_MESSAGE: Record<TransitionResult["outcome"], string> = {
  UPDATED: "تم تحديث حالة المنتج.",
  UNCHANGED: "المنتج بالفعل في هذه الحالة.",
  BLOCKED: "تعذّر الانتقال — راجع الأسباب.",
  STALE: "تغيّرت حالة المنتج — تم تحديث الصفحة، حاول مجدداً.",
  FAILED: "تعذّر تنفيذ الإجراء.",
};

export default function LifecyclePanel({
  view,
  action,
  highlight = false,
}: {
  view: ProductLifecycleView;
  action: ActionFn;
  /** OPS.8C — set when deep-linked via ?panel=lifecycle: draws attention to the panel. */
  highlight?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<AvailableTransition | null>(null);
  const [result, setResult] = useState<TransitionResult | null>(null);

  const run = (target: AvailableTransition) => {
    setResult(null);
    startTransition(async () => {
      const r = await action({
        productId: view.productId,
        targetState: target.to,
        expectedFromState: view.state,
      });
      setResult(r);
      setConfirming(null);
      if (r.outcome === "UPDATED" || r.outcome === "STALE") router.refresh();
    });
  };

  return (
    <div className={`card space-y-4${highlight ? " ring-2 ring-brand" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">دورة حياة المنتج</h2>
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${BADGE_TONE[view.display]}`}>
          {LIFECYCLE_DISPLAY_LABEL[view.display]}
        </span>
      </div>

      {/* readiness + approval */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 p-3 text-sm">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-muted">الجاهزية</span>
            <span className="font-medium">{view.readinessPercent}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full ${view.ready ? "bg-emerald-500" : "bg-amber-400"}`}
              style={{ width: `${Math.max(0, Math.min(100, view.readinessPercent))}%` }}
            />
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 p-3 text-sm">
          <span className="text-muted">الاعتماد</span>
          <div className="mt-1 font-medium">
            {view.approved ? "معتمد" : "غير معتمد"}
            {view.display === "READY" ? " — جاهز للتفعيل" : ""}
          </div>
        </div>
      </div>

      {/* blocking reasons (why not READY) */}
      {!view.ready && view.blockingReasons.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <div className="mb-1 font-medium">لتفعيل المنتج يجب معالجة:</div>
          <ul className="list-disc space-y-0.5 pr-5">
            {view.blockingReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* result banner */}
      {result ? (
        <div
          className={`rounded-lg border p-3 text-sm ${
            result.outcome === "UPDATED"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : result.outcome === "UNCHANGED"
                ? "border-slate-200 bg-slate-50 text-slate-600"
                : "border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          <div>{result.error ?? OUTCOME_MESSAGE[result.outcome]}</div>
          {result.reasons && result.reasons.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pr-5">
              {result.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* transition actions + inline confirmation */}
      {confirming ? (
        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm">
          <div className="mb-2 font-medium">
            تأكيد الانتقال: {LIFECYCLE_DISPLAY_LABEL[view.state]} ← {LIFECYCLE_DISPLAY_LABEL[confirming.to]}
          </div>
          <ul className="mb-3 list-disc space-y-0.5 pr-5 text-muted">
            {impactFor(confirming.to).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={pending} onClick={() => run(confirming)}>
              {pending ? "جارٍ التنفيذ…" : "تأكيد"}
            </button>
            <button type="button" className="btn-ghost" disabled={pending} onClick={() => setConfirming(null)}>
              إلغاء
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {view.transitions.length === 0 ? (
            <span className="text-sm text-muted">لا توجد انتقالات متاحة.</span>
          ) : (
            view.transitions.map((t) => (
              <button
                key={t.to}
                type="button"
                className="btn-ghost"
                disabled={pending || !t.allowedNow}
                title={t.blockedReason ?? undefined}
                onClick={() => {
                  setResult(null);
                  setConfirming(t);
                }}
              >
                {TRANSITION_ACTION_LABEL[t.to]}
                {t.authority === "owner" ? " (مالك)" : ""}
              </button>
            ))
          )}
        </div>
      )}

      {/* archive/restore is a separate certified cold-storage path (OPS.8A/INV.4E) */}
      <div className="border-t border-slate-100 pt-3 text-xs text-muted">
        الأرشفة والاسترجاع تتم من{" "}
        <Link href="/products/archive" className="underline">
          صفحة الأرشيف
        </Link>
        . الاسترجاع يعيد المنتج كمسودة.
      </div>
    </div>
  );
}
