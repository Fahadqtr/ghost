// Phase UI.9.6 — safety scans for the Talabat snapshot adapter (source scans,
// same pattern as the other V2 guard suites). Guards: pure adapter, server-only
// READ-only capture/reader, reuse of the EXISTING diff (no new client/webhook/
// cron/table), NO order-pipeline coupling, owner-only action, no secret leakage,
// price/availability null, and page/UI wiring.
// Run: node --experimental-strip-types --test lib/platforms/talabat/talabat-snapshot-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PURE = readFileSync(new URL("./capture-compute.ts", import.meta.url), "utf8");
const CAPTURE = readFileSync(new URL("./snapshot-capture.ts", import.meta.url), "utf8");
const READER = readFileSync(new URL("./snapshot-presence.ts", import.meta.url), "utf8");
const ACTION = readFileSync(new URL("../../../app/(app)/import-export/talabat-snapshot-actions.ts", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../../app/(v2)/v2/operations/page.tsx", import.meta.url), "utf8");
const SYNC = readFileSync(new URL("../../../components/TalabatSync.tsx", import.meta.url), "utf8");

const NO_WRITE = [".update(", ".delete(", ".rpc(", "createAdminClient", "service_role", "SERVICE_ROLE"];
// The order pipeline / stock-deduction / webhook modules must never be imported.
const ORDER_PIPELINE = [
  "order-compute", "order-lines", "order-resolver", "process-order", "deduction-plan",
  "event-gate", "stock-snapshots", "webhook-core", "persist-mappings", "queue",
];
const SECRET_TOKENS = ["TALABAT_WEBHOOK_TOKEN", "access_token", "shpat_", "console.log"];

test("adapter is PURE — no server-only, no I/O, no clock", () => {
  assert.equal(PURE.includes('import "server-only"'), false);
  for (const bad of ["fetch(", "createClient", "process.env", "Date.now(", "new Date("]) {
    assert.equal(PURE.includes(bad), false, `pure adapter must not contain ${bad}`);
  }
});

test("adapter adds NO fuzzy matching — it reuses the existing diff verdicts", () => {
  // No jaccard / token-set / name-key similarity logic of its own.
  for (const bad of ["jaccard", "tokset", "isSubset", "similarity", "levenshtein"]) {
    assert.equal(PURE.includes(bad), false, `adapter must not add fuzzy matching (${bad})`);
  }
});

test("capture is server-only, REUSES the existing diff, no new client/api", () => {
  assert.ok(CAPTURE.includes('import "server-only"'));
  assert.ok(CAPTURE.includes("talabat-diff"), "capture must reuse diffTalabat");
  for (const bad of ["new Talabat", "createTalabatClient", "fetch(", "/api/", "graphql"]) {
    assert.equal(CAPTURE.includes(bad), false, `capture must not add a Talabat client/api (${bad})`);
  }
});

test("capture + reader WRITE nothing but snapshots (session client, INSERT-only)", () => {
  for (const bad of NO_WRITE) {
    assert.equal(CAPTURE.includes(bad), false, `capture must not contain ${bad}`);
    assert.equal(READER.includes(bad), false, `reader must not contain ${bad}`);
  }
  assert.equal(READER.includes(".insert("), false, "reader is READ-only");
});

test("NO coupling to the order pipeline / stock deduction / webhook", () => {
  for (const src of [PURE, CAPTURE, READER, ACTION]) {
    for (const mod of ORDER_PIPELINE) {
      assert.equal(src.includes(mod), false, `snapshot path must not import the order pipeline (${mod})`);
    }
  }
});

test("channel_variant_mappings is READ-only here (never written / semantics unchanged)", () => {
  // The reader only SELECTs mappings; it never inserts/updates/deletes them.
  assert.equal(/channel_variant_mappings[\s\S]{0,80}(insert|update|delete)/i.test(READER), false);
});

test("no scheduler / background job is added (no cron/webhook code)", () => {
  // Structural check: no timers, scheduling primitives, or webhook-route handlers.
  for (const src of [PURE, CAPTURE, READER, ACTION]) {
    assert.equal(/setInterval\(|setTimeout\(|node-cron|CronJob|export async function (GET|POST)\b/.test(src), false);
  }
});

test("no secret / token / raw-error leakage in the snapshot path", () => {
  for (const src of [PURE, CAPTURE, READER, ACTION]) {
    for (const bad of SECRET_TOKENS) assert.equal(src.includes(bad), false, `must not contain ${bad}`);
  }
  // Capture surfaces only a fixed Arabic message.
  assert.ok(CAPTURE.includes("تعذّر حفظ لقطات طلبات حاليًا."));
});

test("capture never records Talabat price or availability", () => {
  assert.ok(PURE.includes("price: null"));
  assert.ok(PURE.includes("availability: null"));
});

test("action is OWNER-only and INSERT-only via the session client", () => {
  assert.ok(ACTION.includes('"use server"'));
  assert.ok(ACTION.includes("requireOwner"));
  for (const bad of NO_WRITE) assert.equal(ACTION.includes(bad), false);
});

test("no new platform_snapshots table / migration is introduced", () => {
  for (const src of [PURE, CAPTURE, READER]) assert.equal(/create\s+table/i.test(src), false);
});

test("operations page wires the reader; NO Shopify-like auto-capture for Talabat", () => {
  assert.ok(PAGE.includes("loadTalabatSnapshotView"), "page reads Talabat snapshots");
  // Talabat has no API → capture is upload-triggered only, never fired on render.
  assert.equal(PAGE.includes("captureTalabatSnapshots"), false, "no auto-capture on the dashboard");
});

test("capture is wired into the owner upload flow (best-effort)", () => {
  assert.ok(SYNC.includes("captureTalabatSnapshotsAction"), "upload UI triggers capture");
  assert.ok(SYNC.includes("void captureTalabatSnapshotsAction"), "fire-and-forget (never blocks the diff)");
});
