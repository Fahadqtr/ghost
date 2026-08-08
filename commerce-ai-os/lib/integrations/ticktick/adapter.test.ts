// TickTick sync-engine tests (Phase UI.7.5). A FAKE client is injected — no
// network, no secrets. Run:
// node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/adapter.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { syncOperationsTasksToTickTick, previewOperationTaskSync, type SyncDeps } from "./adapter.ts";
import { buildContent, mapTaskToPayload, parseMarker, summarizeContent } from "./mapper.ts";
import { TickTickError, TICKTICK_ERRORS, toSafeMessage } from "./errors.ts";
import type { OperationTask } from "../../operations/shared/models.ts";
import type { TaskViewItem } from "../../operations/tasks-view.ts";
import type { TickTickClient, TickTickProjectMap, TickTickTaskRecord } from "./types.ts";

const MAP: TickTickProjectMap = { photos: "PJ_PHOTOS", review: "PJ_REVIEW", shopify: "PJ_SHOP" };

// The pure helpers are injected so the adapter loads directly under node:test.
const HELPERS: SyncDeps["helpers"] = { mapTaskToPayload, parseMarker, summarizeContent, toSafeMessage };
function deps(over: Partial<SyncDeps> & { client: SyncDeps["client"] }): SyncDeps {
  return { projectMap: MAP, helpers: HELPERS, ...over };
}

function mkTask(over: Partial<OperationTask> = {}): OperationTask {
  return {
    id: over.id ?? "needs_image:p1",
    productId: over.productId ?? "p1",
    type: over.type ?? "needs_image",
    priority: over.priority ?? "high",
    title: over.title ?? "إضافة صورة",
    description: over.description ?? "d",
    reason: over.reason ?? "لا توجد صورة.",
    ...(over.platform ? { platform: over.platform } : {}),
  };
}
function mkItem(over: Partial<TaskViewItem> & { task?: Partial<OperationTask> } = {}): TaskViewItem {
  const task = mkTask(over.task);
  return {
    task, productId: over.productId ?? task.productId,
    sku: over.sku ?? "MK1", barcode: over.barcode ?? "6291041500213",
    nameAr: over.nameAr ?? "اسم", nameEn: over.nameEn ?? "Name",
    imageUrl: over.imageUrl ?? null, readinessPercent: over.readinessPercent ?? 40,
  };
}

interface Calls { created: unknown[]; updated: unknown[]; completed: { projectId: string; taskId: string }[]; listed: number }
function fakeClient(existing: TickTickTaskRecord[], opts: {
  failList?: boolean; failCreate?: TickTickError | Error; failComplete?: Error;
} = {}): { client: TickTickClient; calls: Calls } {
  const calls: Calls = { created: [], updated: [], completed: [], listed: 0 };
  let seq = 0;
  const client: TickTickClient = {
    async listProjectTasks() {
      calls.listed++;
      if (opts.failList) throw new Error("network boom");
      return existing;
    },
    async createTask(p) {
      if (opts.failCreate) throw opts.failCreate;
      const rec: TickTickTaskRecord = { id: `tt${++seq}`, projectId: p.projectId, title: p.title, content: p.content, priority: p.priority, status: 0, modifiedTime: "2026-08-08T00:00:00.000Z" };
      calls.created.push(p);
      existing.push(rec); // subsequent syncs will find it (idempotency)
      return rec;
    },
    async updateTask(p) {
      calls.updated.push(p);
      return { id: p.id, projectId: p.projectId, content: p.content, status: 0, modifiedTime: "2026-08-08T01:00:00.000Z" };
    },
    async completeTask(projectId, taskId) {
      if (opts.failComplete) throw opts.failComplete;
      calls.completed.push({ projectId, taskId });
    },
  };
  return { client, calls };
}

/** An existing Malikas-owned TickTick record for a given OperationTask id. */
function owned(opId: string, projectId: string, status = 0): TickTickTaskRecord {
  return { id: `existing-${opId}`, projectId, status, content: buildContent(mkItem({ task: { id: opId } }), "https://x") };
}

// ── create / update ──────────────────────────────────────────────────────────

test("creates a task that does not yet exist", async () => {
  const { client, calls } = fakeClient([]);
  const { report } = await syncOperationsTasksToTickTick([mkItem()], deps({ client }));
  assert.equal(report.created, 1);
  assert.equal(report.updated, 0);
  assert.equal(calls.created.length, 1);
  assert.equal(report.items[0]!.action, "created");
  assert.equal(report.items[0]!.ticktickTaskId, "tt1");
});

test("updates a task that already exists (matched by marker)", async () => {
  const existing = [owned("needs_image:p1", "PJ_PHOTOS")];
  const { client, calls } = fakeClient(existing);
  const { report } = await syncOperationsTasksToTickTick([mkItem()], deps({ client }));
  assert.equal(report.updated, 1);
  assert.equal(report.created, 0);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated.length, 1);
});

