// TickTick timeline-provider tests (Phase UI.7.5). PURE. Run:
// node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/timeline-provider.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { toTimelineEvents, createTickTickTimelineProvider } from "./timeline-provider.ts";
import { buildTimeline } from "../../operations/timeline/timeline-engine.ts";
import { createSnapshotTimelineProvider } from "../../operations/timeline/providers/snapshot-provider.ts";
import type { TickTickSyncItemResult } from "./types.ts";

function rec(over: Partial<TickTickSyncItemResult>): TickTickSyncItemResult {
  return { operationTaskId: over.operationTaskId ?? "needs_image:p1", productId: over.productId ?? "p1", action: over.action ?? "created", ...over };
}

test("only verified actions become events (skipped/failed produce none)", () => {
  const events = toTimelineEvents([
    rec({ action: "created", at: "2026-08-08T00:00:00.000Z" }),
    rec({ action: "updated", operationTaskId: "needs_data:p2", productId: "p2" }),
    rec({ action: "completed", operationTaskId: "needs_image:p3", productId: "p3" }),
    rec({ action: "skipped", operationTaskId: "x:p4", productId: "p4" }),
    rec({ action: "failed", operationTaskId: "x:p5", productId: "p5" }),
  ]);
  assert.deepEqual(events.map((e) => e.kind), ["ticktick_synced", "ticktick_updated", "ticktick_completed"]);
  for (const e of events) assert.equal(e.source, "ticktick");
});

test("atKnown is true only when the API returned a timestamp; never invented", () => {
  const [withTime, without] = toTimelineEvents([
    rec({ action: "created", operationTaskId: "a:p1", at: "2026-08-08T00:00:00.000Z" }),
    rec({ action: "updated", operationTaskId: "b:p2", at: null }),
  ]);
  assert.equal(withTime!.atKnown, true);
  assert.equal(withTime!.at, "2026-08-08T00:00:00.000Z");
  assert.equal(without!.atKnown, false);
  assert.equal(without!.at, null);
});

test("event ids are unique per (source, kind, operationTaskId)", () => {
  const events = toTimelineEvents([rec({ action: "created", operationTaskId: "needs_image:p1" })]);
  assert.equal(events[0]!.id, "ticktick:ticktick_synced:needs_image:p1");
});

test("provider reports source 'ticktick' and returns its events", () => {
  const p = createTickTickTimelineProvider([rec({ action: "created" })]);
  assert.equal(p.source, "ticktick");
  assert.equal(p.getEvents().length, 1);
});

test("the unchanged engine merges TickTick events with snapshot events", () => {
  const snapshot = createSnapshotTimelineProvider({
    id: "p1", sku: "MK1", barcode: null, nameAr: "اسم", nameEn: null, imageUrl: null,
    approval: "Approved", platformStatus: "", createdAt: "2026-08-01T10:00:00.000Z", updatedAt: null,
  });
  const ticktick = createTickTickTimelineProvider([rec({ action: "created", at: "2026-08-09T00:00:00.000Z" })]);
  const events = buildTimeline([snapshot, ticktick]);
  // newest first: the TickTick event (Aug 9) precedes the snapshot 'created' (Aug 1).
  assert.equal(events[0]!.kind, "ticktick_synced");
  assert.ok(events.some((e) => e.kind === "created"));
});

test("timeline-provider source invents no timestamp (no clock)", () => {
  const src = readFileSync(new URL("./timeline-provider.ts", import.meta.url), "utf8");
  for (const banned of ["Date.now", "new Date(", "Math.random", "fetch(", "supabase", "process.env"]) {
    assert.ok(!src.includes(banned), `timeline provider must not contain ${banned}`);
  }
});
