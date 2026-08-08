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
import { syncOperationsTasksToTickTick } from "@/lib/integrations/ticktick/adapter";

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
