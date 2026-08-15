// Phase UI.4 — V2 Product Editor: read-loader behaviour + page/action/form
// safety scans. Runtime tests use a scripted fake client; the .tsx files are
// verified by source scan (node cannot execute .tsx), same as the other V2
// page suites.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-editor-page.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadProductForEdit, toEditBrands, toEditInitial } from "./product-edit-read.ts";

const EDIT_PAGE_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/edit/page.tsx", import.meta.url), "utf8");
const EDIT_ACTIONS_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/edit/actions.ts", import.meta.url), "utf8");
const EDIT_LOADING_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/edit/loading.tsx", import.meta.url), "utf8");
const FORM_SRC = readFileSync(new URL("../../components/v2/catalog/ProductEditForm.tsx", import.meta.url), "utf8");
const DETAIL_PAGE_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/page.tsx", import.meta.url), "utf8");
const DETAIL_COMPONENT_SRC = readFileSync(new URL("../../components/v2/catalog/ProductDetail.tsx", import.meta.url), "utf8");
const LEGACY_ACTIONS_SRC = readFileSync(new URL("../../app/(app)/products/actions.ts", import.meta.url), "utf8");

// ── read loader (runtime, fake client) ───────────────────────────────────────

function makeReadClient(over: Record<string, unknown> = {}) {
  const o = {
    product: {
      data: { id: "p1", name_ar: "سيروم", price: 120, sku: null } as Record<string, unknown> | null,
      error: null as unknown,
    },
    variants: { data: [{ id: "va", variant_name: "وردي", price: 35 }] as unknown[] | null, error: null as unknown },
    brands: { data: [{ id: "b1", name: "Cosrx" }] as unknown[] | null, error: null as unknown },
    ...over,
  };
  const client = {
    from(_table: string) {
      return {
        select(_c: string) {
          return {
            filter(_col: string, _op: string, _val: string) {
              return {
                maybeSingle: () => Promise.resolve(o.product),
                limit: (_n: number) => ({
                  order: (_col2: string, _opts: { ascending: boolean }) => Promise.resolve(o.variants),
                }),
              };
            },
            order: (_col: string, _opts: { ascending: boolean }) => Promise.resolve(o.brands),
          };
        },
      };
    },
  };
  return client;
}

test("loadProductForEdit: projects the row into the string form shape and keeps variant ids verbatim", async () => {
  const res = await loadProductForEdit(makeReadClient(), "p1");
  assert.equal(res.status, "ok");
  if (res.status === "ok") {
    assert.equal(res.initial.name_ar, "سيروم");
    assert.equal(res.initial.price, "120");
    assert.equal(res.initial.sku, "");
    assert.equal(res.initial.variants[0].id, "va");
    assert.equal(res.initial.variants[0].price, "35");
    assert.deepEqual(res.brands, [{ id: "b1", name: "Cosrx" }]);
  }
});

test("loadProductForEdit: missing product → notfound; read failure → error (no throw, no raw text)", async () => {
  assert.equal((await loadProductForEdit(makeReadClient({ product: { data: null, error: null } }), "p1")).status, "notfound");
  assert.equal((await loadProductForEdit(makeReadClient({ product: { data: null, error: { message: "boom" } } }), "p1")).status, "error");
  assert.equal((await loadProductForEdit(makeReadClient({ variants: { data: null, error: { message: "boom" } } }), "p1")).status, "error");
});

test("loadProductForEdit: a brands failure degrades to an empty list instead of blocking the editor", async () => {
  const res = await loadProductForEdit(makeReadClient({ brands: { data: null, error: { message: "boom" } } }), "p1");
  assert.equal(res.status, "ok");
  if (res.status === "ok") assert.deepEqual(res.brands, []);
});

test("toEditInitial: variant rows without a string id are dropped, never invented", () => {
  const initial = toEditInitial({ name_ar: "x" }, [{ id: "va" }, { id: 7 }, {}]);
  assert.deepEqual(initial.variants.map((v) => v.id), ["va"]);
});

