// Tests for durable product-variant identity (Phase UI.3D.0): the pure diff
// planner, the shelf-stock cleanup helper, and source scans of the edit path
// and the SQL migration. PURE tests only — no database, no network.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/variant-diff.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { planVariantDiff, type SubmittedVariant } from "./variant-diff.ts";
import { deleteShelfStockForProduct } from "./shelf-cleanup.ts";

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** SQL with `--` comments removed — the comments deliberately NAME the things
 *  the function promises never to emit (e.g. SQLERRM). */
function stripSql(src: string): string {
  return src.replace(/--.*$/gm, "");
}

const ACTIONS_SRC = readFileSync(new URL("../../app/(app)/products/actions.ts", import.meta.url), "utf8");
const HEALTH_SRC = readFileSync(new URL("../../app/(app)/catalog/health/actions.ts", import.meta.url), "utf8");
const SQL_SRC = readFileSync(new URL("../../supabase/product_variants_durable_identity.sql", import.meta.url), "utf8");

const V1 = "11111111-1111-1111-1111-111111111111";
const V2 = "22222222-2222-2222-2222-222222222222";
const FOREIGN = "99999999-9999-9999-9999-999999999999";

function v(over: Partial<SubmittedVariant> = {}): SubmittedVariant {
  return { variant_name: "أحمر", variant_name_en: "Red", sku: "SKU-1", barcode: "B-1", price: "10", stock_quantity: "3", ...over };
}
function ok(r: ReturnType<typeof planVariantDiff>) {
  assert.equal(r.ok, true, `expected a valid plan, got ${r.ok === false ? r.error : ""}`);
  if (r.ok !== true) throw new Error("unreachable");
  return r.plan;
}

// ── Identity preservation ────────────────────────────────────────────────────

test("a retained variant keeps its UUID and becomes an update", () => {
  const plan = ok(planVariantDiff([V1], [v({ id: V1 })]));
  assert.deepEqual(plan.updates.map((u) => u.id), [V1]);
  assert.equal(plan.inserts.length, 0);
  assert.deepEqual(plan.deletes, []);
});

test("changing the SKU keeps the same UUID", () => {
  const plan = ok(planVariantDiff([V1], [v({ id: V1, sku: "SKU-CHANGED" })]));
  assert.deepEqual(plan.updates.map((u) => u.id), [V1]);
  assert.equal(plan.updates[0]!.sku, "SKU-CHANGED");
  assert.deepEqual(plan.deletes, [], "a SKU change must never delete the row");
});

test("changing the barcode keeps the same UUID", () => {
  const plan = ok(planVariantDiff([V1], [v({ id: V1, barcode: "B-CHANGED" })]));
  assert.deepEqual(plan.updates.map((u) => u.id), [V1]);
  assert.equal(plan.updates[0]!.barcode, "B-CHANGED");
});

test("editing any other field keeps the same UUID", () => {
  const plan = ok(planVariantDiff([V1], [v({ id: V1, variant_name: "أزرق", price: "99", stock_quantity: "7" })]));
  assert.deepEqual(plan.updates.map((u) => u.id), [V1]);
  assert.equal(plan.updates[0]!.variant_name, "أزرق");
  assert.equal(plan.updates[0]!.price, 99);
  assert.equal(plan.updates[0]!.stock_quantity, 7);
});

test("reordering the submitted rows changes no UUID and produces no delete", () => {
  const plan = ok(planVariantDiff([V1, V2], [v({ id: V2, sku: "B" }), v({ id: V1, sku: "A" })]));
  assert.deepEqual(plan.updates.map((u) => u.id).sort(), [V1, V2]);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.inserts.length, 0);
});

// ── Inserts ──────────────────────────────────────────────────────────────────

test("a row without an id becomes an insert", () => {
  const plan = ok(planVariantDiff([], [v()]));
  assert.equal(plan.inserts.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.inserts[0]!.sku, "SKU-1");
});

test("a client-supplied id is never carried into an insert", () => {
  const plan = ok(planVariantDiff([V1], [v({ id: V1 }), v({ sku: "NEW" })]));
  assert.equal(plan.inserts.length, 1);
  // The insert shape has no id field at all.
  assert.equal(Object.hasOwn(plan.inserts[0]!, "id"), false);
  assert.ok(!JSON.stringify(plan.inserts).includes(V1), "no existing id leaks into an insert");
});

test("blank rows are ignored entirely", () => {
  const plan = ok(planVariantDiff([], [{ variant_name: "", variant_name_en: "", sku: "" }, v()]));
  assert.equal(plan.inserts.length, 1, "only the meaningful row is inserted");
});

