import "server-only";
import { gcalConfigured, upsertTaskEvent, deleteTaskEvent } from "@/lib/integrations/gcal";
import type { GcalTaskLite } from "@/lib/integrations/gcal-compute";

// Bridges staff_tasks ↔ Google Calendar. Best-effort: a calendar failure never
// blocks the underlying task write. Stores the event id on staff_tasks.gcal_event_id
// so tasks can be updated/removed in place (no duplicates). Requires the column
// (supabase/staff_tasks_gcal.sql); without it, sync is skipped so we never create
// untracked duplicate events.

let columnReady: boolean | null = null;

/** Does staff_tasks have the gcal_event_id column? Cached after the first probe. */
async function hasEventIdColumn(admin: any): Promise<boolean> {
  if (columnReady != null) return columnReady;
  try {
    const { error } = await admin.from("staff_tasks").select("gcal_event_id").limit(1);
    columnReady = !error;
  } catch { columnReady = false; }
  return columnReady;
}

function toLite(row: any): GcalTaskLite {
  return {
    id: String(row.id),
    title: row.title ?? "",
    description: row.description ?? null,
    assignedName: row.assigned_name ?? null,
    priority: row.priority ?? "normal",
    dueDate: row.due_date ?? null,
    status: row.status ?? "open",
    createdBy: row.created_by ?? null,
  };
}

/**
 * Reconcile ONE task row with the calendar. `row` must include id, the task
 * fields, and (if present) gcal_event_id. No due date → the event is removed.
 */
export async function syncTaskRow(admin: any, row: any): Promise<void> {
  if (!gcalConfigured() || !row) return;
  if (!(await hasEventIdColumn(admin))) return; // migration not run → skip (avoid dupes)
  const existing = row.gcal_event_id ? String(row.gcal_event_id) : null;
  const task = toLite(row);
  try {
    if (!task.dueDate) {
      if (existing) { await deleteTaskEvent(existing); await setEventId(admin, task.id, null); }
      return;
    }
    const r = await upsertTaskEvent(task, existing);
    if (r.ok && r.eventId && r.eventId !== existing) await setEventId(admin, task.id, r.eventId);
  } catch (e: any) {
    console.error("[gcal-sync] syncTaskRow", task.id, e?.message || e);
  }
}

/** Remove a task's event (on delete). `row` needs id + gcal_event_id. */
export async function removeTaskEvent(admin: any, row: any): Promise<void> {
  if (!gcalConfigured() || !row) return;
  if (!(await hasEventIdColumn(admin))) return;
  const existing = row.gcal_event_id ? String(row.gcal_event_id) : null;
  if (!existing) return;
  try { await deleteTaskEvent(existing); } catch (e: any) { console.error("[gcal-sync] removeTaskEvent", e?.message || e); }
}

async function setEventId(admin: any, taskId: string, eventId: string | null): Promise<void> {
  try { await admin.from("staff_tasks").update({ gcal_event_id: eventId }).eq("id", taskId); }
  catch (e: any) { console.error("[gcal-sync] setEventId", e?.message || e); }
}

export interface SyncSummary { ok: boolean; ready: boolean; synced: number; removed: number; failed: number; error?: string }

/**
 * Reconcile ALL tasks that have a due date (the "business calendar" scope):
 * upsert an event for each, and remove events for tasks whose date was cleared.
 */
export async function syncAllTasks(admin: any): Promise<SyncSummary> {
  const base = { ok: false, ready: false, synced: 0, removed: 0, failed: 0 };
  if (!gcalConfigured()) return { ...base, error: "Google Calendar غير مهيأ." };
  if (!(await hasEventIdColumn(admin))) return { ...base, error: "شغّل supabase/staff_tasks_gcal.sql أولاً." };
  const { data, error } = await admin
    .from("staff_tasks")
    .select("id, title, description, assigned_name, priority, due_date, status, created_by, gcal_event_id")
    .limit(2000);
  if (error) return { ...base, ready: true, error: error.message };
  let synced = 0, removed = 0, failed = 0;
  for (const row of (data ?? []) as any[]) {
    const existing = row.gcal_event_id ? String(row.gcal_event_id) : null;
    try {
      if (!row.due_date) {
        if (existing) { await deleteTaskEvent(existing); await setEventId(admin, String(row.id), null); removed++; }
        continue;
      }
      const r = await upsertTaskEvent(toLite(row), existing);
      if (r.ok) { if (r.eventId && r.eventId !== existing) await setEventId(admin, String(row.id), r.eventId); synced++; }
      else failed++;
    } catch { failed++; }
  }
  return { ok: failed === 0, ready: true, synced, removed, failed };
}
