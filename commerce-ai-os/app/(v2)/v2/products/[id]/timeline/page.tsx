// /v2/products/[id]/timeline — Malikas Product Timeline (Phase UI.7.4).
// Read-only Server Component. Activity events are COMPUTED by
// lib/operations/timeline/* (never stored): the reader loads ONE product via
// the session client and the engine derives the events; filter/search are done
// server-side. Data loading is isolated in try/catch; JSX is built only
// afterwards. On failure it shows one constant Arabic message, and on a
// missing/invalid id a single constant not-found message — never the requested
// id, a raw error, stack, table/column name, or JSON.

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadProductTimeline } from "@/lib/operations/read-model";
import {
  parseTimelineControls,
  selectTimelineEvents,
  summarizeTimeline,
  type TimelineControls,
  type TimelineSummary,
} from "@/lib/operations/timeline/timeline-view";
import { parseProductId } from "@/lib/catalog-v2/master-catalog-view";
import type { TimelineEvent } from "@/lib/operations/shared/models";
import ProductTimeline from "@/components/v2/operations/ProductTimeline";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل سجل النشاط.";
const NOT_FOUND = "لا يوجد منتج بهذا المعرّف.";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProductTimelinePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: SearchParams;
}) {
  let state:
    | {
        kind: "ok";
        productId: string;
        productName: string;
        events: TimelineEvent[];
        summary: TimelineSummary;
        controls: TimelineControls;
        matchCount: number;
      }
    | { kind: "notfound" }
    | { kind: "error" } = { kind: "error" };

  try {
    const sp = searchParams ? await searchParams : {};
    const controls = parseTimelineControls(sp);
    const { id } = await params;
    const validId = parseProductId(id);
    if (validId === null) {
      state = { kind: "notfound" };
    } else {
      const supabase = createClient();
      const result = await loadProductTimeline(supabase as never, validId);
      if (result.status === "error") {
        state = { kind: "error" };
      } else if (result.status === "notfound") {
        state = { kind: "notfound" };
      } else {
        const all = result.timeline.events;
        const s = result.timeline.snapshot;
        const name = s.nameAr || s.nameEn || s.sku || "منتج بدون اسم";
        const matched = selectTimelineEvents(all, controls);
        state = {
          kind: "ok",
          productId: validId,
          productName: name,
          events: matched,
          summary: summarizeTimeline(all),
          controls,
          matchCount: matched.length,
        };
      }
    }
  } catch {
    state = { kind: "error" };
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-4">
        <Link href="/v2/catalog" className="btn-ghost">
          رجوع للكتالوج
        </Link>
        <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
          {LOAD_ERROR}
        </div>
      </div>
    );
  }

  if (state.kind === "notfound") {
    return (
      <div className="space-y-4">
        <Link href="/v2/catalog" className="btn-ghost">
          رجوع للكتالوج
        </Link>
        <div className="card text-center text-sm text-muted">{NOT_FOUND}</div>
      </div>
    );
  }

  return (
    <ProductTimeline
      productId={state.productId}
      productName={state.productName}
      backHref={`/v2/catalog/${encodeURIComponent(state.productId)}`}
      events={state.events}
      summary={state.summary}
      controls={state.controls}
      matchCount={state.matchCount}
    />
  );
}
