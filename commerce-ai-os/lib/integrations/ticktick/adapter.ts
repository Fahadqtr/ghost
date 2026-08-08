// Malikas V2 — TickTick sync engine (Phase UI.7.5). One-way: Malikas → TickTick.
//
// This layer contains NO business rules and NO network code of its own: it
// orchestrates an INJECTED TickTickClient using the pure mapper. Because the
// client is injected, the whole diff/create/update/complete logic is unit-tested
// with a fake client and never touches the network.
//
// Malikas is the Single Source of Truth:
//  - tasks are the engine-computed OperationTasks (carried on TaskViewItem);
//  - identity is the deterministic OperationTask.id (embedded as a marker), so
//    re-running sync N times never creates duplicates;
//  - a task that is still present in Malikas is create/update — NEVER treated as
//    done just because TickTick says so;
//  - a task whose reason disappeared from Malikas is completed in TickTick;
//  - tasks WITHOUT a Malikas marker (manual/personal) are never touched.

import type { TaskViewItem } from "@/lib/operations/tasks-view";
import type {
  TickTickClient,
  TickTickProjectKey,
  TickTickProjectMap,
  TickTickSyncItemResult,
  TickTickSyncReport,
  TickTickTaskRecord,
} from "./types";
import type { MappedTask } from "./mapper";

/** The PURE helpers this engine uses. Injected (with a lazy default) so the
 *  adapter's static imports stay type-only and it loads directly under node:test
 *  — mirroring how read-model injects its engines. */
export interface TickTickSyncHelpers {
  mapTaskToPayload: (item: TaskViewItem, opts: { projectMap: TickTickProjectMap; baseUrl?: string }) => MappedTask;
  parseMarker: (content: string | null | undefined) => string | null;
  summarizeContent: (content: string | null | undefined, max?: number) => string;
  toSafeMessage: (err: unknown) => string;
}

async function defaultHelpers(): Promise<TickTickSyncHelpers> {
  const [m, e] = await Promise.all([import("./mapper"), import("./errors")]);
  return {
    mapTaskToPayload: m.mapTaskToPayload,
    parseMarker: m.parseMarker,
    summarizeContent: m.summarizeContent,
    toSafeMessage: e.toSafeMessage,
  };
}

export interface SyncDeps {
  client: TickTickClient;
  projectMap: TickTickProjectMap;
  baseUrl?: string;
  /** injected in tests; lazily bound to the real pure helpers in production */
  helpers?: TickTickSyncHelpers;
  /**
   * When false, the completion sweep (step 3) is skipped: the sync creates/updates
   * ONLY the given items and never completes any other Malikas-owned task. Used by
   * the safe single-task sync so pushing one task can't touch the rest. Defaults to
   * true (the full sync completes tasks whose reason disappeared from Malikas).
   */
  completeMissing?: boolean;
}

export interface SyncOutcome {
  report: TickTickSyncReport;
  /** per-item records, in order — consumed by the TickTick timeline provider */
  records: TickTickSyncItemResult[];
}

const UNCONFIGURED = "القائمة غير مُهيأة في TickTick.";

/** productId is the LAST colon-segment of the OperationTask id
 *  (`<type>[:platform]:<productId>`). */
function productIdFromMarker(marker: string): string {
  const i = marker.lastIndexOf(":");
  return i >= 0 ? marker.slice(i + 1) : marker;
}

function uniqueProjectIds(map: TickTickProjectMap): string[] {
  const out = new Set<string>();
  for (const v of Object.values(map)) {
    if (typeof v === "string" && v.trim() !== "") out.add(v);
  }
  return [...out];
}

function tally(records: readonly TickTickSyncItemResult[]): TickTickSyncReport {
  const r: TickTickSyncReport = { created: 0, updated: 0, completed: 0, skipped: 0, failed: 0, items: [...records] };
  for (const it of records) r[it.action]++;
  return r;
}

/**
 * Sync the given Malikas task-view items into TickTick. Returns a structured
 * report; it NEVER throws (a total read failure degrades to all-failed so the
 * caller — and Malikas — keep working). No task is deleted; foreign tasks are
 * never touched.
 */