test("toEditBrands: malformed brand rows are dropped", () => {
  assert.deepEqual(toEditBrands([{ id: "b1", name: "Cosrx" }, { id: 3, name: "x" }, "junk", null]), [
    { id: "b1", name: "Cosrx" },
  ]);
});

// ── edit page source scan ────────────────────────────────────────────────────

test("edit page: V2 pattern — force-dynamic, session client, validated controls, safe states", () => {
  assert.ok(EDIT_PAGE_SRC.includes('export const dynamic = "force-dynamic"'), "force-dynamic");
  assert.ok(EDIT_PAGE_SRC.includes('from "@/lib/supabase/server"'), "session client import");
  assert.ok(EDIT_PAGE_SRC.includes("loadProductForEdit"), "whitelisted loader");
  assert.ok(EDIT_PAGE_SRC.includes("parseCatalogControls"), "controls parsed, never reflected raw");
  assert.ok(EDIT_PAGE_SRC.includes("parseProductId"), "id validated");
  assert.ok(EDIT_PAGE_SRC.includes("catalogDetailHref"), "cancel href rebuilt from validated controls");
  assert.ok(EDIT_PAGE_SRC.includes("EDIT_MESSAGES.load_failed"), "fixed load-error message");
  assert.ok(EDIT_PAGE_SRC.includes("EDIT_MESSAGES.not_found"), "fixed not-found message");
});

test("edit page: never uses the admin client, raw errors, or direct rpc", () => {
  for (const banned of ["createAdminClient", "service_role", "SUPABASE_SERVICE_ROLE", ".rpc(", "console.log"]) {
    assert.ok(!EDIT_PAGE_SRC.includes(banned), `edit page must not contain ${banned}`);
  }
});

test("edit loading state exists for the editor route only", () => {
  assert.ok(EDIT_LOADING_SRC.includes("animate-pulse"), "skeleton");
  assert.ok(EDIT_LOADING_SRC.includes("جارٍ تحميل بيانات المنتج"), "Arabic loading text");
});

// ── save action source scan ──────────────────────────────────────────────────

test("save action: thin shell over the shared core with auth, validation, fixed messages", () => {
  assert.ok(EDIT_ACTIONS_SRC.startsWith('"use server"'), "use server");
  assert.ok(EDIT_ACTIONS_SRC.includes("requireMalakWriter"), "auth gate — writer allow-list (CH.3b)");
  assert.ok(EDIT_ACTIONS_SRC.includes("validateProductEditInput"), "server-side validation");
  assert.ok(EDIT_ACTIONS_SRC.includes("updateProductCore"), "shared save core — no parallel write path");
  assert.ok(EDIT_ACTIONS_SRC.includes("editFailureMessage"), "fixed Arabic mapping");
  assert.ok(EDIT_ACTIONS_SRC.includes("parseProductId"), "id validated");
  assert.ok(EDIT_ACTIONS_SRC.includes("parseCatalogControls"), "redirect target rebuilt from validated controls");
  assert.ok(EDIT_ACTIONS_SRC.includes('revalidatePath("/v2/catalog")'), "list revalidated");
  assert.ok(EDIT_ACTIONS_SRC.includes("saved=1"), "success signal for the detail banner");
});

