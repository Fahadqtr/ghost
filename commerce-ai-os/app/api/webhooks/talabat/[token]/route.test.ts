// Behavioral tests for the Talabat webhook core (store-first, ack-fast, gated
// scheduling). Fakes only — NO real Supabase / Next / network. The route.ts
// adapter is a thin wrapper over these handlers.
// Run: node --conditions=react-server --experimental-strip-types --test "app/api/webhooks/talabat/[token]/route.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import {
  handleTalabatWebhookPost,
  handleTalabatWebhookGet,
  constantTimeEqual,
} from "../../../../../lib/talabat/webhook-core.ts";

const displayOf = () => ({ status: "RECEIVED", customerName: "Fatima", total: 10, currency: "QAR", placedAt: null, items: [] });

function makeDeps(over: any = {}) {
  const seq: string[] = [];
  const inserted: any[] = [];
  const scheduled: Array<() => any> = [];
  const processed: string[] = [];
  const deps: any = {
    tokenOk: () => true,
    parseLines: (p: any) => ({ orderCode: p?.order?.code ?? p?.code ?? null }),
    parseDisplay: displayOf,
    insertOrder: async (row: any) => { seq.push("insert"); inserted.push(row); return { id: "ord-1", error: false }; },
    isAutoDeductEnabled: () => true,
    schedule: (fn: () => any) => { seq.push("schedule"); scheduled.push(fn); },
    processOrder: async (id: string) => { processed.push(id); },
    log: () => {},
    ...over,
  };
  return { deps, seq, inserted, scheduled, processed };
}

test("invalid webhook token → 404 and no DB call", async () => {
  const { deps, inserted } = makeDeps({ tokenOk: () => false });
  const res = await handleTalabatWebhookPost(deps, { token: "wrong", rawText: "{}", headerEvent: null });
  assert.equal(res.status, 404);
  assert.equal(inserted.length, 0);
});

test("missing webhook secret → 404 (constant-time compare fails closed)", () => {
  assert.equal(constantTimeEqual("anything", ""), false);       // empty secret
  assert.equal(constantTimeEqual("", "secret"), false);         // empty given
  assert.equal(constantTimeEqual("abcd", "abce"), false);       // wrong token
  assert.equal(constantTimeEqual("secret", "secret"), true);    // correct
});

test("authorized POST stores the order BEFORE scheduling", async () => {
  const { deps, seq, inserted } = makeDeps();
  const res = await handleTalabatWebhookPost(deps, { token: "ok", rawText: JSON.stringify({ order: { code: "OC1" } }), headerEvent: "order.placed" });
  assert.equal(res.status, 200);
  assert.deepEqual(seq, ["insert", "schedule"]);                // store first, then schedule
  assert.equal(inserted.length, 1);
});

test("insert failure never schedules the processor and never leaks a raw error", async () => {
  const { deps, scheduled } = makeDeps({ insertOrder: async () => ({ id: null, error: true }) });
  const res = await handleTalabatWebhookPost(deps, { token: "ok", rawText: "{}", headerEvent: "order.placed" });
  assert.equal(res.status, 200);                                // still acks
  assert.equal(res.body, JSON.stringify({ ok: true }));         // generic body, no error
  assert.equal(scheduled.length, 0);                            // processor never scheduled
});

test("insert THROWS → still a safe 200 ack, no scheduling, no raw error", async () => {
  const { deps, scheduled } = makeDeps({ insertOrder: async () => { throw new Error("supabase exploded: column x"); } });
  const res = await handleTalabatWebhookPost(deps, { token: "ok", rawText: "{}", headerEvent: "order.placed" });
  assert.equal(res.status, 200);
  assert.ok(!/supabase|column/.test(res.body));
  assert.equal(scheduled.length, 0);
});

test("feature flag absent/false → order stored but NO processor scheduled", async () => {
  const { deps, inserted, scheduled } = makeDeps({ isAutoDeductEnabled: () => false });
  const res = await handleTalabatWebhookPost(deps, { token: "ok", rawText: JSON.stringify({ order: { code: "OC1" } }), headerEvent: "order.placed" });
  assert.equal(res.status, 200);
  assert.equal(inserted.length, 1);                             // stored
  assert.equal(scheduled.length, 0);                            // not scheduled
});

test("feature flag true → processor scheduled, and the callback reloads by internal order id", async () => {
  const { deps, scheduled, processed } = makeDeps();
  await handleTalabatWebhookPost(deps, { token: "ok", rawText: JSON.stringify({ order: { code: "OC1" } }), headerEvent: "order.placed" });
  assert.equal(scheduled.length, 1);
  await scheduled[0]();                                         // run the after() callback
  assert.deepEqual(processed, ["ord-1"]);                       // reloaded by internal id, not raw payload
});

test("order_code comes from the NEW parser, never the token", async () => {
  const { deps, inserted } = makeDeps({
    // new parser returns the order code; token is a separate path input.
    parseLines: (p: any) => ({ orderCode: p?.order?.code ?? null }),
  });
  await handleTalabatWebhookPost(deps, { token: "SECRET-TOKEN", rawText: JSON.stringify({ order: { code: "OC-9" } }), headerEvent: "order.placed" });
  assert.equal(inserted[0].order_code, "OC-9");
  assert.ok(!/SECRET-TOKEN/.test(JSON.stringify(inserted[0])) || inserted[0].order_code !== "SECRET-TOKEN");
  assert.notEqual(inserted[0].order_code, "SECRET-TOKEN");
});

test("GET health behavior unchanged: bad token 404, good token 200 ready body", () => {
  assert.equal(handleTalabatWebhookGet({ tokenOk: () => false }, { token: "x" }).status, 404);
  const ok = handleTalabatWebhookGet({ tokenOk: () => true }, { token: "x" });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, endpoint: "talabat-order-webhook", ready: true });
});
