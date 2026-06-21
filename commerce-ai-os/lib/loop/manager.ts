// Manager orchestration (malika-loop-state-spec.md §4 + §6 briefing).
//
// The manager runs on a heartbeat. Each cycle it reads loop_board (already
// priority-sorted) and decides what to do with each loop. Pure functions here
// so they're trivially testable; the DB view (loop_board) mirrors sortBoard().

import type { LoopBoardRow, LoopClient, LoopStatus } from "./types";

/** Priority used by the loop_board ORDER BY. Lower = more urgent. */
const STATUS_PRIORITY: Record<LoopStatus, number> = {
  error: 0,
  blocked: 1,
  running: 2,
  idle: 3,
  done: 4,
};

function priority(status: LoopStatus): number {
  return STATUS_PRIORITY[status] ?? 4;
}

/** Reference ordering that matches the loop_board view:
 *  error -> blocked -> running -> idle, then updated_at desc. */
export function sortBoard<T extends Pick<LoopBoardRow, "status" | "updated_at">>(
  rows: T[]
): T[] {
  return [...rows].sort((a, b) => {
    const p = priority(a.status) - priority(b.status);
    if (p !== 0) return p;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
}

export type DispatchAction =
  | "escalate" // error -> fixer / #ESCALATE
  | "requeue" // blocked but unblock condition met
  | "hold" // blocked, still waiting
  | "dispatch" // idle + stale enough to run
  | "flag_stale" // running far too long -> suspected error (§9)
  | "skip"; // nothing to do this cycle

export interface DispatchDecision {
  loop_key: string;
  agent_key: string;
  action: DispatchAction;
  reason: string;
}

export interface DispatchContext {
  /** An idle loop older than this (ms) gets dispatched. */
  stalenessThresholdMs: number;
  /** A running loop older than this (ms) is flagged as suspected error. */
  runningStaleMs?: number;
  /** Per-loop predicate: has the blocking condition cleared? */
  isUnblocked?: (row: LoopBoardRow) => boolean;
  now?: () => Date;
}

/** Decide what the manager should do with a single board row (§4). */
export function decideDispatch(
  row: LoopBoardRow,
  ctx: DispatchContext
): DispatchDecision {
  const base = { loop_key: row.loop_key, agent_key: row.agent_key };
  switch (row.status) {
    case "error":
      return { ...base, action: "escalate", reason: "status=error" };
    case "blocked": {
      const unblocked = ctx.isUnblocked ? ctx.isUnblocked(row) : false;
      return unblocked
        ? { ...base, action: "requeue", reason: "unblock condition met" }
        : { ...base, action: "hold", reason: "still blocked" };
    }
    case "running": {
      if (ctx.runningStaleMs != null && row.staleness_ms > ctx.runningStaleMs) {
        return { ...base, action: "flag_stale", reason: "running too long" };
      }
      return { ...base, action: "skip", reason: "in progress" };
    }
    case "idle":
      return row.staleness_ms > ctx.stalenessThresholdMs
        ? { ...base, action: "dispatch", reason: "idle past staleness threshold" }
        : { ...base, action: "skip", reason: "idle but fresh" };
    default:
      return { ...base, action: "skip", reason: `status=${row.status}` };
  }
}

/** One manager cycle: sort the board, decide per loop. */
export function planCycle(
  board: LoopBoardRow[],
  ctx: DispatchContext
): DispatchDecision[] {
  return sortBoard(board).map((row) => decideDispatch(row, ctx));
}

/** Render the morning briefing from the board (§6). Deterministic text. */
export function renderBriefing(
  board: LoopBoardRow[],
  now: () => Date = () => new Date()
): string {
  const sorted = sortBoard(board);
  const stamp = now().toISOString();
  if (sorted.length === 0) {
    return `Malika AI — Morning Briefing (${stamp})\nNo active loops.`;
  }
  const counts = sorted.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const summary = (["error", "blocked", "running", "idle", "done"] as LoopStatus[])
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");
  const lines = sorted.map((r) => {
    const mins = Math.round(r.staleness_ms / 60000);
    const tail = r.next_action ? ` → next: ${r.next_action}` : "";
    return `• [${r.status.toUpperCase()}] ${r.loop_key} (${r.agent_key}, run ${r.run_count}, ${mins}m)${tail}`;
  });
  return [
    `Malika AI — Morning Briefing (${stamp})`,
    `Loops: ${sorted.length} (${summary})`,
    ...lines,
  ].join("\n");
}

/** Fetch the board through a LoopClient (thin wrapper for callers). */
export async function getBoard(client: LoopClient): Promise<LoopBoardRow[]> {
  return client.getBoard();
}
