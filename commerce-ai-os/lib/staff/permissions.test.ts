// Tests for staff permission parsing — the core of the /staff access-control
// layer (every staff action gates on hasPerm(parsePermissions(...))).
// Run: node --conditions=react-server --experimental-strip-types --test lib/staff/permissions.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { parsePermissions, hasPerm, DEFAULT_PERMISSIONS } from "./permissions.ts";

test("parses a jsonb array and returns perms in canonical order", () => {
  // Input order is scrambled; output must follow STAFF_PERMISSION_KEYS order.
  assert.deepEqual(parsePermissions(["tasks", "stock", "products"]), ["stock", "products", "tasks"]);
});

test("parses a JSON-encoded string array", () => {
  assert.deepEqual(parsePermissions('["stock","malak"]'), ["stock", "malak"]);
});

test("parses a comma-separated string", () => {
  assert.deepEqual(parsePermissions("stock, add_product"), ["stock", "add_product"]);
});

test("null / empty / non-array fall back to DEFAULT_PERMISSIONS", () => {
  for (const raw of [null, undefined, "", "   ", 42, {}]) {
    assert.deepEqual(parsePermissions(raw as unknown), DEFAULT_PERMISSIONS);
  }
});

test("silently drops unknown permission keys (no privilege injection)", () => {
  assert.deepEqual(parsePermissions(["stock", "admin", "root", "delete_all"]), ["stock"]);
});

test('"prices" requires "products" — dropped when products is absent', () => {
  assert.deepEqual(parsePermissions(["prices"]), []); // prices alone is meaningless → nothing
  assert.deepEqual(parsePermissions(["products", "prices"]), ["products", "prices"]); // together: kept
});

test('supervisor edit perms require "products" — dropped when it is absent', () => {
  assert.deepEqual(parsePermissions(["edit_products", "edit_images"]), []);
  assert.deepEqual(
    parsePermissions(["products", "edit_products", "edit_images"]),
    ["products", "edit_products", "edit_images"],
  );
});

test('"manage_tasks" requires "tasks"', () => {
  assert.deepEqual(parsePermissions(["manage_tasks"]), []);
  assert.deepEqual(parsePermissions(["tasks", "manage_tasks"]), ["tasks", "manage_tasks"]);
});

test("deduplicates repeated keys", () => {
  assert.deepEqual(parsePermissions(["stock", "stock", "tasks", "tasks"]), ["stock", "tasks"]);
});

test("hasPerm reflects membership and is safe on undefined", () => {
  const perms = parsePermissions(["stock", "tasks"]);
  assert.equal(hasPerm(perms, "stock"), true);
  assert.equal(hasPerm(perms, "prices"), false);
  assert.equal(hasPerm(undefined, "stock"), false);
});
