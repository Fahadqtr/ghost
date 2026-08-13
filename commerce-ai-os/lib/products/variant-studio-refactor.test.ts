// UX.4E-4 consolidation guard + regression suite. Proves the unified
// VariantStudio (with the shared VariantRow) is the SINGLE composition root for
// variant editing UI in both V2 editors, that the per-editor duplicated
// composition + row markup did NOT survive, that VariantStudio/VariantRow carry
// no business logic, and that the legitimate create/edit differences (row field
// sets, id numbering, AI-suggestions being Edit-only, create renumber vs edit
// no-renumber, unchanged save payload) are preserved exactly.
//
// PURE: no DB, no network, no React — it reads component/source text and runs
// small transcribed oracles. No runtime import of the "use client" .tsx files.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/variant-studio-refactor.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  makeVariantRow,
  removeVariantRow,
  activeVariantCount,
  type VariantRowModel,
} from "./variant-model.ts";
import { buildVariantInputs } from "./edit-form-state.ts";

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}
const CREATE = src("../../components/v2/catalog/AiProductCreator.tsx");
const EDIT = src("../../components/v2/catalog/ProductEditForm.tsx");
const STUDIO = src("../../components/v2/catalog/VariantStudio.tsx");
const ROW = src("../../components/v2/catalog/VariantRow.tsx");

// ── 1. Both editors mount the unified studio ─────────────────────────────────

test("Create mounts VariantStudio in create mode", () => {
  assert.ok(CREATE.includes('from "@/components/v2/catalog/VariantStudio"'), "imports VariantStudio");
  assert.ok(CREATE.includes("<VariantStudio"), "renders VariantStudio");
  assert.ok(CREATE.includes('mode="create"'), "passes mode=create");
});

test("Edit mounts VariantStudio in edit mode", () => {
  assert.ok(EDIT.includes('from "@/components/v2/catalog/VariantStudio"'), "imports VariantStudio");
  assert.ok(EDIT.includes("<VariantStudio"), "renders VariantStudio");
  assert.ok(EDIT.includes('mode="edit"'), "passes mode=edit");
});

// ── 2. No duplicated composition survives in either parent ────────────────────
// The four shared sub-panels + the shared row are composed ONCE, inside the
// studio. A parent that still imports/mounts them itself would be the very
// duplication this phase removes.

test("neither parent still composes the variant sub-panels or per-row markup", () => {
  const banned = [
    // sub-panels — now composed only inside VariantStudio
    "VariantIdentityToolbar",
    "VariantBulkTools",
    "VariantCompleteness",
    // per-row markup / wiring — now only inside VariantRow / VariantStudio
    'aria-label="تحديد الصف"', // selection checkbox
    "VARIANT_FIELD_DEFS", // per-row field definition list
    "payloadIndexByKey", // field-id numbering
    "create-variant-$", // per-row field id construction
    "edit-variant-$",
    "حذف الخيار", // remove-row button label
    "+ إضافة خيار", // add-row button label (now the studio header)
  ];
  for (const [name, code] of [["create", CREATE], ["edit", EDIT]] as const) {
    for (const token of banned) {
      assert.equal(code.includes(token), false, `${name} must not still contain ${JSON.stringify(token)}`);
    }
  }
});

// ── 3. AI variant suggestions stay Edit-only ─────────────────────────────────

test("AI variant suggestions are Edit-only — Create neither mounts nor enables them", () => {
  assert.equal(CREATE.includes("VariantAISuggestions"), false, "create must not import the AI suggestions panel");
  assert.equal(CREATE.includes("allowAiSuggestions"), false, "create must not enable the AI suggestions capability");
  assert.equal(CREATE.includes("onAddAiSuggestions"), false, "create must not wire AI suggestions");
});

test("Edit enables the AI-suggestions capability on the studio", () => {
  assert.ok(EDIT.includes("allowAiSuggestions"), "edit passes allowAiSuggestions");
  assert.ok(EDIT.includes("onAddAiSuggestions"), "edit wires onAddAiSuggestions");
  assert.ok(EDIT.includes("addAiSuggestions"), "edit keeps its append-new AI handler");
});

