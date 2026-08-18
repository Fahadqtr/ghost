// /v2/catalog/launch — Launch Campaign Workspace (WAVE.1A). Read-only Server
// Component: the team's working screen during the Catalog Completion Campaign.
// It composes ONLY certified read models (HOME.2 Launch Readiness + the certified
// Operations readiness reasons) through a single shared workspace read-model — no
// new business logic, no completion rules, no writes. Each work-queue row deep-
// links to the EXISTING product editor. Auth is enforced by the (v2) layout.

import { loadLaunchWorkspace } from "@/lib/catalog/launch/launch-workspace.server";
import LaunchWorkspace from "@/components/v2/catalog/LaunchWorkspace";
import Link from "next/link";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذّر تحميل مساحة عمل الحملة.";

export default async function LaunchCampaignPage() {
  let model: Awaited<ReturnType<typeof loadLaunchWorkspace>> | null = null;
  try {
    model = await loadLaunchWorkspace();
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/v2" className="text-xs text-brand hover:underline">← الرئيسية</Link>
          <h1 className="text-lg font-bold text-ink">مساحة عمل حملة الإطلاق</h1>
        </div>
        <Link href="/v2/export" className="text-xs font-semibold text-brand hover:underline" dir="ltr">مركز التصدير →</Link>
      </div>
      <LaunchWorkspace model={model} />
    </div>
  );
}