test("repeated sync never creates duplicates (idempotent by marker)", async () => {
  const existing: TickTickTaskRecord[] = [];
  const { client, calls } = fakeClient(existing);
  for (let i = 0; i < 10; i++) {
    await syncOperationsTasksToTickTick([mkItem()], deps({ client }));
  }
  assert.equal(calls.created.length, 1, "created exactly once across 10 syncs");
  assert.equal(calls.updated.length, 9, "updated on every subsequent sync");
  assert.equal(existing.length, 1, "only one TickTick task exists");
});

// ── complete resolved ────────────────────────────────────────────────────────

test("completes a Malikas-owned task whose reason disappeared from Malikas", async () => {
  const existing = [owned("needs_image:p1", "PJ_PHOTOS")];
  const { client, calls } = fakeClient(existing);
  const { report } = await syncOperationsTasksToTickTick([], deps({ client }));
  assert.equal(report.completed, 1);
  assert.deepEqual(calls.completed, [{ projectId: "PJ_PHOTOS", taskId: "existing-needs_image:p1" }]);
});

test("an already-completed (status 2) owned task is left alone", async () => {
  const existing = [owned("needs_image:p1", "PJ_PHOTOS", 2)];
  const { client, calls } = fakeClient(existing);
  const { report } = await syncOperationsTasksToTickTick([], deps({ client }));
  assert.equal(report.completed, 0);
  assert.equal(calls.completed.length, 0);
});

// ── never touch foreign tasks ────────────────────────────────────────────────

test("never touches tasks that carry no Malikas marker (manual/personal)", async () => {
  const foreign: TickTickTaskRecord = { id: "manual1", projectId: "PJ_PHOTOS", status: 0, content: "شراء حليب" };
  const { client, calls } = fakeClient([foreign]);
  const { report } = await syncOperationsTasksToTickTick([mkItem()], deps({ client }));
  assert.equal(calls.completed.length, 0, "foreign task never completed");
  assert.equal(report.created, 1, "our task still created");
  assert.ok(!calls.updated.some((u) => (u as { id?: string }).id === "manual1"));
});

// ── Malikas is the source of truth ───────────────────────────────────────────

test("a Malikas task stays active (update, not complete) even if TickTick marked it done", async () => {
  // TickTick says done (status 2) but the underlying reason still exists in Malikas.
  const existing = [owned("needs_image:p1", "PJ_PHOTOS", 2)];
  const { client, calls } = fakeClient(existing);
  const { report } = await syncOperationsTasksToTickTick([mkItem()], deps({ client }));
  assert.equal(report.completed, 0, "Malikas task is NOT treated as done");
  assert.equal(report.updated, 1, "it is kept in sync as an active task");
  assert.equal(calls.completed.length, 0);
});

// ── degraded behavior ────────────────────────────────────────────────────────

test("a read failure degrades to all-failed and creates nothing (no dup risk)", async () => {
  const { client, calls } = fakeClient([], { failList: true });
  const { report } = await syncOperationsTasksToTickTick([mkItem(), mkItem({ task: { id: "needs_image:p2" }, productId: "p2" })], deps({ client }));
  assert.equal(report.failed, 2);
  assert.equal(report.created, 0);
  assert.equal(calls.created.length, 0);
});

test("a per-item API failure surfaces a FIXED Arabic message — never the raw error", async () => {
  const { client } = fakeClient([], { failCreate: new TickTickError("rate_limited") });
  const { report } = await syncOperationsTasksToTickTick([mkItem()], deps({ client }));
  assert.equal(report.failed, 1);
  assert.equal(report.items[0]!.action, "failed");
  assert.equal(report.items[0]!.detail, TICKTICK_ERRORS.rate_limited);
});

test("a raw (non-TickTickError) throw is normalized, never leaked", async () => {
  const { client } = fakeClient([], { failCreate: new Error("secret token abc123 leaked") });
  const { report } = await syncOperationsTasksToTickTick([mkItem()], deps({ client }));
  assert.equal(report.items[0]!.detail, TICKTICK_ERRORS.unknown);
  assert.ok(!String(report.items[0]!.detail).includes("abc123"));
});

// ── unconfigured project → skip (never Inbox) ────────────────────────────────

test("a task whose list is not configured is skipped, never sent to the Inbox", async () => {
  const { client, calls } = fakeClient([], {});
  const { report } = await syncOperationsTasksToTickTick([mkItem()], deps({ client, projectMap: {} }));
  assert.equal(report.skipped, 1);
  assert.equal(calls.created.length, 0);
  assert.equal(report.items[0]!.action, "skipped");
});

// ── dry-run preview (never writes) ───────────────────────────────────────────