test("save action: metadata on the SESSION client; admin backs the Inventory adapter + the atomic variant sync (INV.6B)", () => {
  // The action itself makes no direct RPC, never surfaces a raw DB message, never logs,
  // and embeds no service-role KEY/env reference.
  for (const banned of ["service_role", "SUPABASE_SERVICE_ROLE", ".rpc(", "error.message", "console.log"]) {
    assert.ok(!EDIT_ACTIONS_SRC.includes(banned), `save action must not contain ${banned}`);
  }
  // Product METADATA runs on the SESSION client through the shared core (RLS applies)
  // — the session client is the first arg.
  assert.ok(/updateProductCore\(\s*supabase,/.test(EDIT_ACTIONS_SRC), "core receives the session client for metadata");
  // The admin/service-role client backs ONLY the two numeric/structural writes that
  // are admin-only after the INV.6B lockdown: the Inventory Engine adapter and the
  // atomic variant-sync RPC — never the product-metadata write.
  assert.ok(EDIT_ACTIONS_SRC.includes("createInventoryAdapter(admin)"), "admin backs the inventory adapter");
  assert.ok(/variantSyncClient:\s*admin/.test(EDIT_ACTIONS_SRC), "admin (service-role) backs the atomic variant sync");
});

// ── form source scan ─────────────────────────────────────────────────────────

test("form: client component wired to the tested state helpers and validation", () => {
  assert.ok(FORM_SRC.startsWith('"use client"'), "client component");
  assert.ok(FORM_SRC.includes("buildVariantInputs"), "payload built by the tested helper");
  assert.ok(FORM_SRC.includes("toVariantRows"), "rows built by the tested helper");
  assert.ok(FORM_SRC.includes("validateProductEditInput"), "pre-submit validation");
  assert.ok(FORM_SRC.includes("saveProductEdit"), "single server action");
  assert.ok(FORM_SRC.includes("disabled={pending}"), "double-submit guard");
  assert.ok(FORM_SRC.includes("beforeunload"), "unsaved-changes guard");
  assert.ok(FORM_SRC.includes('role="alert"'), "accessible error banner");
  // Undo-before-save for removed variants: the form injects the restore handler
  // into the unified VariantStudio (UX.4E-4); the "تراجع" control itself lives in
  // the shared VariantRow the studio renders.
  assert.ok(FORM_SRC.includes("onRestoreRow={restoreRow}"), "form wires undo before save for removed variants");
});

test("form: no client-side uuids, no direct Supabase access, no window.alert", () => {
  for (const banned of [
    "randomUUID",
    "crypto.",
    "window.alert",
    "@/lib/supabase",
    "@supabase/",
    "createAdminClient",
    "gid://",
    "shopifyInventoryItemId",
  ]) {
    assert.ok(!FORM_SRC.includes(banned), `form must not contain ${banned}`);
  }
});

// ── detail page integration ──────────────────────────────────────────────────

test("detail page: builds the edit href from validated controls and shows the fixed saved banner", () => {
  assert.ok(DETAIL_PAGE_SRC.includes("catalogEditHref"), "edit href helper");
  assert.ok(DETAIL_PAGE_SRC.includes('sp.saved === "1"'), "strict literal saved check");
  assert.ok(DETAIL_PAGE_SRC.includes("تم حفظ التغييرات."), "fixed saved banner");
});

test("detail component: renders the edit button only when an href is provided", () => {
  assert.ok(DETAIL_COMPONENT_SRC.includes("تعديل المنتج"), "edit button label");
  assert.ok(DETAIL_COMPONENT_SRC.includes("editHref"), "prop-driven");
});

// ── the one write path lives in the V2 edit action + shared core ─────────────
// The legacy updateProduct action was deleted in UX.4E-9C; the id-preserving,
// no-blanket-delete write path now belongs entirely to the V2 edit action and
// the shared updateProductCore. Prove the live action stays on that core, and
// that the legacy create/edit actions are truly gone from the actions file.

test("V2 edit action: wired to the shared core (one write path, no drift)", () => {
  assert.ok(EDIT_ACTIONS_SRC.includes("updateProductCore"), "V2 edit uses the shared core");
  assert.ok(
    !EDIT_ACTIONS_SRC.includes('.from("product_variants")\n    .delete()'),
    "no blanket variant delete in the V2 edit action",
  );
});

test("legacy create/edit actions no longer exist in the actions file", () => {
  for (const sym of ["createProduct", "updateProduct", "nextProductSku"]) {
    assert.equal(
      new RegExp(`export\\s+async\\s+function\\s+${sym}\\b`).test(LEGACY_ACTIONS_SRC),
      false,
      `${sym} removed`,
    );
  }
});
