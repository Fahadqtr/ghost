// CATALOG.GOLIVE.3A — Wave 2 Bulk Review guard (source scan).
//
// Pins the phase's safety contract:
//   1. Page load performs ZERO writes (page + read model are select-only).
//   2. Category apply delegates to the EXISTING editor save core.
//   3. Availability apply delegates to the certified Availability Engine action.
//   4. Bulk approval refuses unresolved-category rows server-side.
//   5. Activation goes ONLY through transitionProductLifecycle.
//   6. No inventory quantity mutation anywhere in the new surface.
//   7. No direct category/availability/lifecycle SQL writes in the new files.
//   8. Every mutating action is writer-gated before any per-product work.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/catalog/wave2/wave2-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

// Strip comments so pins match real code, not documentation.
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const ACTIONS = "app/(v2)/v2/catalog/launch/wave2/actions.ts";
const PAGE = "app/(v2)/v2/catalog/launch/wave2/page.tsx";
const SERVER = "lib/catalog/wave2/wave2-review.server.ts";
const PLAN = "lib/catalog/wave2/wave2-plan.ts";
const CLIENT = "components/v2/catalog/Wave2Review.tsx";

const WRITE_TOKENS = [".update(", ".insert(", ".upsert(", ".delete(", ".rpc("];

test("1. opening the page performs zero writes: page + read model are select-only", () => {
  for (const rel of [PAGE, SERVER, PLAN]) {
    const src = code(rel);
    for (const token of WRITE_TOKENS) {
      assert.ok(!src.includes(token), `${rel} must not contain ${token}`);
    }
  }
});

test("2. category apply delegates to the existing editor save core (lossless round-trip)", () => {
  const src = code(ACTIONS);
  assert.ok(src.includes("loadProductForEdit("), "reads via the editor read layer");
  assert.ok(src.includes("validateProductEditInput("), "validates via the editor validator");
  assert.ok(src.includes("updateProductCore("), "writes via the SHARED editor save core");
  assert.ok(src.includes("applyEditorInventoryEffects("), "keeps the editor's post-save effects");
  assert.ok(src.includes("isValidCategoryChoice("), "taxonomy-only categories");
  assert.ok(!src.includes("from(\"products\").update"), "no direct products update here");
});

test("3. availability apply delegates to the certified Availability Engine action", () => {
  const src = code(ACTIONS);
  assert.ok(src.includes("setManyAvailability("), "delegates to the INV.2C bulk toggle");
  assert.ok(
    src.includes('from "@/app/(app)/inventory/actions"'),
    "imported from the certified inventory actions module",
  );
  assert.ok(!src.includes("stock_status"), "never writes availability directly");
  assert.ok(!code(SERVER).includes("writeProductAvailability("), "read model never touches the engine writer");
});

test("4. bulk approval refuses unresolved-category rows server-side", () => {
  const src = code(ACTIONS);
  assert.ok(src.includes("skippedUnresolved"), "unresolved rows are skipped and reported");
  assert.ok(
    /category\.trim\(\)\s*===\s*""/.test(src) || /typeof category !== "string"/.test(src),
    "the category check happens on a FRESH server-side read",
  );
  assert.ok(src.includes("setProductApproval("), "approval delegates to the existing boundary");
  assert.ok(!src.includes('"Rejected"'), "this surface can only approve, never reject");
});

test("5. activation goes only through the OPS.8B lifecycle boundary", () => {
  const src = code(ACTIONS);
  assert.ok(src.includes("transitionProductLifecycle("), "delegates to the ONE lifecycle boundary");
  assert.ok(!src.includes("lifecycle_state"), "never writes lifecycle_state itself");
  assert.ok(!src.includes("platform_status"), "never writes the legacy mirror");
});

test("6. no inventory quantity mutation anywhere in the new surface", () => {
  for (const rel of [ACTIONS, PAGE, SERVER, PLAN, CLIENT]) {
    const src = code(rel);
    assert.ok(!src.includes("stock_quantity"), `${rel} must not touch stock_quantity`);
    assert.ok(!src.includes("inv_sell"), `${rel} must not touch sale RPCs`);
  }
});

test("7. actions file performs no direct table writes at all", () => {
  const src = code(ACTIONS);
  for (const token of WRITE_TOKENS) {
    assert.ok(!src.includes(token), `actions must not contain ${token} — delegation only`);
  }
});

test("8. every mutating action is writer-gated before any per-product work", () => {
  const src = code(ACTIONS);
  for (const fn of ["applyWave2Categories", "applyWave2Availability", "approveWave2", "activateWave2"]) {
    const start = src.indexOf(`export async function ${fn}`);
    assert.ok(start >= 0, `${fn} exists`);
    const body = src.slice(start, start + 700);
    assert.ok(body.includes("requireWriterGate()"), `${fn} gates on the writer BEFORE work`);
  }
});

test("9. the client offers only the fixed availability choices (no derived availability)", () => {
  const src = code(CLIENT);
  assert.ok(src.includes('"keep_unknown"'), "KEEP UNKNOWN is a first-class non-action");
  assert.ok(!src.includes("inv_qty"), "client never sees or derives from quantities");
  assert.ok(src.includes("availabilityPick === \"keep_unknown\""), "keep_unknown never triggers a write");
});
