// INT.2A — /v2/export — Export Center dashboard (read-only Server Component).
// Loads the aggregated model once (reused readiness + ECL gap counts) and renders
// one card per canonical destination. On any failure it shows a single constant
// Arabic message — never a raw error.

import { loadExportCenter } from "@/lib/export/export-center.server";
import ExportCenter from "@/components/v2/export/ExportCenter";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذّر تحميل مركز التصدير.";

export default async function ExportCenterPage() {
  const res = await loadExportCenter();
  if ("error" in res) {
    return (
      <div className="space-y-4">
        <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700">{LOAD_ERROR}</div>
      </div>
    );
  }
  return <ExportCenter model={res.model} />;
}
