// /v2/actions — Unified Action Center (AI.1). The future home of every AI
// recommendation (§1). READ-ONLY: it aggregates actionable items from the
// certified OPS + BI read models, never scans or mutates anything.
//
// The PRIMARY read (OPS Health + Analytics) backs the top summary and the
// grouped-by-type view and paints immediately; the product-level Media + AI
// queues are STREAMED under Suspense (§9 lazy secondary sections).

import { Suspense } from "react";

import { loadActionCenter, loadActionCenterDetail } from "@/lib/actions/action-center.server";
import { ACTION_LANES, type ActionLane } from "@/lib/actions/action-model";
import { scopeActionCenterView } from "@/lib/actions/action-scope";
import { loadMasterScope } from "@/lib/home/master-scope.server";
import ActionCenter from "@/components/v2/actions/ActionCenter";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// OPS.7 — validate a deep-linked lane (e.g. from the Operations Owner-Actions
// strip). Unknown values fall through to null so the page shows all lanes.
function parseLane(v: string | string[] | undefined): ActionLane | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && (ACTION_LANES as readonly string[]).includes(s) ? (s as ActionLane) : null;
}

function SectionSkeleton() {
  return (
    <section className="card space-y-2" aria-busy="true">
      <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    </section>
  );
}

// Streamed secondary — the product-level Media + AI queues (§9).
async function ProductQueues() {
  const [detail, scope] = await Promise.all([loadActionCenterDetail(), loadMasterScope()]);
  return (
    <ActionCenter
      view={scopeActionCenterView(detail, (id) => scope.ids.has(id), scope.ok)}
      heading="مهام على مستوى المنتج"
    />
  );
}

export default async function ActionsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const initialLane = parseLane(params.lane);
  // CURRENT MASTER scope. Product-bound actions outside the active
  // snoonu:malikas master are not current operational work; global/system
  // findings (entityId null) carry no membership semantics and are kept.
  //
  // Fails CLOSED on product-derived data: an unreadable membership drops every
  // product-bound action rather than falling back to the whole catalog. Global
  // findings still render, since they do not depend on membership.
  const [rawView, scope] = await Promise.all([loadActionCenter(), loadMasterScope()]);
  const view = scopeActionCenterView(rawView, (id) => scope.ids.has(id), scope.ok);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">مركز الإجراءات</h1>
        <p className="text-sm text-muted">
          مركز موحّد للقراءة فقط يجمع كل ما يحتاج لمراجعة المالك من مراكز العمليات وطبقة التحليلات المعتمدة.
          لا يوجد تنفيذ أو أتمتة في هذه المرحلة — كل عنصر يفتح سير العمل الأصلي للمراجعة. المصادر غير المتوفّرة تظهر بوضوح
          ولا تُختلق أرقامها. كل الأرقام هنا تُحسب بـ<strong>الإجراءات</strong> وليس بعدد المنتجات؛ المنتج الواحد قد يرفع
          أكثر من إجراء، وبعض الإجراءات عامة على مستوى النظام ولا ترتبط بمنتج. الإجراءات المرتبطة بمنتج تقتصر على كتالوج
          سنونو الحالي، أمّا النتائج العامة فتظهر كما هي.
        </p>
      </header>

      <ActionCenter view={view} showSummary initialLane={initialLane} />

      <Suspense fallback={<SectionSkeleton />}>
        <ProductQueues />
      </Suspense>
    </div>
  );
}
