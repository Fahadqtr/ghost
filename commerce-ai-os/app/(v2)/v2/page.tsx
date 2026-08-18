// /v2 — the Executive Home Dashboard (HOME.1). The V2 entry point is now the
// daily operating center for Malika's Universe instead of a redirect to the
// catalog. Read-only Server Component: it composes ONLY existing certified read
// models (Action Center, Operations, CAT.1A–E, Export Center, AI Center, Rewards,
// Analytics, audit) via the shared home read-model — no new business rules, no
// queries of its own, no writes. Data loading is isolated in try/catch: on any
// failure it shows one constant Arabic message, never a raw error. Auth is
// already enforced once by the V2 route-group layout.

import { loadHomeDashboard } from "@/lib/home/home-dashboard.server";
import HomeDashboard from "@/components/v2/home/HomeDashboard";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذّر تحميل الصفحة الرئيسية.";

export default async function V2HomePage() {
  let model: Awaited<ReturnType<typeof loadHomeDashboard>> | null = null;
  try {
    model = await loadHomeDashboard();
  } catch {
    model = null;
  }

  if (model === null) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {LOAD_ERROR}
      </div>
    );
  }

  return <HomeDashboard model={model} />;
}
