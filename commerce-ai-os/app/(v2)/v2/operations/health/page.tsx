// /v2/operations/health — Platform Health Center (OPS.6).
//
// Server Component. Read-only cross-cutting diagnostics: it composes ONE aggregated
// operations read + bounded head counts (via loadHealthCenter) into nine domain
// health states + a deterministic overall state + actionable findings that
// deep-link to the existing workflows. Nothing is written on render. Read access
// follows the existing signed-in policy (enforced in the reader). Data loading is
// isolated in try/catch so any failure shows one constant Arabic message.

import { loadHealthCenter } from "@/lib/operations/health/health-center.server";
import { parseHealthFilters, filterFindings } from "@/lib/operations/health/health-center";
import PlatformHealthCenter from "@/components/v2/operations/PlatformHealthCenter";
import { loadCatalogHealthDistribution } from "@/lib/catalog/health/health-distribution.server";
import CatalogHealthDistribution from "@/components/v2/operations/CatalogHealthDistribution";
import { loadEvidenceOverview } from "@/lib/catalog/evidence/evidence-overview.server";
import EvidenceOverview from "@/components/v2/operations/EvidenceOverview";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذّر تحميل مركز الصحة.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PlatformHealthPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = parseHealthFilters(params);

  const view = await loadHealthCenter();

  if ("error" in view) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {LOAD_ERROR}
      </div>
    );
  }

  const findings = filterFindings(view.model.findings, filters);

  // CAT.1A — read-only catalog health distribution (best-effort; a failure
  // simply omits the panel — it never blocks the page and never writes).
  let catalogHealth = null;
  try {
    catalogHealth = await loadCatalogHealthDistribution();
  } catch {
    catalogHealth = null;
  }

  // CAT.1B — read-only unified evidence overview (best-effort; never blocks/writes).
  let evidenceOverview = null;
  try {
    evidenceOverview = await loadEvidenceOverview();
  } catch {
    evidenceOverview = null;
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">مركز صحة المنصّة</h1>
        <p className="text-sm text-muted">
          نظرة موحّدة للقراءة فقط على صحة كل المجالات: الكتالوج، المخزون، التوفّر، القنوات، الذكاء، الوسائط، الهوية،
          الأمان، والنظام. حالات محسوبة بقواعد صريحة (لا درجات ذكاء غامضة)، مع بنود قابلة للتنفيذ توجّه إلى مسارات العمل
          المعتمدة. لا تُجري هذه اللوحة أي تعديل.
        </p>
      </header>
      <PlatformHealthCenter model={view.model} findings={findings} filters={filters} degraded={view.degraded} />
      {catalogHealth ? <CatalogHealthDistribution dist={catalogHealth} /> : null}
      {evidenceOverview ? <EvidenceOverview overview={evidenceOverview} /> : null}
    </div>
  );
}
