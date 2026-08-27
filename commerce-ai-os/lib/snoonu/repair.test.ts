// SNOONU SCOPED REPAIR — owner regression proofs (15).
// Pure: the authorized scope, its preconditions, and the exact before→after
// of the ONLY rows a repair may ever touch (external_channel_listings).
// node --conditions=react-server --experimental-strip-types --test lib/snoonu/repair.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planSnoonuRepair,
  isAuthorizedRepairSku,
  SNOONU_REPAIR_SCOPE,
  type SnoonuRepairLiveProduct,
} from "./repair.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const SPI = {
  mk2227: "6a57c01e6e3fce9a0bd125ee",
  mk2229: "6a5a60ab193c4fa181b7ea99",
  mk2230: "6a5a9d8c2e0de5839aba04d5",
  mk2231: "6a5b65f76e3fce9a0b0f4e8a",
  mk2025: "6a15b1339e48caf4ff58425b",
} as const;

/** production-shaped live state: 4 placeholder rows + mk2025 DRAFT + listing. */
function live(over: Partial<Record<string, SnoonuRepairLiveProduct>> = {}): SnoonuRepairLiveProduct[] {
  const base: Record<string, SnoonuRepairLiveProduct> = {
    mk2227: { sku: "mk2227", productId: "p27", lifecycleState: "ACTIVE", listings: [{ id: "L27", externalId: "mk2227", mappingStatus: "active", variantGrain: false }] },
    mk2229: { sku: "mk2229", productId: "p29", lifecycleState: "DRAFT", listings: [{ id: "L29", externalId: "mk2229", mappingStatus: "active", variantGrain: false }] },
    mk2230: { sku: "mk2230", productId: "p30", lifecycleState: "ACTIVE", listings: [{ id: "L30", externalId: "mk2230", mappingStatus: "active", variantGrain: false }] },
    mk2231: { sku: "mk2231", productId: "p31", lifecycleState: "DRAFT", listings: [{ id: "L31", externalId: "mk2231", mappingStatus: "active", variantGrain: false }] },
    mk2025: { sku: "mk2025", productId: "p25", lifecycleState: "DRAFT", listings: [{ id: "L25", externalId: SPI.mk2025, mappingStatus: "active", variantGrain: false }] },
  };
  return Object.values({ ...base, ...over });
}

