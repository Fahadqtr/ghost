// /v2/operations/availability-sync — Snoonu Availability Sync (CH.6C).
//
// Server Component. Renders the operator surface. The apply is writer-gated inside
// the server action + orchestrator; here we only compute a UI affordance
// (canWrite) so a read-only user sees a disabled/locked Apply. Nothing is written
// on render — the page performs no scan/apply itself.

import { requireMalakWriter } from "@/lib/malak/authz";
import { resolveStorefront } from "@/lib/operations/channels/deep-link";
import AvailabilitySync from "@/components/v2/operations/AvailabilitySync";

export const dynamic = "force-dynamic";

// CH.6C is Snoonu-only — a deep-link storefront is honoured only for these two.
const SNOONU_STOREFRONTS = ["snoonu:pure_seoul", "snoonu:malikas"] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AvailabilitySyncPage({ searchParams }: { searchParams?: SearchParams }) {
  const writer = await requireMalakWriter();
  const canWrite = writer.ok;

  const params = searchParams ? await searchParams : {};
  const initialStorefront = resolveStorefront(params, SNOONU_STOREFRONTS) ?? undefined;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">مزامنة توفّر سنونو</h1>
        <p className="text-sm text-muted">
          مزامنة حالة التوفّر (متوفّر / غير متوفّر) من متاجر سنونو إلى محرّك التوفّر الداخلي.
          لا تُعدّل الكميات أو المخزون إطلاقًا — التوفّر فقط. المعاينة للقراءة، والتطبيق يمرّ حصريًا عبر محرّك التوفّر.
        </p>
      </header>
      <AvailabilitySync canWrite={canWrite} initialStorefront={initialStorefront} />
    </div>
  );
}
