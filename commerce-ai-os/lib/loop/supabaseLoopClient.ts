// Real LoopClient backed by Supabase (service-role, server only).
//
// This is the ONLY file in lib/loop that imports Supabase, so the helper and
// manager stay unit-testable without a DB. Agents run server-side, so we use
// the service-role admin client (bypasses RLS) from lib/supabase/admin.ts.

import { createAdminClient } from "../supabase/admin";
import type {
  LoopBoardRow,
  LoopClient,
  LoopLogInsert,
  LoopState,
  LoopStateUpsert,
  OpResult,
} from "./types";

/** Convert the loop_board view's `staleness` interval to milliseconds. */
function stalenessToMs(value: unknown, updatedAt: string): number {
  // PostgREST returns an interval as a string (e.g. "00:05:00" or
  // "1 day 02:03:04"). Rather than parse every interval shape, derive it from
  // updated_at against now — equivalent and robust.
  const t = new Date(updatedAt).getTime();
  if (!Number.isNaN(t)) return Math.max(0, Date.now() - t);
  // Fallback: best-effort parse of HH:MM:SS.
  if (typeof value === "string") {
    const m = value.match(/(\d+):(\d{2}):(\d{2})/);
    if (m) return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
  }
  return 0;
}

export function createSupabaseLoopClient(): LoopClient {
  const db = createAdminClient();

  return {
    async getState(agentKey, loopKey): Promise<LoopState | null> {
      const { data, error } = await db
        .from("loop_state")
        .select("*")
        .eq("agent_key", agentKey)
        .eq("loop_key", loopKey)
        .maybeSingle();
      if (error) throw new Error(`loop_state read failed: ${error.message}`);
      return (data as LoopState | null) ?? null;
    },

    async upsertState(row: LoopStateUpsert): Promise<OpResult<LoopState>> {
      const { data, error } = await db
        .from("loop_state")
        .upsert(row, { onConflict: "agent_key,loop_key" })
        .select("*")
        .single();
      if (error) return { ok: false, error: error.message };
      return { ok: true, data: data as LoopState };
    },

    async insertLog(ev: LoopLogInsert): Promise<OpResult> {
      const { error } = await db.from("loop_log").insert(ev);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    },

    async getBoard(): Promise<LoopBoardRow[]> {
      const { data, error } = await db.from("loop_board").select("*");
      if (error) throw new Error(`loop_board read failed: ${error.message}`);
      return (data ?? []).map((r: Record<string, unknown>) => ({
        loop_key: r.loop_key as string,
        agent_key: r.agent_key as string,
        status: r.status as LoopBoardRow["status"],
        goal: (r.goal as string | null) ?? null,
        next_action: (r.next_action as string | null) ?? null,
        run_count: (r.run_count as number) ?? 0,
        updated_at: r.updated_at as string,
        staleness_ms: stalenessToMs(r.staleness, r.updated_at as string),
      }));
    },
  };
}
