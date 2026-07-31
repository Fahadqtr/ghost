// Behavioral tests for the Talabat webhook core (token-before-body, store-first,
// ack-fast, gated scheduling, schedule-failure handling). Fakes only — NO real
// Supabase / Next / network. The route.ts adapter is a thin wrapper over these.
// Run: node --conditions=react-server --experimental-strip-types --test "app/api/webhooks/talabat/[token]/route.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import {
  handleTalabatWebhookPost,
  handleTalabatWebhookGet,
  constantTimeEqual,
  normalizeStoredEvent,
} from "../../../../../lib/talabat/webhook-core.ts";

const displayOf = () => ({ status: "RECEIVED", customerName: "Fatima", total: 10, currency: "QAR", placedAt: null, items: [] });

function makeDeps(over: any = {}) {
  const seq: string[] = [];
  const inserted: any[] = [];
  const scheduled: Array<() => any> = [];
  const processed: string[] = [];
  const scheduleFailed: string[] = [];
  const deps: any = {
    tokenOk: () => true,
    readBody: async () => { seq.push("read"); return over.rawText ?? JSON.stringify({ order: { code: "OC1" } }); },
    parseLines: (p: any) => ({ orderCode: p?.order?.code ?? p?.code ?? null, event: p?.order?.event ?? p?.event ?? null }),
    parseDisplay: displayOf,
    insertOrder: async (row: any) => { seq.push("insert"); inserted.push(row); return { id: "ord-1", error: false }; },
    isAutoDeductEnabled: () => true,
    schedule: (fn: () => any) => { seq.push("schedule"); scheduled.push(fn); },
    processOrder: async (id: string) => { processed.push(id); },
    handleScheduleFailure: async (id: string) => { scheduleFailed.push(id); },
    log: () => {},
    ...over,
  };
  return { deps, seq, inserted, scheduled, processed, scheduleFailed };
}

test("unauthorized request → 404, and the body is NEVER read (no parser/insert/schedule)", async () => {
  const { deps, seq, inserted, scheduled } = makeDeps({ tokenOk: () => false });
  const res = await handleTalabatWebhookPost(deps, { token: "wrong", headerEvent: null });
  assert.equal(res.status, 404);
  assert.ok(!seq.includes("read"), "readBody must NOT be called on a bad token");
  assert.equal(inserted.length, 0);
  assert.equal(scheduled.length, 0);
});

test("missing webhook secret → constant-time compare fails closed", () => {
  assert.equal(constantTimeEqual("anything", ""), false);
  assert.equal(constantTimeEqual("", "secret"), false);
  assert.equal(constantTimeEqual("abcd", "abce"), false);
  assert.equal(constantTimeEqual("secret", "secret"), true);
});

test("normalizeStoredEvent: string capped at 80; object/array/number/empty → null", () => {
  assert.equal(normalizeStoredEvent("order.placed"), "order.placed");
  assert.equal(normalizeStoredEvent("  order.placed  "), "order.placed");
  assert.equal(normalizeStoredEvent("x".repeat(100))!.length, 80);
  assert.equal(normalizeStoredEvent({ a: 1 }), null);
  assert.equal(normalizeStoredEvent(["a"]), null);
  assert.equal(normalizeStoredEvent(42), null);
  assert.equal(normalizeStoredEvent(""), null);
  assert.equal(normalizeStoredEvent(null), null);
});

test("authorized POST reads body then stores then schedules — in that order", async () => {
  const { deps, seq } = makeDeps();
  const res = await handleTalabatWebhookPost(deps, { token: "ok", headerEvent: "order.placed" });
  assert.equal(res.status, 200);
  assert.deepEqual(seq, ["read", "insert", "schedule"]);
});

test("insert failure → no scheduling and no raw error leak", async () => {
  const { deps, scheduled } = makeDeps({ insertOrder: async () => ({ id: null, error: true }) });
  const res = await handleTalabatWebhookPost(deps, { token: "ok", headerEvent: "order.placed" });
  assert.equal(res.status, 200);
  assert.equal(res.body, JSON.stringify({ ok: true }));
  assert.equal(scheduled.length, 0);
});

test("insert THROWS → safe 200, no raw error, no scheduling", async () => {
  const { deps, scheduled } = makeDeps({ insertOrder: async () => { throw new Error("supabase exploded: column x"); } });
  const res = await handleTalabatWebhookPost(deps, { token: "ok", headerEvent: "order.placed" });
  assert.equal(res.status, 200);
  assert.ok(!/supabase|column/.test(res.body));
  assert.equal(scheduled.length, 0);
});

test("feature flag false → stored but NOT scheduled", async () => {
  const { deps, inserted, scheduled } = makeDeps({ isAutoDeductEnabled: () => false });
  await handleTalabatWebhookPost(deps, { token: "ok", headerEvent: "order.placed" });
  assert.equal(inserted.length, 1);
  assert.equal(scheduled.length, 0);
});

test("feature flag true → scheduled; the callback reloads by internal order id", async () => {
  const { deps, scheduled, processed } = makeDeps();
  await handleTalabatWebhookPost(deps, { token: "ok", headerEvent: "order.placed" });
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.deepEqual(processed, ["ord-1"]);
});

test("order_code comes from the NEW parser, never the token", async () => {
  const { deps, inserted } = makeDeps({ rawText: JSON.stringify({ order: { code: "OC-9" } }) });
  await handleTalabatWebhookPost(deps, { token: "SECRET-TOKEN", headerEvent: "order.placed" });
  assert.equal(inserted[0].order_code, "OC-9");
  assert.notEqual(inserted[0].order_code, "SECRET-TOKEN");
});

test("nested order.event is preserved when headers are absent", async () => {
  const { deps, inserted } = makeDeps({ rawText: JSON.stringify({ order: { code: "OC-1", event: "order.created" } }) });
  await handleTalabatWebhookPost(deps, { token: "ok", headerEvent: null });
  assert.equal(inserted[0].event, "order.created");
});

test("a non-string parsed event is stored as null", async () => {
  const { deps, inserted } = makeDeps({ parseLines: () => ({ orderCode: "OC-1", event: { nested: "bad" } }) });
  await handleTalabatWebhookPost(deps, { token: "ok", headerEvent: null });
  assert.equal(inserted[0].event, null);
});

test("schedule THROWS → still 200, processor NOT called inline, order handed to schedule-failure handler, no raw error", async () => {
  const { deps, processed, scheduleFailed } = makeDeps({ schedule: () => { throw new Error("after() registration blew up"); } });
  const res = await handleTalabatWebhookPost(deps, { token: "ok", headerEvent: "order.placed" });
  assert.equal(res.status, 200);
  assert.ok(!/after\(\)|blew up/.test(res.body));
  assert.equal(processed.length, 0);                 // never run inline
  assert.deepEqual(scheduleFailed, ["ord-1"]);       // order not left silently pending
});

test("GET health behavior unchanged: bad token 404, good token 200 ready body", () => {
  assert.equal(handleTalabatWebhookGet({ tokenOk: () => false }, { token: "x" }).status, 404);
  const ok = handleTalabatWebhookGet({ tokenOk: () => true }, { token: "x" });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, endpoint: "talabat-order-webhook", ready: true });
});