test("the studio gates AI suggestions behind the capability prop (never Create by default)", () => {
  assert.ok(STUDIO.includes("VariantAISuggestions"), "studio composes the AI panel");
  assert.ok(
    STUDIO.includes("allowAiSuggestions && onAddAiSuggestions"),
    "studio only mounts AI suggestions when the capability is enabled AND a handler is provided",
  );
  assert.ok(STUDIO.includes("allowAiSuggestions = false"), "the AI capability defaults OFF");
});

// ── 4. The studio composes the shared pieces (single composition root) ────────

test("VariantStudio composes every shared variant piece", () => {
  for (const piece of [
    "VariantIdentityToolbar",
    "VariantBulkTools",
    "VariantAISuggestions",
    "VariantCompleteness",
    "VariantRow",
  ]) {
    assert.ok(STUDIO.includes(piece), `studio composes ${piece}`);
  }
});

// ── 5. No business logic leaks into the presentational studio / row ───────────
// Renumbering, identity generation, bulk transforms, payload building, validation,
// and server access all stay in the parents / pure layers / hook.

test("VariantStudio owns NO business logic (composition only)", () => {
  const banned = [
    'from "@/lib/products/variant-bulk"',
    'from "@/lib/products/sku-generate"',
    'from "@/lib/products/identity-fill"',
    'from "@/lib/products/edit-form-state"',
    'from "@/lib/products/edit-validation"',
    'from "@/lib/products/create-validation"',
    "loadCatalogIdentity",
    "renumberVariantRowSkus",
    "renumberVariantSkus",
    "buildVariantInputs",
    "analyzeAiProductImage",
    "prepareAiProduct",
    "refreshIdentity",
    "/actions", // no server-action import of any kind
  ];
  for (const token of banned) {
    assert.equal(STUDIO.includes(token), false, `studio must not contain business token ${JSON.stringify(token)}`);
  }
});

test("VariantRow is presentational only (imports types, no logic/IO)", () => {
  // The only import is the row-model TYPES; no pure transforms, no server, no hook.
  const banned = [
    'from "@/lib/products/variant-bulk"',
    'from "@/lib/products/sku-generate"',
    'from "@/lib/products/identity-fill"',
    'from "@/lib/products/variant-validate"',
    "useVariantIdentity",
    "buildVariantInputs",
    "/actions",
  ];
  for (const token of banned) {
    assert.equal(ROW.includes(token), false, `row must not contain ${JSON.stringify(token)}`);
  }
  assert.ok(ROW.includes('import type { VariantFieldKey, VariantRowModel } from "@/lib/products/variant-model"'),
    "row imports only the row-model types");
});

// ── 6. Create renumber vs Edit no-renumber is preserved on the parent side ─────

test("Create keeps its main-SKU renumber of new variant SKUs", () => {
  // create injects onMainSkuChange (renumbers rows to the new prefix) as setMainSku
  assert.ok(CREATE.includes("renumberVariantRowSkus"), "create still renumbers via the shared transform");
  assert.ok(CREATE.includes("setMainSku: onMainSkuChange"), "create injects the renumbering setMainSku");
  assert.ok(CREATE.includes("renumber(rs, value)"), "onMainSkuChange renumbers rows on a valid main SKU");
});

test("Edit never renumbers a persisted identity", () => {
  assert.equal(EDIT.includes("renumberVariantRowSkus"), false, "edit must not renumber rows");
  assert.equal(EDIT.includes("renumberVariantSkus"), false, "edit must not renumber SKUs");
  assert.ok(EDIT.includes('setMainSku: (value) => setScalar("sku", value)'), "edit writes the main SKU as a plain scalar");
});

// ── 7. Save payloads are unchanged (still the shared builder over the rows) ────

test("both parents still build the save payload via the shared buildVariantInputs(rows)", () => {
  assert.ok(CREATE.includes("variants: buildVariantInputs(rows)"), "create payload unchanged");
  assert.ok(EDIT.includes("variants: buildVariantInputs(rows)"), "edit payload unchanged");
});

