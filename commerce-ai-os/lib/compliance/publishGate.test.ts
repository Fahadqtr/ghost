// Tests for the fail-closed publish gate.
// Run: node --conditions=react-server --experimental-strip-types --test lib/compliance/publishGate.test.ts
//
// The gate is the last line before a product goes live: no verdict on record, or
// a verdict that disallows publishing, must BLOCK — and a blocked publish must
// never run the underlying publish action.

import test from "node:test";
import assert from "node:assert/strict";

import { assertPublishAllowed, guardedPublish, PublishBlockedError } from "./publishGate.ts";
import type { ComplianceClient, ComplianceLogRow } from "./types.ts";

function row(overrides: Partial<ComplianceLogRow> = {}): ComplianceLogRow {
  return {
    id: 1, product_sku: "mk1", draft_id: null, checker_version: "v1", run_at: "2026-01-01",
    overall: "ok" as ComplianceLogRow["overall"], publish_allowed: true, needs_human: false,
    failed_checks: [], reviewed_by: null, reviewed_at: null, published_after: false, notes: null,
    ...overrides,
  };
}

// Minimal client exposing only getLatestLog (all the gate uses).
function client(latest: ComplianceLogRow | null): ComplianceClient {
  return { getLatestLog: async () => latest } as unknown as ComplianceClient;
}

test("fail-closed: no verdict on record → blocked", async () => {
  await assert.rejects(() => assertPublishAllowed(client(null), "mk1"), PublishBlockedError);
});

test("blocked when the latest verdict disallows publishing", async () => {
  await assert.rejects(
    () => assertPublishAllowed(client(row({ publish_allowed: false, overall: "fail" as ComplianceLogRow["overall"] })), "mk1"),
    (e: unknown) => e instanceof PublishBlockedError && e.sku === "mk1",
  );
});

test("returns the verdict row when publishing is allowed", async () => {
  const latest = row({ publish_allowed: true });
  const got = await assertPublishAllowed(client(latest), "mk1");
  assert.equal(got.publish_allowed, true);
});

test("guardedPublish runs the action only when allowed", async () => {
  let ran = false;
  const out = await guardedPublish(client(row({ publish_allowed: true })), "mk1", async () => { ran = true; return "published"; });
  assert.equal(ran, true);
  assert.equal(out, "published");
});

test("guardedPublish does NOT run the action when blocked", async () => {
  let ran = false;
  await assert.rejects(
    () => guardedPublish(client(null), "mk1", async () => { ran = true; return "published"; }),
    PublishBlockedError,
  );
  assert.equal(ran, false, "the publish action must never fire when blocked");
});
