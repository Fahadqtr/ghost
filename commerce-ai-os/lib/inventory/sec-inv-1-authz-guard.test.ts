// SEC.INV.1 — Inventory Write Authorization guard (source scan).
// Pins the hardened policy WITHOUT touching business logic:
//   • OWNER-only: bulk absolute updates, CSV absolute import, destructive shelf
//     removal (deleteSlot / deleteShelf);
//   • WRITER: every other back-office inventory/availability mutation;
//   • the gate is the FIRST await in each mutating action — authorization runs
//     before any client/engine/read-modify-write preparation;
//   • non-mutating helpers stay login-gated (recognizeProduct, getStaffMovements)
//     so read-only review surfaces keep working;
//   • the STAFF flow (app/staff/actions.ts — its own identity + approval loop)
//     is untouched: no writer/owner gate was introduced there;
//   • canonical authority intact: quantity via Inventory Engine, availability
//     via Availability Engine, no direct stock_quantity/stock_status update;
//   • the gate helpers delegate verbatim to the canonical authz module.
// node --conditions=react-server --experimental-strip-types --test lib/inventory/sec-inv-1-authz-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ACTIONS = "app/(app)/inventory/actions.ts";
const APPROVALS = "app/(app)/inventory/approvals-actions.ts";
const STAFF = "app/staff/actions.ts";
const GATES = "lib/auth/requireUser.ts";
const V2_HUB = "app/(v2)/v2/inventory/page.tsx";

const OWNER_FNS = ["bulkUpdateInventory", "deleteSlot", "deleteShelf", "importInventoryBySku"];
const WRITER_FNS = [
  "updateInventory", "applyStocktake", "applyVariantStocktake", "setLocation", "applyShelfCounts",
  "saveVariantShelfStock", "saveShelfStock", "setVariantBarcodes", "upsertVariants", "removeFromShelf",
  "moveShelfStock", "bulkAssignShelf", "bulkAssignVariantShelf", "createShelf", "addSlot",
  "pushStockToShopify", "recordMovement", "recordVariantMovement", "markOutOfStockByNames",
  "matchChannelsToMalika", "switchInventoryMode", "setProductAvailability", "setManyAvailability",
  "setVariantAvailability",
];
const APPROVAL_WRITER_FNS = ["approveMovements", "reverseMovement", "editMovement", "deleteMovement"];

/** The source of one exported async function (up to the next export). */
function fnBody(src: string, name: string): string {
  const re = new RegExp(`export async function ${name}\\b`);
  const start = src.search(re);
  assert.ok(start >= 0, `${name} exists`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/export (async )?function |export type |export const /);
  return next >= 0 ? rest.slice(0, next + 1) : rest;
}

/** Asserts `gate` is the FIRST await in the body — before any mutation prep. */
function assertGateFirst(body: string, name: string, gate: string) {
  const firstAwait = /await\s+([A-Za-z_$][\w$]*)\(/.exec(body);
  assert.ok(firstAwait, `${name}: has awaits`);
  assert.equal(firstAwait![1], gate, `${name}: ${gate} is the FIRST await (before any client/engine work)`);
  const gateIdx = body.indexOf(`${gate}()`);
  for (const prep of ["writableClient()", "createAdminClient()", "createClient()"]) {
    const idx = body.indexOf(prep);
    if (idx >= 0) assert.ok(gateIdx < idx, `${name}: gate precedes ${prep}`);
  }
}

test("OWNER-only: bulk absolute update, CSV absolute import, destructive shelf removal", () => {
  const src = read(ACTIONS);
  for (const name of OWNER_FNS) assertGateFirst(fnBody(src, name), name, "requireOwnerGate");
});

test("WRITER: every other back-office inventory/availability mutation fails closed for plain logins", () => {
  const src = read(ACTIONS);
  for (const name of WRITER_FNS) assertGateFirst(fnBody(src, name), name, "requireWriterGate");
  // and no mutating action is left on the plain login gate: requireUser survives
  // ONLY in the non-mutating helper (recognizeProduct).
  const users = src.match(/await requireUser\(\)/g) ?? [];
  assert.equal(users.length, 1, "exactly one requireUser() call remains in actions.ts");
  assert.match(fnBody(src, "recognizeProduct"), /await requireUser\(\)/, "…and it is recognizeProduct (read/AI helper)");
});

test("approvals: approve/reverse/edit/delete are WRITER; reading the staff log stays login-gated", () => {
  const src = read(APPROVALS);
  for (const name of APPROVAL_WRITER_FNS) assertGateFirst(fnBody(src, name), name, "requireWriterGate");
  assert.match(fnBody(src, "getStaffMovements"), /await requireUser\(\)/, "read-only review stays login-gated");
});

test("STAFF flow untouched: the staff module gained no writer/owner gate (submission + own-movement rules preserved)", () => {
  const s = read(STAFF);
  assert.equal(/requireMalakWriter|requireOwner|requireWriterGate|requireOwnerGate/.test(s), false,
    "app/staff/actions.ts keeps its own staff identity/approval workflow");
  assert.ok(/staff:\$\{who\.name\}/.test(s), "staff movements still stamp the staff agent identity");
});

test("gate helpers delegate verbatim to the canonical authz module (no new roles, requireUser contract kept)", () => {
  const s = read(GATES);
  assert.match(s, /requireWriterGate[\s\S]{0,200}requireMalakWriter\(\)/, "writer gate → requireMalakWriter");
  assert.match(s, /requireOwnerGate[\s\S]{0,200}requireOwner\(\)/, "owner gate → requireOwner");
  assert.match(s, /writer\.ok \? null : \{ error: writer\.error \}/, "denial keeps requireUser's {error}|null contract");
});

test("canonical authority intact: engine/RPC delegation pinned, zero direct quantity/status writes", () => {
  const src = read(ACTIONS);
  for (const engine of ["setAbsolute(", "setVariantAbsolute", "applyMovement(", "setProductAvailabilityState", "setVariantAvailabilityState"]) {
    assert.ok(src.includes(engine), `still delegates via ${engine}`);
  }
  assert.doesNotMatch(src, /\.update\(\s*\{[^}]*stock_quantity/, "no direct stock_quantity update");
  assert.doesNotMatch(src, /\.update\(\s*\{[^}]*stock_status/, "no direct stock_status update");
  assert.doesNotMatch(read(APPROVALS), /\.update\(\s*\{[^}]*(stock_quantity|stock_status)/, "approvals delegate too");
});

test("V2 hub shows a read-only signal for non-writers; server gates remain the real boundary", () => {
  const s = read(V2_HUB);
  assert.match(s, /requireMalakWriter\(\)/, "hub computes the writer affordance");
  assert.match(s, /وضع القراءة فقط/, "non-writers see the read-only notice");
});