// ── Deletes ──────────────────────────────────────────────────────────────────

test("an existing id absent from the submission becomes one targeted delete", () => {
  const plan = ok(planVariantDiff([V1, V2], [v({ id: V1 })]));
  assert.deepEqual(plan.deletes, [V2]);
  assert.deepEqual(plan.updates.map((u) => u.id), [V1], "the retained row is untouched");
});

test("a submitted row blanked out is a targeted delete, not a silent no-op", () => {
  const plan = ok(planVariantDiff([V1], [{ id: V1, variant_name: "", variant_name_en: "", sku: "" }]));
  assert.deepEqual(plan.deletes, [V1]);
  assert.equal(plan.updates.length, 0);
});

test("an empty submission deletes every existing variant, one id at a time", () => {
  const plan = ok(planVariantDiff([V1, V2], []));
  assert.deepEqual(plan.deletes, [V1, V2].sort());
  assert.equal(plan.updates.length + plan.inserts.length, 0);
});

// ── Rejection rules ──────────────────────────────────────────────────────────

test("an unknown id rejects the whole plan", () => {
  const r = planVariantDiff([V1], [v({ id: V1 }), v({ id: "not-a-known-id" })]);
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.error, "unknown_variant_id");
});

test("an id belonging to another product rejects the whole plan", () => {
  const r = planVariantDiff([V1], [v({ id: FOREIGN })]);
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.error, "unknown_variant_id");
});

test("a foreign id is rejected even when its row is otherwise blank", () => {
  const r = planVariantDiff([V1], [{ id: FOREIGN, variant_name: "", variant_name_en: "", sku: "" }]);
  assert.equal(r.ok, false, "a hostile id must not be hidden by dropping the empty row");
  if (r.ok === false) assert.equal(r.error, "unknown_variant_id");
});

test("the same existing id submitted twice rejects the whole plan", () => {
  const r = planVariantDiff([V1], [v({ id: V1, sku: "A" }), v({ id: V1, sku: "B" })]);
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.error, "duplicate_variant_id");
});

test("rejection produces no plan at all — nothing can be written", () => {
  const r = planVariantDiff([V1, V2], [v({ id: FOREIGN })]);
  assert.equal(r.ok, false);
  assert.equal("plan" in r, false, "a rejected result carries no updates/inserts/deletes");
});

test("whitespace-only ids count as absent, not as a foreign id", () => {
  const plan = ok(planVariantDiff([], [v({ id: "   " })]));
  assert.equal(plan.inserts.length, 1);
});

test("malformed input is tolerated without throwing", () => {
  assert.equal(ok(planVariantDiff([], [])).deletes.length, 0);
  assert.equal(ok(planVariantDiff(null as never, null as never)).inserts.length, 0);
  assert.equal(ok(planVariantDiff([V1], [null as never])).deletes.length, 1);
});

// ── Shelf cleanup helper ─────────────────────────────────────────────────────

