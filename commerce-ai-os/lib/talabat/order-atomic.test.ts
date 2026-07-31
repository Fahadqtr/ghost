// Source-scan guarantees for the atomic RPC migration + cross-cutting rules
// (webhook/Shopify untouched, module purity, malak_audit contract). No SQL is
// executed and no network is used — the RPC is verified as text.
// Run: node --conditions=react-server --experimental-strip-types --test lib/talabat/order-atomic.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const SQL = read("supabase/talabat_order_atomic_processing.sql");
const SQL_CODE = SQL.replace(/--.*$/gm, "");

test("24: locks the order row FOR UPDATE", () => {
  assert.match(SQL_CODE, /from\s+talabat_orders\s+where\s+id\s*=\s*p_order_id\s+for\s+update/is);
});

test("24b: locks targeted inventory / variant / shelf rows FOR UPDATE", () => {
  assert.match(SQL_CODE, /from\s+inventory\s+where\s+product_id\s*=\s*v_pid\s+for\s+update/is);
  assert.match(SQL_CODE, /from\s+product_variants\s+where\s+parent_product_id[^;]*for\s+update/is);
  assert.match(SQL_CODE, /from\s+shelf_stock[^;]*for\s+update/is);
  assert.match(SQL_CODE, /from\s+variant_shelf_stock[^;]*for\s+update/is);
});

test("25: atomic — one function, no partial COMMIT/BEGIN-TX/SAVEPOINT; verify-then-apply", () => {
  assert.ok(!/\bcommit\b/i.test(SQL_CODE));
  assert.ok(!/\bsavepoint\b/i.test(SQL_CODE));
  assert.ok(!/\bbegin\s+transaction\b/i.test(SQL_CODE));
  assert.match(SQL_CODE, /v_fail\s+is not null/i);
  assert.match(SQL_CODE, /create or replace function public\.process_talabat_order_deduction/i);
});

test("8: a per-dedup-key advisory lock is taken before any inventory lock", () => {
  assert.match(SQL_CODE, /pg_advisory_xact_lock\(hashtext\(p_dedup_key\)\)/i);
  const advIdx = SQL_CODE.search(/pg_advisory_xact_lock/i);
  const invIdx = SQL_CODE.search(/from\s+inventory\s+where\s+product_id\s*=\s*v_pid\s+for\s+update/is);
  assert.ok(advIdx >= 0 && invIdx >= 0 && advIdx < invIdx, "advisory lock precedes inventory lock");
  assert.match(SQL_CODE, /missing_dedup_key/); // non-empty dedup key mandatory
});

test("8b: ANY other order holding the key blocks deduction — not restricted to 'processed', not via unique-index failure", () => {
  // The cross-order duplicate check must NOT be narrowed to processing_status='processed'.
  assert.match(SQL_CODE, /dedup_key\s*=\s*p_dedup_key\s+and\s+id\s*<>\s*p_order_id\s*\)/is);
  assert.ok(!/dedup_key\s*=\s*p_dedup_key\s+and\s+id\s*<>\s*p_order_id\s+and\s+processing_status/is.test(SQL_CODE),
    "duplicate check must cover pending/manual_review/failed, not only processed");
  assert.match(SQL_CODE, /'duplicate_order'/);
});

test("8c: an already-processed order with a DIFFERENT stored key returns duplicate_order (no change)", () => {
  assert.match(SQL_CODE, /v_status in \('processed', 'manual_review'\)/i);
  assert.match(SQL_CODE, /v_dedup is not null and v_dedup <> p_dedup_key then\s*return jsonb_build_object\('status', 'duplicate_order', 'idempotent', true\)/is);
});

test("8d: the key is reserved on THIS order before inventory locks, with a row-count check", () => {
  assert.match(SQL_CODE, /update talabat_orders set dedup_key = p_dedup_key[\s\S]{0,220}?get diagnostics v_rows = row_count[\s\S]{0,90}?v_rows <> 1 then v_fail := 'duplicate_order'/i);
  // reservation precedes the first inventory lock
  const resIdx = SQL_CODE.search(/update talabat_orders set dedup_key = p_dedup_key/i);
  const invIdx = SQL_CODE.search(/from\s+inventory\s+where\s+product_id\s*=\s*v_pid\s+for\s+update/is);
  assert.ok(resIdx >= 0 && invIdx >= 0 && resIdx < invIdx, "key reserved before inventory lock");
});

