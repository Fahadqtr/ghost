// Types for the Live Memory Layer (loop_state / loop_log / loop_board).
// Mirrors malika-loop-state-spec.md §2. These describe the DB shapes and the
// agent work contract; the SQL in supabase/loop_state_layer.sql is the source
// of truth for the schema.

/** Allowed loop_state.status values (matches the CHECK constraint). */
export const LOOP_STATUSES = [
  "idle",
  "running",
  "blocked",
  "done",
  "error",
] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

/** loop_log.event values (spec §2.2). */
export type LoopEvent =
  | "started"
  | "completed"
  | "blocked"
  | "handoff"
  | "error";

/** A full loop_state row. */
export interface LoopState {
  id: number;
  agent_key: string;
  loop_key: string;
  status: LoopStatus;
  goal: string | null;
  last_task: string | null;
  last_result: string | null;
  next_action: string | null;
  context: Record<string, unknown>;
  run_count: number;
  updated_at: string; // ISO timestamptz
}

/** Fields written on an upsert (id/updated_at are managed by the helper/DB). */
export interface LoopStateUpsert {
  agent_key: string;
  loop_key: string;
  status: LoopStatus;
  goal?: string | null;
  last_task?: string | null;
  last_result?: string | null;
  next_action?: string | null;
  context?: Record<string, unknown>;
  run_count: number;
  updated_at: string;
}

/** A loop_log insert. */
export interface LoopLogInsert {
  agent_key: string;
  loop_key: string;
  event: LoopEvent;
  detail?: string | null;
  payload?: Record<string, unknown>;
  run_id?: string | null;
}

/** A row from the loop_board view. */
export interface LoopBoardRow {
  loop_key: string;
  agent_key: string;
  status: LoopStatus;
  goal: string | null;
  next_action: string | null;
  run_count: number;
  updated_at: string;
  /** ms since updated_at (the view returns an interval; we expose it as ms). */
  staleness_ms: number;
}

/** What an agent's doWork() must return — written straight into loop_state
 *  (spec §5). Never invent data; return status='blocked' when unverifiable. */
export interface WorkResult {
  status: LoopStatus;
  task: string;
  summary: string;
  next: string;
  new_context: Record<string, unknown>;
}

/** Carried-over inputs handed to doWork() before it acts (spec §3 ACT step). */
export interface WorkInput {
  goal: string | null;
  context: Record<string, unknown>;
  resume: string | null; // = prior next_action
}

/** Uniform result wrapper from the persistence layer. */
export interface OpResult<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** Storage abstraction over Supabase so the helper is testable without a DB.
 *  Real implementation: lib/loop/supabaseLoopClient.ts. Note: there is no
 *  update/delete for logs — loop_log is append-only by design. */
export interface LoopClient {
  getState(agentKey: string, loopKey: string): Promise<LoopState | null>;
  upsertState(row: LoopStateUpsert): Promise<OpResult<LoopState>>;
  insertLog(ev: LoopLogInsert): Promise<OpResult>;
  getBoard(): Promise<LoopBoardRow[]>;
}