test("1: the repair planner is READ-ONLY and pure — no I/O of any kind", () => {
  const src = read("lib/snoonu/repair.ts");
  for (const bad of ["createAdminClient", "fetch(", ".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
    assert.ok(!src.includes(bad), `pure repair module contains no I/O (${bad})`);
  }
  const input = live();
  const snapshot = JSON.stringify(input);
  const a = planSnoonuRepair(input);
  const b = planSnoonuRepair(input);
  assert.equal(JSON.stringify(input), snapshot, "inputs are never mutated");
  assert.equal(a.fingerprint, b.fingerprint, "deterministic");
});

test("2: ONLY the five authorized SKUs exist in scope — nothing else can ever be selected", () => {
  assert.deepEqual([...SNOONU_REPAIR_SCOPE].map((s) => s.sku).sort(), ["mk2025", "mk2227", "mk2229", "mk2230", "mk2231"]);
  assert.equal(SNOONU_REPAIR_SCOPE.length, 5);
  for (const sku of ["mk1121", "mk2225", "mk1983", "mk10", "mk2226"]) {
    assert.equal(isAuthorizedRepairSku(sku), false, `${sku} is NOT repairable`);
  }
  // extra live products are simply ignored — the plan is scope-driven.
  const plan = planSnoonuRepair([...live(), { sku: "mk1121", productId: "pX", lifecycleState: "ACTIVE", listings: [] }]);
  assert.equal(plan.rows.length, 5);
  assert.ok(!plan.rows.some((r) => r.sku === "mk1121"));
});

test("3+4: the four placeholder rows update IN PLACE — same listing row, no insert", () => {
  const plan = planSnoonuRepair(live());
  const recs = plan.rows.filter((r) => r.type === "RECONCILE_PLACEHOLDER");
  assert.equal(recs.length, 4);
  for (const r of recs) {
    assert.equal(r.status, "eligible");
    assert.equal(r.listingId, `L${r.sku.slice(-2)}`, "the SAME existing row is targeted");
    assert.equal(r.beforeExternalId, r.sku, "before = the legacy placeholder");
    assert.equal(r.afterExternalId, SPI[r.sku as keyof typeof SPI], "after = the real SPI");
    assert.equal(r.beforeMappingStatus, "active");
    assert.equal(r.afterMappingStatus, "active", "still one active mapping — never a second row");
  }
  const server = read("lib/snoonu/repair.server.ts");
  const inserts = server.match(/\.insert\(/g) ?? [];
  assert.equal(inserts.length, 1, "exactly ONE insert exists — the durable audit row");
  assert.ok(server.includes('from("snoonu_sync_audits").insert'), "…and it is the audit table, never a listing or a product");
  assert.ok(!/from\("external_channel_listings"\)[\s\S]{0,120}?\.insert\(/.test(server), "a second listing row is never inserted");
});

test("5+6: mk2025 archives its listing ONLY — the product stays DRAFT", () => {
  const plan = planSnoonuRepair(live());
  const r = plan.rows.find((x) => x.sku === "mk2025")!;
  assert.equal(r.type, "ARCHIVE_LISTING");
  assert.equal(r.status, "eligible");
  assert.equal(r.lifecycleBefore, "DRAFT");
  assert.equal(r.beforeMappingStatus, "active");
  assert.equal(r.afterMappingStatus, "archived");
  assert.equal(r.beforeExternalId, SPI.mk2025);
  assert.equal(r.afterExternalId, SPI.mk2025, "the SPI itself is never rewritten");
  assert.equal(r.productRowChanges, false, "no product row change");
  const src = read("lib/snoonu/repair.ts") + read("lib/snoonu/repair.server.ts");
  assert.ok(!src.includes("STOPPED"), "DRAFT→STOPPED is not even expressible in the repair path");
});

test("7+8: no product row, price, content, availability or identity is reachable from the repair executor", () => {
  const server = read("lib/snoonu/repair.server.ts");
  assert.ok(!server.includes('from("products").update'), "never updates products");
  assert.ok(!server.includes('from("products").insert'), "never inserts products");
  assert.ok(!server.includes("createProductCore"), "no creation path");
  assert.ok(!server.includes("writeProductAvailability"), "no availability engine");
  assert.ok(!server.includes("transitionProductLifecycle"), "no lifecycle writes");
  for (const bad of ["price", "stock_status", "name_en", "name_ar", "description_en", "description_ar", "main_category"]) {
    assert.ok(!new RegExp(`update\\(\\s*\\{[^}]*${bad}`).test(server), `never writes ${bad}`);
  }
  const updates = server.match(/\.update\(/g) ?? [];
  assert.equal(updates.length, 1, "exactly ONE update statement exists in the whole module");
  assert.ok(server.includes('from("external_channel_listings")'), "…and it targets the listing table");
});

test("9+10: mk1121 and mk2225/mk1983 are untouched and unreachable", () => {
  const plan = planSnoonuRepair(live());
  const touched = plan.rows.map((r) => r.sku);
  for (const sku of ["mk1121", "mk2225", "mk1983"]) assert.ok(!touched.includes(sku), `${sku} never appears in a repair plan`);
  const src = read("lib/snoonu/repair.ts") + read("lib/snoonu/repair.server.ts");
  for (const sku of ["mk1121", "mk2225", "mk1983"]) assert.ok(!src.includes(sku), `${sku} is not referenced anywhere in the repair path`);
});

test("11: fingerprint drift refuses the apply (server compares a REBUILT plan)", () => {
  const before = planSnoonuRepair(live());
  const drifted = planSnoonuRepair(live({
    mk2230: { sku: "mk2230", productId: "p30", lifecycleState: "ACTIVE", listings: [{ id: "L30", externalId: "OTHER", mappingStatus: "active", variantGrain: false }] },
  }));
  assert.notEqual(before.fingerprint, drifted.fingerprint, "any change of before/after state changes the fingerprint");
  const server = read("lib/snoonu/repair.server.ts");
  assert.ok(server.includes("plan.fingerprint !== input.expectedFingerprint"), "apply compares the rebuilt fingerprint");
  assert.ok(server.includes('return { ok: false, error: "plan_changed" }'), "drift fails closed");
});

test("12: a missing/unexpected placeholder blocks THAT row only", () => {
  const missing = planSnoonuRepair(live({
    mk2229: { sku: "mk2229", productId: "p29", lifecycleState: "DRAFT", listings: [] },
  }));
  const r = missing.rows.find((x) => x.sku === "mk2229")!;
  assert.equal(r.status, "blocked");
  assert.equal(r.afterExternalId, null, "a blocked row plans no change at all");
  assert.equal(missing.eligible, 4, "the other four stay eligible");

  const renamed = planSnoonuRepair(live({
    mk2230: { sku: "mk2230", productId: "p30", lifecycleState: "ACTIVE", listings: [{ id: "L30", externalId: "legacy-other", mappingStatus: "active", variantGrain: false }] },
  }));
  assert.equal(renamed.rows.find((x) => x.sku === "mk2230")!.status, "blocked", "an unexpected placeholder value blocks");
});

test("13: a conflicting real SPI mapping blocks the reconcile", () => {
  const plan = planSnoonuRepair(live({
    mk2227: { sku: "mk2227", productId: "p27", lifecycleState: "ACTIVE", listings: [{ id: "L27", externalId: "6a99999999999999999999zz".replace(/z/g, "9"), mappingStatus: "active", variantGrain: false }] },
  }));
  const r = plan.rows.find((x) => x.sku === "mk2227")!;
  assert.equal(r.status, "blocked");
  assert.ok((r.reason ?? "").includes("SPI"), "the reason names the conflicting real SPI");
});

test("14: repeating the repair is idempotent — already-repaired rows report safely, never re-write", () => {
  const done = planSnoonuRepair(live({
    mk2227: { sku: "mk2227", productId: "p27", lifecycleState: "ACTIVE", listings: [{ id: "L27", externalId: SPI.mk2227, mappingStatus: "active", variantGrain: false }] },
    mk2025: { sku: "mk2025", productId: "p25", lifecycleState: "DRAFT", listings: [{ id: "L25", externalId: SPI.mk2025, mappingStatus: "archived", variantGrain: false }] },
  }));
  const rec = done.rows.find((x) => x.sku === "mk2227")!;
  const arch = done.rows.find((x) => x.sku === "mk2025")!;
  assert.equal(rec.status, "already_repaired");
  assert.equal(rec.beforeExternalId, rec.afterExternalId, "no change is planned");
  assert.equal(arch.status, "already_repaired");
  assert.equal(arch.afterMappingStatus, "archived");
  assert.equal(done.eligible, 3, "only the still-outstanding rows remain eligible");
  assert.equal(done.blocked, 0, "already-repaired is NOT an error");
});

test("15: the repair path never invokes the normal sync apply", () => {
  const server = read("lib/snoonu/repair.server.ts");
  for (const bad of ["applySnoonuSyncPlan", "planSnoonuSync(", "previewSnoonuSyncPlan", "loadSnoonuSyncContext"]) {
    assert.ok(!server.includes(bad), `repair never calls the sync path (${bad})`);
  }
  const ui = read("components/v2/catalog/SnoonuSync.tsx");
  const repairSlice = ui.slice(ui.indexOf("async function runRepairApply"), ui.indexOf("function formDataWithFile"));
  assert.ok(repairSlice.includes("applySnoonuRepairAction"), "the repair button calls the repair action");
  assert.ok(!repairSlice.includes("applySnoonuSyncAction"), "…and never the sync apply action");
  assert.ok(ui.includes("إصلاح العمليات الفاشلة فقط") && ui.includes("تنفيذ إصلاح الخمس حالات"), "both required buttons exist");
  assert.ok(ui.includes("لن يتم تطبيق تغييرات المحتوى أو السعر أو المخزون"), "the confirmation states the exclusions");
  const actions = read("app/(v2)/v2/catalog/snoonu-sync/actions.ts");
  assert.ok(/previewSnoonuRepairAction[\s\S]*?requireOwner/.test(actions) && /applySnoonuRepairAction[\s\S]*?requireOwner/.test(actions),
    "both repair actions are OWNER-gated");
});