test("4: invalid / empty plan is rejected (invalid_plan, no deduction)", () => {
  assert.match(SQL_CODE, /jsonb_typeof\(p_plan\) <> 'object'/);                       // must be an object
  assert.match(SQL_CODE, /\(p_plan ->> 'status'\) is distinct from 'ready'/);          // status must be "ready"
  assert.match(SQL_CODE, /jsonb_typeof\(p_plan -> 'deductions'\) <> 'array'/);
  assert.match(SQL_CODE, /jsonb_array_length\(p_plan -> 'deductions'\) = 0/);
  assert.match(SQL_CODE, /'invalid_plan'/);
  assert.match(SQL_CODE, /!~ '\^\[1-9\]\[0-9\]\*\$'/); // quantity must be a positive integer string
});

test("4b: only a plan with status='ready' can be applied (a manual_review plan is invalid_plan)", () => {
  assert.match(SQL_CODE, /\(p_plan ->> 'status'\) is distinct from 'ready'/);
});

test("4c: quantity must be a JSON number — the string \"2\" is rejected", () => {
  assert.match(SQL_CODE, /jsonb_typeof\(v_ded -> 'quantity'\) <> 'number'/);
});

test("4d: masterProductId must be a valid UUID string (no cast until validated)", () => {
  assert.match(SQL_CODE, /v_uuid_re\s+text\s*:=\s*'\^\[0-9a-fA-F\]\{8\}/);
  assert.match(SQL_CODE, /\(v_ded ->> 'masterProductId'\) !~ v_uuid_re/);
  // the ::uuid cast happens only in PASS 1, AFTER validation
  const valIdx = SQL_CODE.search(/!~ v_uuid_re/);
  const castIdx = SQL_CODE.search(/\(v_ded ->> 'masterProductId'\)::uuid/);
  assert.ok(valIdx >= 0 && castIdx >= 0 && valIdx < castIdx, "uuid validated before it is cast");
});

test("4e: masterVariantSku must be JSON null or a non-empty string", () => {
  assert.match(SQL_CODE, /jsonb_typeof\(v_msku\) = 'null'/);
  assert.match(SQL_CODE, /jsonb_typeof\(v_msku\) = 'string' and length\(v_ded ->> 'masterVariantSku'\) > 0/);
});

test("4f: quantity / aggregated total must stay within int4 range (bigint aggregation)", () => {
  assert.match(SQL_CODE, /\(v_ded ->> 'quantity'\)::bigint > 2147483647/);        // per-row (cast only after format proven)
  assert.match(SQL_CODE, /sum\(\(d ->> 'quantity'\)::bigint\)/);                  // aggregate in bigint
  assert.match(SQL_CODE, /s\.qsum > 2147483647/);                                 // reject overflow
});

test("3-staged: no cast shares a boolean expression with the type/regex guard that protects it", () => {
  // The UUID regex check and the ::uuid cast never sit in the same statement.
  assert.ok(!/!~ v_uuid_re[^;]*::/.test(SQL_CODE), "uuid regex and a cast must not share an expression");
  // The quantity regex check and any numeric/bigint/int cast never share a statement.
  assert.ok(!/!~ '\^\[1-9\]\[0-9\]\*\$'[^;]*::(numeric|bigint|int)/.test(SQL_CODE), "quantity regex and a cast must not share an expression");
  // The removed pattern (regex OR-ed with a cast) must be gone entirely.
  assert.ok(!/::numeric > 2147483647/.test(SQL_CODE), "the ::numeric-in-OR pattern must be removed");
  // Each validation stage is its own guarded IF that fails to invalid_plan.
  assert.match(SQL_CODE, /jsonb_typeof\(v_ded -> 'quantity'\) <> 'number' then\s*v_fail := 'invalid_plan'/i);
});

test("5c-sql: a NULL / negative SIBLING variant stock blocks the deduction (fail-closed rollup)", () => {
  assert.match(SQL_CODE, /product_variants where parent_product_id = v_pid and \(stock_quantity is null or stock_quantity < 0\)/i);
});

test("5d-sql: sibling variant rows are locked in a DETERMINISTIC order before the parent inventory", () => {
  assert.match(SQL_CODE, /product_variants where parent_product_id = v_pid order by sku, id for update/i);
  // the deterministic sibling lock precedes locking the parent inventory row
  const sib = SQL_CODE.search(/product_variants where parent_product_id = v_pid order by sku, id for update/i);
  const par = SQL_CODE.search(/select id, sold_quantity into v_inv_id, v_sold_before\s*\n\s*from inventory where product_id = v_pid for update/i);
  assert.ok(sib >= 0 && par >= 0 && sib < par, "siblings locked before the parent inventory");
});

test("5e-sql: aggregated targets use deterministic ordering (masterProductId, masterVariantSku)", () => {
  assert.match(SQL_CODE, /order by pid, vsku/i);
});

test("6-sold: a Talabat sale advances sold_quantity in BOTH branches (additive, never reset)", () => {
  const incs = (SQL_CODE.match(/sold_quantity = coalesce\(sold_quantity, 0\) \+ v_qty/gi) ?? []).length;
  assert.ok(incs >= 2, `expected sold_quantity increments in both branches, found ${incs}`);
  assert.ok(!/sold_quantity\s*=\s*v_qty\b/.test(SQL_CODE), "must ADD to sold_quantity, not overwrite it");
  assert.ok(!/sold_quantity\s*=\s*0\b/.test(SQL_CODE), "must never reset sold_quantity to 0");
});

test("6-sold: a negative existing sold_quantity is inventory_inconsistent", () => {
  assert.ok((SQL_CODE.match(/v_sold_before is not null and v_sold_before < 0/g) ?? []).length >= 2);
});

test("6-audit: the sale movement records reason='sale' and source='talabat' (no raw payload / PII)", () => {
  assert.ok((SQL_CODE.match(/'reason', 'sale'/g) ?? []).length >= 2);
  assert.ok((SQL_CODE.match(/'source', 'talabat'/g) ?? []).length >= 2);
  assert.ok(!/'reason', 'talabat_order'/.test(SQL_CODE), "the movement reason must be the 'sale' contract");
  // only the safe internal order id + ids/quantity are in details — no raw/customer/phone
  assert.match(SQL_CODE, /'orderId', p_order_id/);
  assert.ok(!/customer|phone|address|p_resolution\b/i.test(SQL_CODE.match(/insert into malak_audit[\s\S]*?'done'\);/g)?.join("\n") ?? ""));
});

