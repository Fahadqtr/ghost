"use server";
// /v2/tasks server actions (Phase UI.7.5). Owner-only manual TickTick sync.
//
// This is a "use server" module: it exports ONLY async functions. TickTick is a
// one-way execution surface — Malikas stays the source of truth. The action is
// gated by requireOwner() (server-verified session, never a client value); when
// TickTick is not configured it degrades to a fixed Arabic notice. A TickTick
// failure NEVER affects Malikas — the action just reports it.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOwner } from "@/lib/malak/authz";
import { loadTasksView } from "@/lib/operations/read-model";
import { loadShopifyPresence } from "@/lib/operations/shopify-presence";
import {
  getTickTickClient,
  projectMapFromEnv,
  appBaseUrl,
  ticktickConfigured,
} from "@/lib/integrations/ticktick/client";
import { syncOperationsTasksToTickTick, previewOperationTaskSync } from "@/lib/integrations/ticktick/adapter";

/** Manually push the current Smart Tasks to TickTick (owner only). Redirects back
 *  to /v2/tasks with a fixed status the page renders as a banner. */
export async function syncTickTickAction(): Promise<void> {
  const owner = await requireOwner();
  if (!owner.ok) redirect("/v2/tasks?ticktick=denied");
  if (!ticktickConfigured()) redirect("/v2/tasks?ticktick=not_configured");

  // Build the redirect target inside the try (no redirect() here — its thrown
  // NEXT_REDIRECT must not be swallowed by the catch); redirect once at the end.
  let query = "/v2/tasks?ticktick=error";
  try {
    const supabase = createClient();
    const result = await loadTasksView(supabase as never, { shopify: { loadShopifyPresence } });
    if (result.status === "ok") {
      const { report } = await syncOperationsTasksToTickTick(result.data.tasks, {
        client: getTickTickClient(),
        projectMap: projectMapFromEnv(),
        baseUrl: appBaseUrl(),
      });
      const p = new URLSearchParams({
        ticktick: "ok",
        c: String(report.created),
        u: String(report.updated),
        d: String(report.completed),
        s: String(report.skipped),
        f: String(report.failed),
      });
      query = `/v2/tasks?${p.toString()}`;
    }
  } catch {
    query = "/v2/tasks?ticktick=error";
  }
  redirect(query);
}

/**
 * Safe single-task DRY RUN (owner only). Re-derives the ONE task from the
 * Operations Engine server-side (never trusts task data from the browser — only
 * the id is passed), then previews what a real sync WOULD do WITHOUT writing to
 * TickTick. Redirects back with the plan action so the card can reveal the sync
 * button; no title/description/project id ever comes from the client.
 */
export async function previewOneTickTickTask(operationTaskId: string): Promise<void> {
  const owner = await requireOwner();
  if (!owner.ok) redirect("/v2/tasks?ticktick=denied");
  if (!ticktickConfigured()) redirect("/v2/tasks?ticktick=not_configured");

  const id = String(operationTaskId ?? "").trim();
  let query = "/v2/tasks?ticktick=preview_error";
  try {
    const supabase = createClient();
    const result = await loadTasksView(supabase as never, { shopify: { loadShopifyPresence } });
    if (result.status === "ok") {
      // Server-side re-derivation: a forged / stale id simply isn't found.
      const item = result.data.tasks.find((t) => t.task.id === id);
      if (!item) {
        query = "/v2/tasks?ticktick=notfound";
      } else {
        const preview = await previewOperationTaskSync([item], {
          client: getTickTickClient(),
          projectMap: projectMapFromEnv(),
          baseUrl: appBaseUrl(),
        });
        const plan = preview.ok ? preview.items[0] : undefined;
        if (plan) {
          const p = new URLSearchParams({ ttplan: id, pa: plan.action });
          query = `/v2/tasks?${p.toString()}`;
        } else {
          query = "/v2/tasks?ticktick=preview_error";
        }
      }
    }
  } catch {
    query = "/v2/tasks?ticktick=preview_error";
  }
  redirect(query);
}

/**
 * Safe single-task REAL sync (owner only). Re-derives the ONE task from the
 * Operations Engine server-side (never trusts task data from the browser — only
 * the id is passed) and pushes exactly that one task through the SAME adapter with
 * completeMissing:false, so it creates/updates only that task and never completes
 * any other Malikas-owned task. Identity is deterministic, so repeating it updates
 * (never duplicates). A TickTick failure never affects Malikas.
 */
export async function syncOneTickTickTask(operationTaskId: string): Promise<void> {
  const owner = await requireOwner();
  if (!owner.ok) redirect("/v2/tasks?ticktick=denied");
  if (!ticktickConfigured()) redirect("/v2/tasks?ticktick=not_configured");

  const id = String(operationTaskId ?? "").trim();
  let query = "/v2/tasks?ticktick=task_error";
  try {
    const supabase = createClient();
    const result = await loadTasksView(supabase as never, { shopify: { loadShopifyPresence } });
    if (result.status === "ok") {
      const item = result.data.tasks.find((t) => t.task.id === id);
      if (!item) {
        query = "/v2/tasks?ticktick=notfound";
      } else {
        const { report } = await syncOperationsTasksToTickTick([item], {
          client: getTickTickClient(),
          projectMap: projectMapFromEnv(),
          baseUrl: appBaseUrl(),
          completeMissing: false, // scope to this one task — never sweep-complete others
        });
        if (report.created + report.updated + report.completed >= 1) query = "/v2/tasks?ticktick=task_ok";
        else if (report.skipped >= 1) query = "/v2/tasks?ticktick=task_unconfigured";
        else query = "/v2/tasks?ticktick=task_error";
      }
    }
  } catch {
    query = "/v2/tasks?ticktick=task_error";
  }
  redirect(query);
}