// buildVariantInputs is unchanged by this phase: new (id null) rows emit no id,
// existing rows keep their uuid, removed rows are omitted. (Behavioral anchor.)
test("buildVariantInputs still drops removed rows and preserves ids", () => {
  const rows: VariantRowModel[] = [
    makeVariantRow("k0", { id: "u1", fields: { variant_name: "أحمر", sku: "mk9-1" } }),
    makeVariantRow("k1", { id: null, fields: { variant_name: "جديد", sku: "" } }),
  ];
  const withRemoved = removeVariantRow(
    [...rows, makeVariantRow("k2", { id: "u3", fields: { variant_name: "أزرق" } })],
    "k2",
  );
  const out = buildVariantInputs(withRemoved);
  assert.equal(out.length, 2, "removed existing row is omitted");
  assert.equal(out[0].id, "u1", "existing row keeps its uuid");
  assert.equal("id" in out[1], false, "new row sends no id");
});

// ── 8. Field-id numbering contract (validation focus) is preserved ────────────
// The studio numbers field ids by PAYLOAD index (position among non-removed
// rows), which for Create (no removed rows) is exactly the array index — the same
// numbering both editors used before. Transcribed oracle over the studio rule.

function payloadIndexMap(rows: readonly VariantRowModel[]): Map<string, number> {
  const m = new Map<string, number>();
  let pi = 0;
  for (const r of rows) if (!r.removed) m.set(r.key, pi++);
  return m;
}

test("Create field-id numbering equals the array index (no removed rows)", () => {
  const createRows = [
    makeVariantRow("a", { id: null }),
    makeVariantRow("b", { id: null }),
    makeVariantRow("c", { id: null }),
  ];
  const m = payloadIndexMap(createRows);
  createRows.forEach((r, i) => assert.equal(m.get(r.key), i, `row ${r.key} numbered by array index`));
});

test("Edit field-id numbering skips soft-removed rows (payload index)", () => {
  const editRows = removeVariantRow(
    [
      makeVariantRow("a", { id: "u1" }),
      makeVariantRow("b", { id: "u2" }),
      makeVariantRow("c", { id: "u3" }),
    ],
    "b", // soft-remove the middle existing row
  );
  const m = payloadIndexMap(editRows);
  assert.equal(m.get("a"), 0, "first active row → 0");
  assert.equal(m.has("b"), false, "removed row has no payload index");
  assert.equal(m.get("c"), 1, "row after the removed one → 1 (not 2)");
});

// ── 9. Displayed variant count is unchanged (active rows) ─────────────────────
// Create rows are never soft-removed, so activeVariantCount === rows.length there
// (its old header count); Edit shows the active count (its old header count).

test("studio header count uses activeVariantCount for both modes", () => {
  assert.ok(STUDIO.includes("activeVariantCount(rows)"), "studio derives the header count from active rows");
  // create parity: no removed rows ⇒ active count == total rows (old create header)
  const createRows = [makeVariantRow("a", { id: null }), makeVariantRow("b", { id: null })];
  assert.equal(activeVariantCount(createRows), createRows.length);
  // edit parity: removed rows are excluded (old edit header)
  const editRows = removeVariantRow([makeVariantRow("a", { id: "u1" }), makeVariantRow("b", { id: "u2" })], "b");
  assert.equal(activeVariantCount(editRows), 1);
});

// ── 10. Row field sets match the OLD inline definitions exactly ────────────────
// The two parents' pre-consolidation field lists moved into the studio verbatim.
// Assert order + labels + editability over the studio source.

function block(source: string, from: string, to: string): string {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `source block ${from}..${to} present`);
  return source.slice(a, b);
}