test("5-sql: NULL / negative stock → inventory_inconsistent (no coalesce-to-0 masking)", () => {
  assert.ok((SQL_CODE.match(/v_avail_raw is null or v_avail_raw < 0/g) ?? []).length >= 2); // both branches
  assert.match(SQL_CODE, /v_fail := 'inventory_inconsistent'/);
});

test("5b-sql: a negative / NULL shelf quantity → inventory_inconsistent", () => {
  assert.match(SQL_CODE, /shelf_stock where inventory_id = v_inv_id and \(quantity is null or quantity < 0\)/i);
  assert.match(SQL_CODE, /variant_shelf_stock where variant_id = v_variant_id and \(quantity is null or quantity < 0\)/i);
});

test("6c: EVERY critical UPDATE checks the affected row count (>= 6 checks)", () => {
  const checks = (SQL_CODE.match(/get diagnostics v_rows = row_count/gi) ?? []).length;
  assert.ok(checks >= 6, `expected >=6 row-count checks, found ${checks}`);
});

test("6d: the shelf spread must place the whole quantity (v_rem = 0) or roll back", () => {
  assert.ok((SQL_CODE.match(/v_rem <> 0 then raise exception/gi) ?? []).length >= 2);
});

test("7b: the parent-inventory rollup update is row-count checked (exactly one row)", () => {
  assert.match(SQL_CODE, /update inventory\s*\n\s*set stock_quantity = v_sum[\s\S]{0,220}?get diagnostics v_rows = row_count[\s\S]{0,60}?v_rows <> 1 then raise exception/i);
});

