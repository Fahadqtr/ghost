// Malikas V2 — TickTick integration types (Phase UI.7.5). TYPES ONLY (no runtime
// code) so the pure layers can `import type` from here and stay node-loadable.
//
// Malikas is the Single Source of Truth. TickTick is an execution/notification
// surface only: these types describe the SHAPE of what we send to / read from
// the TickTick Open API and the result of a one-way (Malikas → TickTick) sync.

// ── TickTick Open API shapes (the subset we use) ─────────────────────────────

/** TickTick task priority: 0 none, 1 low, 3 medium, 5 high. */
export type TickTickPriority = 0 | 1 | 3 | 5;

/** A task payload we SEND to TickTick (create when no id, update when id set). */
export interface TickTickTaskPayload {
  /** present only on update */
  id?: string;
  /** omitted → TickTick Inbox (we avoid this by requiring a configured project) */
  projectId?: string;
  title: string;
  /** description body — carries the Malikas fields + the deterministic marker */
  content: string;
  priority: TickTickPriority;
}

/** A task RECORD as returned by the API / project-data read (fields we read). */
export interface TickTickTaskRecord {
  id: string;
  projectId?: string;
  title?: string;
  content?: string;
  /** 0 = normal/open, 2 = completed (TickTick convention) */
  status?: number;
  priority?: number;
  /** ISO strings when TickTick provides them — used as TRUSTED timeline times */
  modifiedTime?: string;
  completedTime?: string;
}

// ── project routing ──────────────────────────────────────────────────────────

/** The logical TickTick lists a task can route to. */
export type TickTickProjectKey =
  | "photos"
  | "review"
  | "new_products"
  | "shopify"
  | "puresoul"
  | "talabat"
  | "rafeeq";

/** projectKey → TickTick project id (from env; never hard-coded). A key with no
 *  configured id is intentionally absent — its tasks are SKIPPED, never dropped
 *  into the Inbox (which would risk duplicates on the next sync). */
export type TickTickProjectMap = Partial<Record<TickTickProjectKey, string>>;

// ── sync results ─────────────────────────────────────────────────────────────

export type TickTickSyncAction = "created" | "updated" | "completed" | "skipped" | "failed";

export interface TickTickSyncItemResult {
  /** the deterministic Malikas OperationTask id (also the TickTick marker) */
  operationTaskId: string;
  productId: string;
  action: TickTickSyncAction;
  ticktickTaskId?: string;
  projectId?: string;
  /** a TRUSTED timestamp from the API (else null → timeline atKnown=false) */
  at?: string | null;
  /** fixed Arabic reason for skipped/failed — never a raw API error/token */
  detail?: string;
}

export interface TickTickSyncReport {
  created: number;
  updated: number;
  completed: number;
  skipped: number;
  failed: number;
  items: TickTickSyncItemResult[];
}

/** The client capability surface the adapter depends on (injected). The real
 *  server-only client implements it; tests supply a fake — so the adapter's
 *  sync logic is fully unit-testable with NO network. */
export interface TickTickClient {
  /** Read the Malikas-owned tasks across the given projects (marker-filtered by
   *  the caller). Returns raw records; the adapter matches by marker. */
  listProjectTasks(projectIds: readonly string[]): Promise<TickTickTaskRecord[]>;
  createTask(payload: TickTickTaskPayload): Promise<TickTickTaskRecord>;
  updateTask(payload: TickTickTaskPayload & { id: string }): Promise<TickTickTaskRecord>;
  completeTask(projectId: string, taskId: string): Promise<void>;
}

export type TickTickConnState = "connected" | "not_connected" | "error";