test("preview NEVER calls create/update/complete (pure dry run)", async () => {
  const existing = [owned("needs_image:p1", "PJ_PHOTOS")];
  const { client, calls } = fakeClient(existing);
  const res = await previewOperationTaskSync([mkItem()], deps({ client }));
  assert.equal(res.ok, true);
  assert.equal(calls.created.length, 0, "no create call during a preview");
  assert.equal(calls.updated.length, 0, "no update call during a preview");
  assert.equal(calls.completed.length, 0, "no complete call during a preview");
  assert.equal(res.items[0]!.action, "update", "existing task → plan says update");
});

test("preview plans a create for a task with no existing TickTick task", async () => {
  const { client, calls } = fakeClient([]);
  const res = await previewOperationTaskSync([mkItem()], deps({ client }));
  assert.equal(res.items[0]!.action, "create");
  assert.equal(calls.created.length, 0);
  assert.ok(res.items[0]!.title.length > 0, "plan carries the exact title");
  assert.equal(res.items[0]!.marker, "needs_image:p1", "plan carries the deterministic marker");
  assert.equal(res.items[0]!.projectKey, "photos");
  assert.ok(!res.items[0]!.descriptionSummary.includes("[[malikas:"), "marker line stripped from the summary");
});

test("preview marks an unconfigured list as skip and reads/writes nothing", async () => {
  const { client, calls } = fakeClient([]);
  const res = await previewOperationTaskSync([mkItem()], deps({ client, projectMap: {} }));
  assert.equal(res.items[0]!.action, "skip");
  assert.equal(res.items[0]!.projectId, undefined);
  assert.equal(calls.listed, 0, "no configured lists → no read");
  assert.equal(calls.created.length, 0);
});

test("preview surfaces a FIXED message on a read failure — never a raw error", async () => {
  const { client } = fakeClient([], { failList: true });
  const res = await previewOperationTaskSync([mkItem()], deps({ client }));
  assert.equal(res.ok, false);
  assert.equal(res.items.length, 0);
  assert.equal(res.error, TICKTICK_ERRORS.unknown);
  assert.ok(!String(res.error).includes("boom"), "raw error text never leaks");
});

// ── single-task sync scoping (completeMissing:false) ─────────────────────────

test("single-task sync creates ONLY the given task and completes NO other owned task", async () => {
  // Another Malikas-owned task exists in TickTick and is NOT in the items list.
  const other = owned("needs_image:p2", "PJ_PHOTOS");
  const { client, calls } = fakeClient([other]);
  const { report } = await syncOperationsTasksToTickTick([mkItem()], deps({ client, completeMissing: false }));
  assert.equal(report.created, 1, "our one task is created");
  assert.equal(report.completed, 0, "the OTHER owned task is NOT completed");
  assert.equal(calls.completed.length, 0, "no completion call in a scoped single-task sync");
});

test("the full (default) sync still sweep-completes resolved tasks — opt-out is explicit", async () => {
  const other = owned("needs_image:p2", "PJ_PHOTOS");
  const { client, calls } = fakeClient([other]);
  const { report } = await syncOperationsTasksToTickTick([mkItem()], deps({ client }));
  assert.equal(report.created, 1);
  assert.equal(report.completed, 1, "p2 (absent from Malikas) is completed by the full sync");
  assert.equal(calls.completed.length, 1);
});

test("repeated single-task sync never duplicates (create once, then update)", async () => {
  const existing: TickTickTaskRecord[] = [];
  const { client, calls } = fakeClient(existing);
  for (let i = 0; i < 5; i++) {
    await syncOperationsTasksToTickTick([mkItem()], deps({ client, completeMissing: false }));
  }
  assert.equal(calls.created.length, 1, "created exactly once");
  assert.equal(calls.updated.length, 4, "updated on every subsequent sync");
  assert.equal(existing.length, 1, "only one TickTick task exists");
});

test("single-task sync never touches foreign (unmarked) tasks", async () => {
  const foreign: TickTickTaskRecord = { id: "manual1", projectId: "PJ_PHOTOS", status: 0, content: "شراء حليب" };
  const { client, calls } = fakeClient([foreign]);
  await syncOperationsTasksToTickTick([mkItem()], deps({ client, completeMissing: false }));
  assert.ok(!calls.updated.some((u) => (u as { id?: string }).id === "manual1"), "foreign task never updated");
  assert.equal(calls.completed.length, 0, "foreign task never completed");
});

// ── deterministic identity ───────────────────────────────────────────────────

test("records carry the deterministic OperationTask id across runs", async () => {
  const a = await syncOperationsTasksToTickTick([mkItem()], deps({ client: fakeClient([]).client }));
  const b = await syncOperationsTasksToTickTick([mkItem()], deps({ client: fakeClient([]).client }));
  assert.equal(a.records[0]!.operationTaskId, "needs_image:p1");
  assert.equal(b.records[0]!.operationTaskId, "needs_image:p1");
});
