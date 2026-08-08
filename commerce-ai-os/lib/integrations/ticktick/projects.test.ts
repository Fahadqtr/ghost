// TickTick Project Browser tests (read-only). PURE — no db/network/clock.
// Run: node --conditions=react-server --experimental-strip-types --test lib/integrations/ticktick/projects.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeProjects, loadProjectBrowser } from "./projects.ts";
import { TickTickError, TICKTICK_ERRORS, toSafeMessage } from "./errors.ts";

const FIXED_MESSAGES = new Set<string>(Object.values(TICKTICK_ERRORS));

// A read-only fake that records exactly which capabilities the browser used.
// It exposes ONLY listProjects — any attempt to write would be a compile error,
// and the recorder proves no other call path exists.
function fakeReader(result: () => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    listProjects: () => {
      calls.push("listProjects");
      return result();
    },
  };
}

test("normalizeProjects: maps the TickTick shape to the four safe fields", () => {
  const rows = normalizeProjects([
    { id: "p1", name: "الصور", closed: false, viewMode: "list" },
    { id: "p2", name: "المراجعة", closed: true, viewMode: "kanban" },
  ]);
  assert.deepEqual(rows, [
    { id: "p1", name: "الصور", closed: false, viewMode: "list" },
    { id: "p2", name: "المراجعة", closed: true, viewMode: "kanban" },
  ]);
});

test("normalizeProjects: drops malformed/id-less entries and defaults name; open by default", () => {
  const rows = normalizeProjects([
    { id: "ok", name: "قائمة" },
    { id: "", name: "no id" },
    { name: "missing id" },
    null,
    "nope",
    42,
    { id: "noname" },
  ]);
  assert.deepEqual(rows, [
    { id: "ok", name: "قائمة", closed: false, viewMode: undefined },
    { id: "noname", name: "(بدون اسم)", closed: false, viewMode: undefined },
  ]);
});

test("normalizeProjects: keeps ONLY the four public fields (no passthrough leakage)", () => {
  const rows = normalizeProjects([
    {
      id: "p1",
      name: "قائمة",
      closed: false,
      viewMode: "list",
      // fields that must NOT survive normalization:
      access_token: "SECRET",
      authorization: "Bearer SECRET",
      permission: "write",
      groupId: "g1",
    },
  ]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["closed", "id", "name", "viewMode"]);
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes("SECRET"), "no token-like field leaks through");
  assert.ok(!serialized.toLowerCase().includes("bearer"), "no Authorization value leaks through");
});

test("normalizeProjects: non-array input → []", () => {
  for (const bad of [null, undefined, {}, "list", 0, { tasks: [] }]) {
    assert.deepEqual(normalizeProjects(bad), []);
  }
});

test("not connected: no token configured → not_connected, and NO API call is made", async () => {
  const reader = fakeReader(async () => {
    throw new Error("should never be called");
  });
  const res = await loadProjectBrowser({ configured: false, listProjects: reader.listProjects });
  assert.deepEqual(res, { state: "not_connected" });
  assert.deepEqual(reader.calls, [], "must not call the API when not configured");
});

test("successful list: returns normalized rows, and only listProjects (a read) was used", async () => {
  const reader = fakeReader(async () => [
    { id: "p1", name: "الصور", closed: false, viewMode: "list" },
    { id: "p2", name: "أرشيف", closed: true },
  ]);
  const res = await loadProjectBrowser({ configured: true, listProjects: reader.listProjects });
  assert.equal(res.state, "ok");
  if (res.state !== "ok") return;
  assert.deepEqual(res.projects, [
    { id: "p1", name: "الصور", closed: false, viewMode: "list" },
    { id: "p2", name: "أرشيف", closed: true, viewMode: undefined },
  ]);
  // no write endpoints exist on the deps — only the read was performed.
  assert.deepEqual(reader.calls, ["listProjects"]);
});

test("empty list: an empty project array is a valid ok state (not an error)", async () => {
  const reader = fakeReader(async () => []);
  const res = await loadProjectBrowser({ configured: true, listProjects: reader.listProjects });
  assert.deepEqual(res, { state: "ok", projects: [] });
  assert.deepEqual(reader.calls, ["listProjects"]);
});

test("api failure: a thrown TickTickError → error state with a fixed Arabic message only", async () => {
  const reader = fakeReader(async () => {
    throw new TickTickError("auth");
  });
  const res = await loadProjectBrowser({ configured: true, listProjects: reader.listProjects, toSafeMessage });
  assert.equal(res.state, "error");
  if (res.state !== "error") return;
  assert.ok(FIXED_MESSAGES.has(res.message), "message must be one of the fixed Arabic messages");
  assert.equal(res.message, TICKTICK_ERRORS.auth);
});

test("api failure: an unexpected raw error never leaks — mapped to a fixed message", async () => {
  const reader = fakeReader(async () => {
    throw new Error("500 https://api.ticktick.com/open/v1/project token=abc raw stack");
  });
  const res = await loadProjectBrowser({ configured: true, listProjects: reader.listProjects, toSafeMessage });
  assert.equal(res.state, "error");
  if (res.state !== "error") return;
  assert.ok(FIXED_MESSAGES.has(res.message), "must be a fixed message");
  assert.ok(!res.message.includes("http"), "no URL leaks");
  assert.ok(!res.message.includes("token"), "no token text leaks");
  assert.ok(!res.message.includes("stack"), "no stack leaks");
});
