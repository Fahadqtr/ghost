// /v2/tasks — Malikas Smart Tasks (Phase UI.7.3). Read-only Server Component.
// Tasks are COMPUTED by lib/operations/* (never stored, never manually
// completed): the reader flattens the engine output, and everything — summary,
// filter, search, pagination — is done server-side. Only the current page (24
// tasks) + the summary reach the browser. Data loading is isolated in
// try/catch; on any failure it shows one constant Arabic message.

import { createClient } from "@/lib/supabase/server";
import { loadTasksView } from "@/lib/operations/read-model";
import { loadMasterScope } from "@/lib/home/master-scope.server";
import { scopeRows } from "@/lib/home/master-scope";
import { loadShopifyPresence } from "@/lib/operations/shopify-presence";
import { ticktickConfigured, projectMapFromEnv, appBaseUrl } from "@/lib/integrations/ticktick/client";
import {
  mapTaskToPayload,
  projectKeyFor,
  resolveProjectId,
  parseMarker,
  summarizeContent,
} from "@/lib/integrations/ticktick/mapper";
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

/** The dry-run plan surfaced back on the previewed card (owner + connected only).
 *  Deterministically re-derived from the same pure mapper the real sync uses. */
type TickTickPreview = {
  operationTaskId: string;
  action: "create" | "update" | "skip";
  projectKey: string;
  title: string;
  descriptionSummary: string;
  marker: string;
};

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();
}

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
  if (t === "notfound") return { tone: "error", text: "لم يتم العثور على المهمة." };
  if (t === "preview_error") return { tone: "error", text: "تعذّرت معاينة TickTick." };
  if (t === "task_ok") return { tone: "ok", text: "تمت مزامنة هذه المهمة مع TickTick." };
  if (t === "task_unconfigured") return { tone: "info", text: "قائمة TickTick لهذه المهمة غير مهيأة." };
  if (t === "task_error") return { tone: "error", text: "تعذّرت مزامنة هذه المهمة." };
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
        ticktickCards: Record<string, { configured: boolean }>;
        preview: TickTickPreview | null;
        notice: { tone: "ok" | "error" | "info"; text: string } | null;
      }
    | null = null;

  try {
    const params = searchParams ? await searchParams : {};
    const controls = parseTaskControls(params);
    const supabase = createClient();
    const result = await loadTasksView(supabase as never, { shopify: { loadShopifyPresence } });
    if (result.status === "ok") {
      // CURRENT MASTER scope. Every task here is product-derived: flattenTasks
      // emits one row per (product, task) with the canonical `productId`, so
      // there is no entity-less task to preserve. The summary, the filtered
      // match count and the current page all read this ONE array.
      //
      // Fails CLOSED: an unreadable membership shows the page's error state
      // rather than the whole catalog's tasks.
      const scope = await loadMasterScope();
      if (!scope.ok) throw new Error("master_scope_unavailable");
      const all = scopeRows(result.data.tasks, (t) => t.productId, scope);
      // summary over the WHOLE task set; matchCount over the active filter+search.
      const matched = searchTaskViews(filterTaskViews(sortTaskViews(all), controls.filter), controls.query);
      // TickTick is a best-effort surface: its config/owner checks NEVER block the
      // page. `canSync` only gates showing the owner-only manual sync button.
      const ticktickConnected = ticktickConfigured();
      const canSync = ticktickConnected && (await isOwner());
      const page = selectTaskPage(all, controls);

      // Per-card TickTick info (owner + connected only): whether THIS task's list
      // is configured. A card whose list is missing shows a fixed notice instead
      // of the buttons. Plus the dry-run plan for the previewed card, if any.
      const ticktickCards: Record<string, { configured: boolean }> = {};
      let preview: TickTickPreview | null = null;
      if (canSync) {
        const projectMap = projectMapFromEnv();
        const baseUrl = appBaseUrl();
        for (const item of page.items) {
          ticktickCards[item.task.id] = {
            configured: resolveProjectId(projectKeyFor(item.task), projectMap) !== undefined,
          };
        }
        const planId = one(params.ttplan);
        const planAction = one(params.pa);
        if (planId && (planAction === "create" || planAction === "update" || planAction === "skip")) {
          const item = all.find((t) => t.task.id === planId);
          if (item) {
            const mapped = mapTaskToPayload(item, { projectMap, baseUrl });
            preview = {
              operationTaskId: planId,
              action: planAction,
              projectKey: mapped.projectKey,
              title: mapped.payload.title,
              descriptionSummary: summarizeContent(mapped.payload.content),
              marker: parseMarker(mapped.payload.content) ?? planId,
            };
          }
        }
      }

      loaded = {
        controls,
        summary: summarizeTasks(all),
        page,
        matchCount: matched.length,
        partial: result.data.partial,
        shopifyAvailable: result.data.shopifyAvailable,
        ticktickConnected,
        canSync,
        ticktickCards,
        preview,
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
      ticktickCards={loaded.ticktickCards}
      preview={loaded.preview}
      ticktickNotice={loaded.notice}
    />
  );
}
