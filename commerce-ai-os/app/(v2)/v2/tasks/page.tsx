// /v2/tasks — Malikas Smart Tasks (Phase UI.7.3). Read-only Server Component.
// Tasks are COMPUTED by lib/operations/* (never stored, never manually
// completed): the reader flattens the engine output, and everything — summary,
// filter, search, pagination — is done server-side. Only the current page (24
// tasks) + the summary reach the browser. Data loading is isolated in
// try/catch; on any failure it shows one constant Arabic message.

import { createClient } from "@/lib/supabase/server";
import { loadTasksView } from "@/lib/operations/read-model";
import { loadShopifyPresence } from "@/lib/operations/shopify-presence";
import { ticktickConfigured } from "@/lib/integrations/ticktick/client";
import { isOwner } from "@/lib/malak/authz";
import {
  parseTaskControls,
  selectTaskPage,
  sortTaskViews,
  filterTaskViews,
  searchTaskViews,
  summarizeTasks,
  type TaskControls,
  type TaskPage,
  type TaskSummary,
} from "@/lib/operations/tasks-view";
import SmartTasks from "@/components/v2/operations/SmartTasks";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل المهام.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Fixed Arabic banner for the manual-sync result (from the redirect param).
 *  Never reflects a raw error — only fixed text + integer counts. */
function ticktickNotice(
  params: Record<string, string | string[] | undefined>,
): { tone: "ok" | "error" | "info"; text: string } | null {
  const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const t = one(params.ticktick);
  if (t === "") return null;
  if (t === "denied") return { tone: "error", text: "مزامنة TickTick متاحة للمالك فقط." };
  if (t === "not_configured") return { tone: "info", text: "TickTick غير مربوط بعد — لم تُنفَّذ المزامنة." };
  if (t === "ok") {
    const num = (v: string | string[] | undefined) => Math.max(0, Number.parseInt(one(v), 10) || 0);
    return {
      tone: "ok",
      text: `تمت مزامنة TickTick — أُنشئت ${num(params.c)}، حُدّثت ${num(params.u)}، أُغلقت ${num(params.d)}، تُخطّيت ${num(params.s)}، فشلت ${num(params.f)}.`,
    };
  }
  return { tone: "error", text: "تعذّرت مزامنة TickTick." };
}

export default async function TasksPage({ searchParams }: { searchParams?: SearchParams }) {
  let loaded:
    | {
        controls: TaskControls; summary: TaskSummary; page: TaskPage; matchCount: number;
        partial: boolean; shopifyAvailable: boolean;
        ticktickConnected: boolean; canSync: boolean;
        notice: { tone: "ok" | "error" | "info"; text: string } | null;
      }
    | null = null;

  try {
    const params = searchParams ? await searchParams : {};
    const controls = parseTaskControls(params);
    const supabase = createClient();
    const result = await loadTasksView(supabase as never, { shopify: { loadShopifyPresence } });
    if (result.status === "ok") {
      const all = result.data.tasks;
      // summary over the WHOLE task set; matchCount over the active filter+search.
      const matched = searchTaskViews(filterTaskViews(sortTaskViews(all), controls.filter), controls.query);
      // TickTick is a best-effort surface: its config/owner checks NEVER block the
      // page. `canSync` only gates showing the owner-only manual sync button.
      const ticktickConnected = ticktickConfigured();
      const canSync = ticktickConnected && (await isOwner());
      loaded = {
        controls,
        summary: summarizeTasks(all),
        page: selectTaskPage(all, controls),
        matchCount: matched.length,
        partial: result.data.partial,
        shopifyAvailable: result.data.shopifyAvailable,
        ticktickConnected,
        canSync,
        notice: ticktickNotice(params),
      };
    }
  } catch {
    loaded = null;
  }

  if (loaded === null) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {LOAD_ERROR}
      </div>
    );
  }

  return (
    <SmartTasks
      summary={loaded.summary}
      page={loaded.page}
      matchCount={loaded.matchCount}
      controls={loaded.controls}
      partial={loaded.partial}
      shopifyAvailable={loaded.shopifyAvailable}
      ticktickConnected={loaded.ticktickConnected}
      canSync={loaded.canSync}
      ticktickNotice={loaded.notice}
    />
  );
}
