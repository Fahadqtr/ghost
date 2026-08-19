// /v2/operations/media/discovery — Snoonu Media Discovery (MEDIA.1B/MEDIA.1A-P2).
// Read-only Server Component. Discovers media candidates for a product across the
// two Snoonu storefronts. With a provisioned session it performs live VERIFIED
// name-search reads (live-adapter.server.ts); otherwise it honestly reports
// SESSION_REQUIRED. It writes nothing. Auth is enforced by the (v2) layout.
// Accepts ?productId= or ?sku= (e.g. from the Launch Campaign workspace).

import { loadSnoonuDiscovery } from "@/lib/adapters/snoonu/merchant/discovery.server";
import { loadSnoonuConnectionStatuses } from "@/lib/adapters/snoonu/merchant/session-status.server";
import SnoonuDiscovery from "@/components/v2/operations/SnoonuDiscovery";
import SnoonuConnectionManager from "@/components/v2/operations/SnoonuConnectionManager";
import type { SnoonuSessionStatus } from "@/lib/adapters/snoonu/merchant/session-status";
import Link from "next/link";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذّر تحميل اكتشاف الوسائط.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === "string" ? v : null;
}

export default async function SnoonuDiscoveryPage({ searchParams }: { searchParams?: SearchParams }) {
  let view: Awaited<ReturnType<typeof loadSnoonuDiscovery>> | null = null;
  let statuses: SnoonuSessionStatus[] = [];
  try {
    const params = searchParams ? await searchParams : {};
    [view, statuses] = await Promise.all([
      loadSnoonuDiscovery({ productId: first(params.productId), sku: first(params.sku) }),
      loadSnoonuConnectionStatuses().catch(() => []),
    ]);
  } catch {
    view = null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/v2/operations/media" className="text-xs text-brand hover:underline">← مركز الصور</Link>
          <h1 className="text-lg font-bold text-ink">اكتشاف وسائط Snoonu</h1>
        </div>
        <Link href="/v2/catalog/launch" className="text-xs font-semibold text-brand hover:underline">حملة الإطلاق →</Link>
      </div>
      {statuses.length > 0 ? <SnoonuConnectionManager statuses={statuses} /> : null}
      {view === null ? (
        <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">{LOAD_ERROR}</div>
      ) : (
        <SnoonuDiscovery view={view} />
      )}
    </div>
  );
}