test("CREATE_ROW_FIELDS matches the old create inline field list (order, labels, readonly SKU last)", () => {
  const blk = block(STUDIO, "CREATE_ROW_FIELDS", "EDIT_ROW_FIELDS");
  const expected: Array<[string, string]> = [
    ["variant_name", "اسم الخيار (عربي)"],
    ["variant_name_en", "اسم الخيار (إنجليزي)"],
    ["color", "اللون"],
    ["size", "الحجم"],
    ["price", "السعر (ر.ق)"],
    ["stock_quantity", "الكمية"],
    ["barcode", "الباركود (EAN-13)"],
    ["sku", "SKU الخيار (تلقائي)"],
  ];
  let cursor = -1;
  for (const [key, label] of expected) {
    const idx = blk.indexOf(`key: "${key}"`);
    assert.ok(idx > cursor, `create field ${key} present and after the previous one`);
    assert.ok(blk.includes(label), `create field ${key} keeps label ${label}`);
    cursor = idx;
  }
  // SKU is the read-only auto field (create never hand-edits it).
  assert.ok(/key: "sku", label: "SKU الخيار \(تلقائي\)", dir: "ltr", readOnly: true/.test(blk),
    "create SKU field is read-only");
  // create barcode is editable (NOT read-only)
  assert.equal(/key: "barcode"[^\n]*readOnly/.test(blk), false, "create barcode stays editable");
});

test("EDIT_ROW_FIELDS matches the old VARIANT_FIELD_DEFS (order, labels, editable SKU, decimal price/stock)", () => {
  const blk = block(STUDIO, "EDIT_ROW_FIELDS", "VariantStudioBulkHandlers");
  const expected: Array<[string, string]> = [
    ["variant_name", "اسم الخيار (عربي)"],
    ["variant_name_en", "اسم الخيار (إنجليزي)"],
    ["sku", "SKU"],
    ["barcode", "الباركود"],
    ["color", "اللون"],
    ["size", "الحجم"],
    ["price", "السعر (ر.ق)"],
    ["stock_quantity", "الكمية"],
  ];
  let cursor = -1;
  for (const [key, label] of expected) {
    const idx = blk.indexOf(`key: "${key}"`);
    assert.ok(idx > cursor, `edit field ${key} present and after the previous one`);
    assert.ok(blk.includes(label), `edit field ${key} keeps label ${label}`);
    cursor = idx;
  }
  // edit SKU is editable (no readOnly), price/stock hint the decimal keypad.
  assert.equal(/key: "sku"[^\n]*readOnly/.test(blk), false, "edit SKU stays editable");
  assert.ok(/key: "price"[^\n]*inputMode: "decimal"/.test(blk), "edit price hints decimal");
  assert.ok(/key: "stock_quantity"[^\n]*inputMode: "decimal"/.test(blk), "edit stock hints decimal");
});

// ── 11. Selection stays keyed by stable row key (never array index) ───────────

test("both parents drive selection by stable row key and inject it into the studio", () => {
  for (const [name, code] of [["create", CREATE], ["edit", EDIT]] as const) {
    assert.ok(code.includes("selectedKeys={selectedKeys}"), `${name} passes the selection set`);
    assert.ok(code.includes("onToggleSelect={toggleSelected}"), `${name} passes the toggle handler`);
    assert.ok(code.includes("setSelectedKeys((prev)"), `${name} toggles by key in a Set`);
  }
  assert.ok(STUDIO.includes("selectedKeys.has(row.key)"), "studio selects by row key");
  assert.ok(STUDIO.includes("onToggleSelect(row.key)"), "studio toggles by row key");
});

// ── 12. Create/Edit capability wiring differences are explicit ────────────────

test("Create disables the studio while busy; Edit soft-delete/restore is Edit-only", () => {
  assert.ok(CREATE.includes("disabled={busy}"), "create gates the studio on its busy flag");
  assert.ok(CREATE.includes("canRestore: false"), "create cannot restore (new rows just drop)");
  assert.equal(CREATE.includes("onRestoreRow"), false, "create injects no restore handler");

  assert.ok(EDIT.includes("onRestoreRow={restoreRow}"), "edit injects the soft-delete undo");
  assert.ok(EDIT.includes("canRestore: rows.some((r) => r.removed)"), "edit can restore when a row is removed");
});
