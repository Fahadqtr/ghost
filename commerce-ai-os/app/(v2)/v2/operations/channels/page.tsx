// /v2/operations/channels — Channel Command Center (OPS.3).
//
// Server Component. Read-only. It loads ONE aggregated read (the same
// loadOperationsDashboard the main operations page performs — no per-card scan),
// composes the storefront-first command-center model via the pure composer, and
// renders it. Nothing is written on render: every mutation is delegated to an
// existing writer-gated workflow by link. Read access follows the existing
// signed-in policy (enforced inside the reader). Data loading is isolated in
// try/catch so any failure shows one constant Arabic message — never a raw error.

import { loadChannelCenter } from "@/lib/operations/channels/channel-center.server";
import { parseChannelFilters } from "@/lib/operations/channels/channel-center";
import { parseActivityFilters } from "@/lib/operations/channels/activity";
import ChannelCommandCenter from "@/components/v2/operations/ChannelCommandCenter";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذّر تحميل مركز القنوات.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ChannelCommandCenterPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const q = typeof params.q === "string" ? params.q : null;
  const filters = parseChannelFilters(params);
  const activityFilters = parseActivityFilters(params);

  const view = await loadChannelCenter({ query: q, filters, activityFilters });

  if ("error" in view) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {LOAD_ERROR}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">مركز قيادة القنوات</h1>
        <p className="text-sm text-muted">
          مكان واحد لمراقبة وتشغيل كل الواجهات — Shopify وSnoonu (مالكاز وبيور سيول منفصلتان) وTalabat وRafeeq. كل الأرقام
          مشتقّة من قراءة مجمّعة واحدة، وكل إجراء يمرّ عبر مسار العمل المعتمد فقط: هذه اللوحة للقراءة فقط ولا تُجري أي تعديل.
        </p>
      </header>
      <ChannelCommandCenter
        model={view.model}
        filtered={view.filtered}
        filters={view.filters}
        search={view.search}
        activity={view.activity}
        activityFilters={view.activityFilters}
        degraded={view.degraded}
      />
    </div>
  );
}