test("7c: the final processed update is row-count checked", () => {
  assert.match(SQL_CODE, /processing_status = 'processed'[\s\S]{0,240}?get diagnostics v_rows = row_count[\s\S]{0,60}?v_rows <> 1 then raise exception/i);
});

test("9-deep: the resolution is rebuilt element-by-element, never copied through", () => {
  assert.match(SQL_CODE, /'lines',\s*v_lines/);
  assert.match(SQL_CODE, /'targets',\s*v_targets/);
  assert.match(SQL_CODE, /'reasons',\s*v_reasons/);
  // v_safe must NOT copy p_resolution collections directly
  assert.ok(!/'lines',\s*p_resolution -> 'lines'/.test(SQL_CODE), "lines must not be copied raw");
  assert.ok(!/'targets',\s*p_resolution -> 'targets'/.test(SQL_CODE), "targets must not be copied raw");
  // nested line target is projected to id + variant only (type-guarded)
  assert.match(SQL_CODE, /jsonb_typeof\(e #> '\{target,masterProductId\}'\) = 'string'/);
  // nested lineKeys inside a target keep only string elements
  assert.match(SQL_CODE, /where jsonb_typeof\(y\) = 'string'/);
});

test("1-scalar-sql: every whitelisted scalar field is type-guarded (a nested object in an allowed key's value is dropped)", () => {
  // string scalars are kept only when jsonb_typeof = 'string'
  assert.match(SQL_CODE, /'lineKey',\s*case when jsonb_typeof\(e -> 'lineKey'\) = 'string'/);
  assert.match(SQL_CODE, /'status',\s*case when jsonb_typeof\(e -> 'status'\)\s*= 'string'/);
  assert.match(SQL_CODE, /'via',\s*case when jsonb_typeof\(e -> 'via'\)\s*= 'string'/);
  // quantity kept only when it is a positive-integer NUMBER
  assert.match(SQL_CODE, /'quantity', case when jsonb_typeof\(e -> 'quantity'\) = 'number' and \(e ->> 'quantity'\) ~ '\^\[1-9\]\[0-9\]\*\$'/);
  // top-level reason/via/method kept only when string (never a number/object)
  assert.match(SQL_CODE, /'reason',\s*case when jsonb_typeof\(p_resolution -> 'reason'\)\s*= 'string'/);
  // no scalar is copied through unguarded — 'lineKey' is always followed by a case guard, never a bare `e -> 'lineKey'`
  assert.ok(!/'lineKey',\s*e -> 'lineKey'/.test(SQL_CODE), "lineKey must be type-guarded, not copied raw");
});

test("6: the plan is aggregated by (product, variant) before pass 1/2", () => {
  assert.match(SQL_CODE, /jsonb_agg/i);
  assert.match(SQL_CODE, /group by 1, 2/i);
});

test("6b: each UPDATE checks the affected row count (rollback on mismatch)", () => {
  assert.match(SQL_CODE, /get diagnostics\s+v_rows\s*=\s*row_count/i);
  assert.match(SQL_CODE, /v_rows\s*<>\s*1/);
});

test("7: RPC inventory invariants (exactly one variant / one inventory; no variants for no-variant target)", () => {
  assert.match(SQL_CODE, /count\(\*\)[^;]*from product_variants where parent_product_id = v_pid and sku = v_vsku/is);
  assert.match(SQL_CODE, /count\(\*\)[^;]*from inventory where product_id = v_pid/is);
  assert.match(SQL_CODE, /count\(\*\)[^;]*from product_variants where parent_product_id = v_pid;/is);
  assert.match(SQL_CODE, /v_cnt <> 1/);
  assert.match(SQL_CODE, /v_cnt <> 0/);
});

test("19: underflow is a verified RAISE, not hidden by greatest()", () => {
  assert.ok(!/greatest\(/i.test(SQL_CODE), "must not use greatest() to hide an underflow");
  assert.match(SQL_CODE, /if v_after < 0 then raise exception/i);
});

test("22: rollup uses SUM of variants, never max(), and NEVER an inner coalesce on variant stock", () => {
  assert.match(SQL_CODE, /coalesce\(sum\(stock_quantity\), 0\)/i);         // outer coalesce for empty set only
  assert.ok(!/sum\(coalesce\(stock_quantity/i.test(SQL_CODE), "must not coalesce variant stock inside SUM");
  assert.ok(!/\bmax\(/i.test(SQL_CODE));
});

test("26: records a stock movement in the ledger (malak_audit), never a stock_movements table", () => {
  assert.ok((SQL_CODE.match(/insert into malak_audit/gi) ?? []).length >= 2);
  assert.match(SQL_CODE, /'stock_out'/);
});

test("27: never adds channel_stock", () => {
  assert.ok(!/channel_stock/i.test(SQL_CODE));
});

test("28: SECURITY DEFINER, pinned search_path, not callable by anon/authenticated, no dynamic SQL", () => {
  assert.match(SQL_CODE, /security definer/i);
  assert.match(SQL_CODE, /set search_path = public/i);
  assert.match(SQL_CODE, /revoke all on function[^;]*from public/i);
  assert.match(SQL_CODE, /revoke all on function[^;]*from anon/i);
  assert.match(SQL_CODE, /revoke all on function[^;]*from authenticated/i);
  assert.match(SQL_CODE, /grant execute on function[^;]*to service_role/i);
  assert.ok(!/execute\s+format/i.test(SQL_CODE) && !/execute\s+'/i.test(SQL_CODE));
});

test("9: resolution is whitelisted — p_resolution is never stored raw, no SQLERRM", () => {
  assert.match(SQL_CODE, /v_safe := jsonb_strip_nulls\(jsonb_build_object/);
  assert.ok(!/resolution\s*=\s*p_resolution\b/.test(SQL_CODE), "must not store p_resolution raw");
  assert.ok(!/resolution\s*=\s*coalesce\(p_resolution/.test(SQL_CODE));
  assert.ok(!/sqlerrm/i.test(SQL_CODE));
});

test("10: the audit insert matches the real malak_audit schema", () => {
  const schema = read("supabase/malak_audit.sql");
  // columns declared by the table
  const tableCols = new Set(
    [...schema.matchAll(/^\s*(id|created_at|action_type|agent|sku|product_id|field|old_value|new_value|details|status)\b/gim)].map((m) => m[1].toLowerCase()),
  );
  for (const c of ["action_type", "agent", "sku", "product_id", "field", "old_value", "new_value", "details", "status"]) {
    assert.ok(tableCols.has(c), `malak_audit must declare ${c}`);
  }
  // every column the RPC inserts must exist in the table
  const m = SQL_CODE.match(/insert into malak_audit \(([^)]*)\)/i);
  assert.ok(m, "RPC inserts into malak_audit");
  for (const col of m![1].split(",").map((s) => s.trim().toLowerCase())) {
    assert.ok(tableCols.has(col), `inserted column ${col} not in malak_audit`);
  }
  // the values used (action_type 'stock_out', status 'done') match the existing ledger writer
  const mv = read("lib/inventory/movements.ts");
  assert.match(mv, /"stock_out"/);
  assert.match(mv, /status:\s*"done"/);
});

test("31: the Talabat webhook is unchanged (does not import the new resolution code)", () => {
  const wh = read("app/api/webhooks/talabat/[token]/route.ts");
  assert.ok(!/order-resolver|deduction-plan|order-lines|process_talabat_order_deduction/.test(wh));
  assert.match(wh, /talabat_orders/);
});

test("32: the Shopify deduction workflow is unchanged", () => {
  const shop = read("lib/shopify/order-deduct-compute.ts");
  assert.match(shop, /planOrderDeductions/);
  assert.ok(!/talabat/i.test(shop));
});

test("30: the new modules are pure — no Supabase / network / server-only", () => {
  for (const rel of ["lib/talabat/order-resolver.ts", "lib/talabat/deduction-plan.ts"]) {
    const src = read(rel).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/supabase/i.test(src) && !/\bfetch\(/.test(src) && !/from ["']server-only["']/.test(src) && !/https?:\/\//.test(src), `${rel} impure`);
  }
  // order-lines uses node:crypto (SHA-256) — allowed — but never network/supabase.
  const ol = read("lib/talabat/order-lines.ts").replace(/\/\/.*$/gm, "");
  assert.ok(!/supabase/i.test(ol) && !/\bfetch\(/.test(ol) && !/https?:\/\//.test(ol));
});
