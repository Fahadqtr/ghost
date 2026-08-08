// Product Timeline reader + source-safety scans (Phase UI.7.4). The pure
// timeline layer (providers + engine) is INJECTED so this file loads directly
// under node:test. Run:
// node --conditions=react-server --experimental-strip-types --test lib/operations/timeline/timeline-read.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadProductTimeline, type ProductTimelineReadClient } from "../read-model.ts";
import { mapSnapshotRow, createSnapshotTimelineProvider } from "./providers/snapshot-provider.ts";
import { buildTimeline } from "./timeline-engine.ts";

const engines = { mapSnapshotRow, createSnapshotTimelineProvider, buildTimeline };

/** A fake session client whose single-row read resolves to a fixed result. */
function fakeClient(result: { data: unknown[] | null; error: unknown | null }): ProductTimelineReadClient {
  const builder: {
    filter: () => typeof builder;
    limit: () => typeof builder;
    then: (r: (v: { data: unknown[] | null; error: unknown | null }) => unknown) => Promise<unknown>;
  } = {
    filter: () => builder,
    limit: () => builder,
    then: (r) => Promise.resolve(r(result)),
  };
  return { from: () => ({ select: () => builder }) } as unknown as ProductTimelineReadClient;
}

const ROW = {
  id: "p1",
  sku: "mk1",
  barcode: "6291041500213",
  name_ar: "اسم",
  name_en: "Name",
  image_url: "u",
  approval: "Approved",
  platform_status: "shopify",
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-05T12:00:00.000Z",
};

// ── orchestration ─────────────────────────────────────────────────────────────

test("a found product returns status ok with the snapshot + aggregated events", async () => {
  const res = await loadProductTimeline(fakeClient({ data: [ROW], error: null }), "p1", { engines });
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.equal(res.timeline.snapshot.id, "p1");
  assert.deepEqual(res.timeline.events.map((e) => e.kind), ["updated", "approved", "published", "created"]);
  for (const e of res.timeline.events) assert.equal(e.source, "snapshot");
});

test("a valid id with no row → notfound", async () => {
  const res = await loadProductTimeline(fakeClient({ data: [], error: null }), "p1", { engines });
  assert.equal(res.status, "notfound");
});

test("a DB error → the single constant error status (never a raw error)", async () => {
  const res = await loadProductTimeline(fakeClient({ data: null, error: { message: "boom" } }), "p1", { engines });
  assert.equal(res.status, "error");
});

test("a malformed (non-array) data payload → error", async () => {
  const res = await loadProductTimeline(
    fakeClient({ data: "nope" as unknown as unknown[], error: null }),
    "p1",
    { engines },
  );
  assert.equal(res.status, "error");
});

test("an invalid id → notfound WITHOUT querying", async () => {
  const throwing = { from: () => { throw new Error("must not query"); } } as unknown as ProductTimelineReadClient;
  assert.equal((await loadProductTimeline(throwing, "", { engines })).status, "notfound");
  assert.equal((await loadProductTimeline(throwing, "x".repeat(201), { engines })).status, "notfound");
  assert.equal((await loadProductTimeline(throwing, 123 as unknown as string, { engines })).status, "notfound");
});

test("a client whose read throws → error (never re-surfaced)", async () => {
  const throwing = { from: () => ({ select: () => { throw new Error("kaboom"); } }) } as unknown as ProductTimelineReadClient;
  const res = await loadProductTimeline(throwing, "p1", { engines });
  assert.equal(res.status, "error");
});

// ── source-safety scans ───────────────────────────────────────────────────────

const READMODEL_SRC = readFileSync(new URL("../read-model.ts", import.meta.url), "utf8");
const ENGINE_SRC = readFileSync(new URL("./timeline-engine.ts", import.meta.url), "utf8");
const PROVIDER_IFACE_SRC = readFileSync(new URL("./providers/timeline-provider.ts", import.meta.url), "utf8");
const SNAPSHOT_SRC = readFileSync(new URL("./providers/snapshot-provider.ts", import.meta.url), "utf8");
const VIEW_SRC = readFileSync(new URL("./timeline-view.ts", import.meta.url), "utf8");
const PAGE_SRC = readFileSync(new URL("../../../app/(v2)/v2/products/[id]/timeline/page.tsx", import.meta.url), "utf8");
const TIMELINE_SRC = readFileSync(new URL("../../../components/v2/operations/ProductTimeline.tsx", import.meta.url), "utf8");
const WIDGET_SRC = readFileSync(new URL("../../../components/v2/operations/ProductActivityWidget.tsx", import.meta.url), "utf8");

test("read model: session-client only — no service role / admin / write / rpc / raw errors", () => {
  for (const banned of ["service_role", "createAdminClient", ".insert(", ".update(", ".delete(", ".rpc(", "error.message"]) {
    assert.ok(!READMODEL_SRC.includes(banned), `read model must not contain ${banned}`);
  }
  assert.ok(READMODEL_SRC.includes('import "server-only"'));
  assert.ok(READMODEL_SRC.includes("loadProductTimeline"));
  assert.ok(READMODEL_SRC.includes("buildTimeline"), "reader wires providers into the engine");
});

test("timeline engine + providers + view are pure: no db/network/framework/storage", () => {
  for (const src of [ENGINE_SRC, PROVIDER_IFACE_SRC, SNAPSHOT_SRC, VIEW_SRC]) {
    for (const banned of ["supabase", "createClient", "fetch(", "server-only", "next/", "@/lib", ".rpc(", ".insert(", ".update("]) {
      assert.ok(!src.includes(banned), `pure timeline layer must not contain ${banned}`);
    }
  }
});

test("the engine is source-agnostic: it never imports a concrete provider", () => {
  // It may reference the provider INTERFACE by type only, but must not import a
  // concrete source module (that would couple the aggregator to a source).
  assert.ok(!ENGINE_SRC.includes("snapshot-provider"), "engine must not import the snapshot provider");
  assert.ok(!ENGINE_SRC.includes("deriveSnapshotEvents"), "engine must not know snapshot derivation");
});

test("timeline page: force-dynamic, session client, no service role, fixed Arabic error", () => {
  assert.ok(PAGE_SRC.includes('export const dynamic = "force-dynamic"'));
  assert.ok(PAGE_SRC.includes("createClient"));
  assert.ok(!PAGE_SRC.includes("createAdminClient"));
  assert.ok(!PAGE_SRC.includes("service_role"));
  assert.ok(PAGE_SRC.includes("تعذر تحميل سجل النشاط"));
  assert.ok(PAGE_SRC.includes("loadProductTimeline"));
});

test("timeline component + widget: no business logic, no DB/write access", () => {
  for (const src of [TIMELINE_SRC, WIDGET_SRC]) {
    for (const banned of ["buildTimeline", "deriveSnapshotEvents", "@/lib/supabase", "createClient", "createAdminClient", ".insert(", ".update(", ".rpc("]) {
      assert.ok(!src.includes(banned), `presentation layer must not contain ${banned}`);
    }
  }
});