export async function syncOperationsTasksToTickTick(
  items: readonly TaskViewItem[],
  deps: SyncDeps,
): Promise<SyncOutcome> {
  const records: TickTickSyncItemResult[] = [];
  const { mapTaskToPayload, parseMarker, toSafeMessage } = deps.helpers ?? (await defaultHelpers());

  // 1. Read the Malikas-OWNED tasks already in the configured projects. If this
  //    read fails we must NOT create blindly (that would risk duplicates), so we
  //    degrade to all-failed and return.
  const scanIds = uniqueProjectIds(deps.projectMap);
  let existing: TickTickTaskRecord[] = [];
  if (scanIds.length > 0) {
    try {
      existing = await deps.client.listProjectTasks(scanIds);
    } catch (e) {
      const detail = toSafeMessage(e);
      for (const item of items) {
        records.push({ operationTaskId: item.task.id, productId: item.productId, action: "failed", detail });
      }
      return { report: tally(records), records };
    }
  }

  // Only tasks carrying our marker are ours. Manual/personal tasks are ignored.
  const owned = new Map<string, TickTickTaskRecord>();
  for (const rec of existing) {
    const marker = parseMarker(rec.content);
    if (marker) owned.set(marker, rec);
  }

  // 2. Create missing / update existing, for every current Malikas task.
  const desired = new Set<string>();
  for (const item of items) {
    const opId = item.task.id;
    desired.add(opId);
    const mapped = mapTaskToPayload(item, { projectMap: deps.projectMap, baseUrl: deps.baseUrl });
    if (!mapped.projectId) {
      records.push({ operationTaskId: opId, productId: item.productId, action: "skipped", detail: UNCONFIGURED });
      continue;
    }
    const existingRec = owned.get(opId);
    try {
      if (existingRec) {
        const rec = await deps.client.updateTask({
          ...mapped.payload,
          id: existingRec.id,
          projectId: existingRec.projectId ?? mapped.projectId,
        });
        records.push({
          operationTaskId: opId, productId: item.productId, action: "updated",
          ticktickTaskId: rec.id, projectId: rec.projectId ?? existingRec.projectId, at: rec.modifiedTime ?? null,
        });
      } else {
        const rec = await deps.client.createTask(mapped.payload);
        records.push({
          operationTaskId: opId, productId: item.productId, action: "created",
          ticktickTaskId: rec.id, projectId: rec.projectId ?? mapped.projectId, at: rec.modifiedTime ?? null,
        });
      }
    } catch (e) {
      records.push({ operationTaskId: opId, productId: item.productId, action: "failed", detail: toSafeMessage(e) });
    }
  }

  // 3. Complete Malikas-owned TickTick tasks whose reason disappeared from
  //    Malikas (not in the desired set). Already-completed (status 2) are left
  //    alone; foreign tasks are absent from `owned`, so never touched. Skipped
  //    entirely for a scoped single-task sync (completeMissing === false), so
  //    pushing one task can never complete the rest.
  if (deps.completeMissing !== false) {
    for (const [marker, rec] of owned) {
      if (desired.has(marker)) continue;
      if (rec.status === 2) continue;
      if (!rec.projectId) continue;
      try {
        await deps.client.completeTask(rec.projectId, rec.id);
        records.push({
          operationTaskId: marker, productId: productIdFromMarker(marker), action: "completed",
          ticktickTaskId: rec.id, projectId: rec.projectId, at: rec.completedTime ?? null,
        });
      } catch (e) {
        records.push({ operationTaskId: marker, productId: productIdFromMarker(marker), action: "failed", detail: toSafeMessage(e) });
      }
    }
  }

  return { report: tally(records), records };
}

// ── dry-run planner (preview only — NEVER writes) ────────────────────────────

/** A verb-shaped PLAN action (present tense), distinct from the past-tense result
 *  actions, to make clear a plan is what WOULD happen — not what has happened. */
export type TickTickPlanAction = "create" | "update" | "skip";

export interface TickTickPlanItem {
  /** the deterministic Malikas OperationTask id (also the TickTick marker) */
  operationTaskId: string;
  productId: string;
  action: TickTickPlanAction;
  projectKey: TickTickProjectKey;
  /** resolved TickTick list id, or undefined when the list is unconfigured */
  projectId?: string;
  /** the exact title that WOULD be written */
  title: string;
  /** a short, human-readable summary of the description body (marker removed) */
  descriptionSummary: string;
  /** the deterministic identity that WOULD be embedded in the task content */
  marker: string;
}

export interface PreviewOutcome {
  ok: boolean;
  items: TickTickPlanItem[];
  /** fixed Arabic message when the pre-read failed (create/update can't be decided) */
  error?: string;
}

/**
 * DRY RUN: build the plan for the given items WITHOUT writing anything. It reads
 * the existing tasks (read-only) to decide create-vs-update, then reports what a
 * real sync WOULD do. It NEVER calls createTask / updateTask / completeTask, so a
 * preview cannot create, update or complete any TickTick task. The mapping is the
 * SAME one the real sync uses (via the shared pure mapper), so the plan is exact.
 */
export async function previewOperationTaskSync(
  items: readonly TaskViewItem[],
  deps: SyncDeps,
): Promise<PreviewOutcome> {
  const { mapTaskToPayload, parseMarker, summarizeContent, toSafeMessage } =
    deps.helpers ?? (await defaultHelpers());

  // Read-only: decide create vs update by matching our marker. No write happens.
  const scanIds = uniqueProjectIds(deps.projectMap);
  let existing: TickTickTaskRecord[] = [];
  if (scanIds.length > 0) {
    try {
      existing = await deps.client.listProjectTasks(scanIds);
    } catch (e) {
      return { ok: false, items: [], error: toSafeMessage(e) };
    }
  }
  const owned = new Set<string>();
  for (const rec of existing) {
    const marker = parseMarker(rec.content);
    if (marker) owned.add(marker);
  }

  const plans: TickTickPlanItem[] = [];
  for (const item of items) {
    const opId = item.task.id;
    const mapped = mapTaskToPayload(item, { projectMap: deps.projectMap, baseUrl: deps.baseUrl });
    const action: TickTickPlanAction = !mapped.projectId ? "skip" : owned.has(opId) ? "update" : "create";
    plans.push({
      operationTaskId: opId,
      productId: item.productId,
      action,
      projectKey: mapped.projectKey,
      projectId: mapped.projectId,
      title: mapped.payload.title,
      descriptionSummary: summarizeContent(mapped.payload.content),
      marker: parseMarker(mapped.payload.content) ?? opId,
    });
  }
  return { ok: true, items: plans };
}