function fakeClient(
  variantIds: string[],
  opts: { selectError?: boolean; deleteError?: boolean; throwOnSelect?: boolean } = {},
) {
  const calls: { table: string; op: string; column?: string; operator?: string; value?: string }[] = [];
  const client = {
    from(table: string) {
      calls.push({ table, op: "from" });
      return {
        select() {
          return {
            filter(column: string, operator: string, value: string) {
              calls.push({ table, op: "select.filter", column, operator, value });
              if (opts.throwOnSelect) throw new Error("boom");
              return Promise.resolve(
                opts.selectError
                  ? { data: null, error: { message: "boom" } }
                  : { data: variantIds.map((id) => ({ id })), error: null },
              );
            },
          };
        },
        delete() {
          return {
            filter(column: string, operator: string, value: string) {
              calls.push({ table, op: "delete.filter", column, operator, value });
              return Promise.resolve(opts.deleteError ? { error: { message: "boom" } } : { error: null });
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

test("shelf cleanup deletes the shelf rows of every variant of the product", async () => {
  const { client, calls } = fakeClient([V1, V2]);
  const r = await deleteShelfStockForProduct(client, "p1");
  assert.deepEqual(r, { ok: true, deletedVariantIds: 2 });
  const del = calls.find((c) => c.op === "delete.filter");
  assert.equal(del?.table, "variant_shelf_stock");
  assert.equal(del?.column, "variant_id");
  assert.equal(del?.operator, "in");
  assert.ok(del?.value?.includes(V1) && del?.value?.includes(V2));
});

test("a product with no variants is a clean success — nothing can be stranded", async () => {
  const { client, calls } = fakeClient([]);
  assert.deepEqual(await deleteShelfStockForProduct(client, "p1"), { ok: true, deletedVariantIds: 0 });
  assert.equal(calls.some((c) => c.op === "delete.filter"), false, "no delete is issued");
});

test("shelf cleanup FAILS CLOSED on a read error, a delete error, a throw, or a bad id", async () => {
  assert.deepEqual(await deleteShelfStockForProduct(fakeClient([V1], { selectError: true }).client, "p1"), { ok: false });
  assert.deepEqual(await deleteShelfStockForProduct(fakeClient([V1], { deleteError: true }).client, "p1"), { ok: false });
  assert.deepEqual(await deleteShelfStockForProduct(fakeClient([V1], { throwOnSelect: true }).client, "p1"), { ok: false });
  assert.deepEqual(await deleteShelfStockForProduct(fakeClient([V1]).client, ""), { ok: false });
});

test("the DELETE error is checked, never ignored", () => {
  const src = strip(readFileSync(new URL("./shelf-cleanup.ts", import.meta.url), "utf8"));
  assert.ok(/if \(del\.error\) return \{ ok: false \}/.test(src), "the delete result's error is inspected");
  assert.ok(!/Best-effort/i.test(src), "the helper is no longer best-effort");
});

// ── Full-product delete aborts when cleanup fails ────────────────────────────

test("a cleanup failure aborts the whole product deletion in both paths", () => {
  for (const [name, raw] of [["deleteProduct", ACTIONS_SRC], ["deleteProductById", HEALTH_SRC]] as const) {
    const src = strip(raw);
    const guardAt = src.indexOf("if (!shelfCleanup.ok) return");
    const variantDeleteAt = src.indexOf('from("product_variants").delete()');
    const productDeleteAt = src.indexOf('from("products").delete()');
    assert.ok(guardAt > 0, `${name} guards on the cleanup result`);
    assert.ok(guardAt < variantDeleteAt, `${name} returns before deleting variant rows`);
    assert.ok(guardAt < productDeleteAt, `${name} returns before deleting the product`);
  }
});

test("the abort message is fixed and leaks nothing", () => {
  const msg = "تعذّر حذف بيانات رفوف خيارات المنتج. لم يتم حذف المنتج.";
  assert.ok(ACTIONS_SRC.includes(msg), "deleteProduct uses the fixed message");
  assert.ok(HEALTH_SRC.includes(msg), "deleteProductById uses the fixed message");
  for (const [name, raw] of [["actions", ACTIONS_SRC], ["health", HEALTH_SRC]] as const) {
    const guardLine = strip(raw)
      .split("\n")
      .find((l) => l.includes("shelfCleanup.ok"));
    assert.ok(guardLine !== undefined, `${name} has the guard`);
    for (const banned of ["error.message", "variant_shelf_stock", "product_variants"]) {
      assert.ok(!guardLine.includes(banned), `${name} guard must not leak ${banned}`);
    }
  }
});

test("a successful cleanup still runs before the variants are deleted", () => {
  for (const [name, raw] of [["deleteProduct", ACTIONS_SRC], ["deleteProductById", HEALTH_SRC]] as const) {
    const src = strip(raw);
    const cleanupAt = src.indexOf("deleteShelfStockForProduct(supabase, id)");
    const variantDeleteAt = src.indexOf('from("product_variants").delete()');
    assert.ok(cleanupAt > 0 && cleanupAt < variantDeleteAt, `${name} cleans shelf rows first`);
  }
});

// ── Edit path: the blanket delete is gone ────────────────────────────────────

// Phase UI.4 moved the save core (syncProductVariants + updateProductCore)
// from the action file into lib/products/product-save.ts so the V2 editor
// shares it. The invariants are unchanged — these scans now check the core
// where it lives, plus that updateProduct actually routes through it.
const SAVE_CORE_SRC = readFileSync(new URL("./product-save.ts", import.meta.url), "utf8");

test("updateProduct no longer blanket-deletes the variant set", () => {
  const src = strip(ACTIONS_SRC);
  const updateStart = src.indexOf("export async function updateProduct");
  const updateEnd = src.indexOf("export async function setProductApproval");
  assert.ok(updateStart > 0 && updateEnd > updateStart, "located updateProduct");
  const body = src.slice(updateStart, updateEnd);

  assert.ok(
    !/from\("product_variants"\)\s*\.delete\(\)/.test(body),
    "the edit path must not delete the variant set",
  );
  assert.ok(/updateProductCore\(/.test(body), "the edit path routes through the shared save core");
  assert.ok(!/toVariantRows\(/.test(body), "the edit path no longer rebuilds rows for re-insert");

  const core = strip(SAVE_CORE_SRC);
  const coreUpdate = core.slice(core.indexOf("export async function updateProductCore"));
  assert.ok(!/from\("product_variants"\)\s*\.delete\(\)/.test(core), "the core never deletes the variant set");
  assert.ok(/syncProductVariants\(/.test(coreUpdate), "the edit path calls the atomic sync");
});

test("the atomic sync validates before writing and uses the session client", () => {
  const src = strip(SAVE_CORE_SRC);
  const start = src.indexOf("export async function syncProductVariants");
  const body = src.slice(start, src.indexOf("export type UpdateProductCoreResult", start));
  assert.ok(/planVariantDiff\(/.test(body), "pure pre-validation runs first");
  assert.ok(/if \(!plan\.ok\) return/.test(body), "a rejected plan returns before any write");
  assert.ok(/\.rpc\("sync_product_variants"/.test(body), "one atomic RPC call");
  assert.ok(!/createAdminClient/.test(body), "no admin client — RLS must still apply");
  assert.ok(!/createAdminClient/.test(src), "the whole save core never touches the admin client");
});

// ── Error safety ─────────────────────────────────────────────────────────────

test("every variant-sync message is fixed and leaks nothing", () => {
  const src = SAVE_CORE_SRC;
  for (const code of [
    "unknown_variant_id",
    "duplicate_variant_id",
    "variant_has_shelf_stock",
    "variant_has_channel_mapping",
    "variant_sync_failed",
  ]) {
    assert.ok(src.includes(`${code}:`), `fixed message defined for ${code}`);
  }
  // The exact wording the spec requires for an unknown/foreign id.
  assert.ok(src.includes("تعذّر حفظ الخيارات — حدّث الصفحة وحاول مجددًا."), "fixed unknown-id message");
  // The raw postgres error is never surfaced from the sync path.
  const start = strip(src).indexOf("export async function syncProductVariants");
  const body = strip(src).slice(start, strip(src).indexOf("export type UpdateProductCoreResult", start));
  for (const b of ["error.message", "SQLERRM", "friendlyWriteError"]) {
    assert.ok(!body.includes(b), `sync path must not surface ${b}`);
  }
});

// ── SQL migration ────────────────────────────────────────────────────────────

test("SQL adds the composite-key index in the correct column order", () => {
  assert.ok(
    /CREATE UNIQUE INDEX IF NOT EXISTS product_variants_parent_id_id_uk\s+ON public\.product_variants \(parent_product_id, id\)/.test(SQL_SRC),
    "unique (parent_product_id, id) — parent first",
  );
});

test("the RPC is SECURITY INVOKER with an explicit search_path and no dynamic SQL", () => {
  assert.ok(/SECURITY INVOKER/.test(SQL_SRC), "SECURITY INVOKER");
  assert.ok(!/SECURITY DEFINER/.test(SQL_SRC), "never SECURITY DEFINER");
  assert.ok(/SET search_path = public, pg_temp/.test(SQL_SRC), "pinned search_path");
  assert.ok(!/EXECUTE\s+format\(|EXECUTE\s+'/.test(SQL_SRC), "no dynamic SQL");
  assert.ok(!/service_role/.test(SQL_SRC), "no service role");
  // No caller-supplied identity or authorization flag.
  assert.ok(!/p_user_id|p_is_admin|p_authorized/.test(SQL_SRC), "no client-supplied auth input");
});

test("the RPC guards removals and never leaks raw database errors", () => {
  assert.ok(/variant_has_shelf_stock/.test(SQL_SRC), "non-zero shelf stock blocks deletion");
  assert.ok(/coalesce\(vss\.quantity, 0\) <> 0/.test(SQL_SRC), "only NON-ZERO quantity blocks");
  assert.ok(/variant_has_channel_mapping/.test(SQL_SRC), "active channel mapping blocks deletion");
  assert.ok(/mapping_status IN \('active', 'needs_review'\)/.test(SQL_SRC), "active + needs_review block");
  assert.ok(/WHEN OTHERS THEN/.test(SQL_SRC), "catch-all");
  assert.ok(!/SQLERRM/.test(stripSql(SQL_SRC)), "SQLERRM is never returned");
});

test("the RPC deletes last, so a failure cannot lose the previous variant set", () => {
  const upd = SQL_SRC.indexOf("UPDATE public.product_variants pv");
  const ins = SQL_SRC.indexOf("INSERT INTO public.product_variants");
  const del = SQL_SRC.indexOf("DELETE FROM public.product_variants pv");
  assert.ok(upd > 0 && ins > upd && del > ins, "order is update → insert → delete");
});

test("the RPC scope is the variant set only", () => {
  for (const banned of [
    "UPDATE public.products",
    "INSERT INTO public.products",
    "DELETE FROM public.products",
    "public.inventory",
    "talabat_orders",
    "shopify_synced_orders",
  ]) {
    assert.ok(!SQL_SRC.includes(banned), `RPC must not touch ${banned}`);
  }
  // It may DELETE shelf rows for removed variants, but never rewrite quantities.
  assert.ok(/DELETE FROM public\.variant_shelf_stock/.test(SQL_SRC), "cleans zero-quantity shelf rows");
  assert.ok(!/UPDATE public\.variant_shelf_stock/.test(SQL_SRC), "never silently zeroes a shelf quantity");
  // Channel mappings are inspected, never modified.
  assert.ok(!/UPDATE public\.channel_variant_mappings|DELETE FROM public\.channel_variant_mappings/.test(SQL_SRC),
    "channel mappings are never auto-modified");
});

test("the RPC generates variant UUIDs itself and re-checks ownership on write", () => {
  const insertBlock = SQL_SRC.slice(SQL_SRC.indexOf("INSERT INTO public.product_variants"));
  assert.ok(!/\bid\b\s*,/.test(insertBlock.slice(0, 300)), "no client id column in the insert list");
  assert.ok(
    (SQL_SRC.match(/parent_product_id = p_product_id/g) ?? []).length >= 3,
    "ownership is re-checked on update and delete, not just in validation",
  );
});

test("execute is granted to authenticated only, never anon", () => {
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.sync_product_variants\(uuid, jsonb\) TO authenticated/.test(SQL_SRC));
  assert.ok(/REVOKE ALL ON FUNCTION public\.sync_product_variants\(uuid, jsonb\) FROM anon/.test(SQL_SRC));
});

test("SQL preserves NULL semantics — a blank text field is never stored as ''", () => {
  const sql = stripSql(SQL_SRC);
  // Every one of the six text columns is projected through nullif(...) in BOTH
  // the update CTE and the insert CTE, matching the old str() helper, which
  // returned null for a blank value rather than an empty string.
  for (const field of ["variant_name", "variant_name_en", "sku", "barcode", "color", "size"]) {
    const projections = sql.match(
      new RegExp(`nullif\\(btrim\\(coalesce\\(e->>'${field}', ''\\)\\), ''\\)\\s+AS\\s+${field}`, "g"),
    ) ?? [];
    assert.equal(projections.length, 2, `${field} is NULL-preserving in both the update and insert CTEs`);
  }
  // No bare btrim(coalesce(...)) survives as a projected value.
  const bare = sql.match(/(?<!nullif\()btrim\(coalesce\(e->>'[a-z_]+', ''\)\)\s+AS/g) ?? [];
  assert.deepEqual(bare, [], "no projection stores an empty string instead of NULL");
});

test("verification block is read-only and never calls the RPC", () => {
  // An empty array is a valid instruction to remove every removable variant, so
  // a "just try it" verification call would delete real data.
  assert.ok(
    !/select\s+public\.sync_product_variants\s*\(/i.test(SQL_SRC),
    "the file must not contain a call to sync_product_variants",
  );
  assert.ok(!/'\[\]'::jsonb/.test(SQL_SRC), "no empty-array invocation example");
  // What it must contain instead: catalog lookups only.
  assert.ok(/pg_indexes/.test(SQL_SRC), "checks the index exists");
  assert.ok(/product_variants_parent_id_id_uk/.test(SQL_SRC), "names the index");
  assert.ok(/pg_proc/.test(SQL_SRC), "checks the function exists");
  assert.ok(/prosecdef/.test(SQL_SRC), "checks SECURITY INVOKER");
  assert.ok(/proconfig/.test(SQL_SRC), "checks the pinned search_path");
  assert.ok(/role_routine_grants/.test(SQL_SRC), "checks EXECUTE grants");
});

test("the migration contains no data-repair statement (production backlog was zero)", () => {
  assert.ok(!/UPDATE public\.variant_shelf_stock SET/.test(SQL_SRC), "no repair update");
  assert.ok(/0 rows, 0 variant ids, 0 quantity/.test(SQL_SRC), "records the orphan check result");
});
