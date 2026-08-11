// UX.4C-2 — Product media WRITES: source-scan guards for the edit-form editor,
// the thin server actions, and the V2 create gallery-persistence gap.
// The .tsx / server-action files can't run under node:test, so — like the other
// V2 page/action suites — they are verified by source scan. The pure reducer +
// reader behaviour (including delete-primary promotion inputs) is covered in
// product-media.test.ts.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-media-write.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

const ACTIONS = src("../../app/(v2)/v2/catalog/media-actions.ts");
const EDITOR = src("../../components/v2/catalog/ProductMediaEditor.tsx");
const FORM = src("../../components/v2/catalog/ProductEditForm.tsx");
const CREATE = src("../../app/(v2)/v2/catalog/new/actions.ts");
const DISPLAY = src("../../components/v2/catalog/ProductMedia.tsx");

// ── server actions: reuse existing cores, no new storage/DB sync ─────────────

test("media actions: thin server wrappers that REUSE the existing image cores", () => {
  assert.ok(ACTIONS.startsWith('"use server"'), "server actions");
  assert.ok(ACTIONS.includes("isSignedIn"), "auth gated");
  assert.ok(ACTIONS.includes("storePrimaryProductImage"), "upload reuses the imageStore core");
  assert.ok(ACTIONS.includes("removeProductImage"), "remove reuses the existing core");
  assert.ok(ACTIONS.includes("loadProductMedia"), "returns fresh state via the shared reader");
  assert.ok(ACTIONS.includes("export async function uploadProductMedia"), "upload/replace action");
  assert.ok(ACTIONS.includes("export async function removeProductMedia"), "remove action");
  assert.ok(ACTIONS.includes("parseProductId"), "product id validated");
});

test("media actions: no NEW storage/DB sync logic and no raw error pass-through", () => {
  // The action must not re-implement upload/sync — it delegates to the cores.
  for (const bad of [".storage", ".upload(", ".getPublicUrl(", ".insert(", ".update(", ".rpc("]) {
    assert.equal(ACTIONS.includes(bad), false, `action must not contain ${bad} (delegates to cores)`);
  }
  // Raw core errors are mapped to fixed Arabic messages, never surfaced.
  assert.ok(ACTIONS.includes("MEDIA_MESSAGES"), "fixed Arabic messages");
  assert.equal(ACTIONS.includes("r.error"), false, "never returns the core's raw error string");
});

test("media actions: writes stay server-side; MIME + size validated before the core", () => {
  assert.ok(ACTIONS.includes("createAdminClient"), "server-side admin for the storage write");
  assert.ok(ACTIONS.includes("ALLOWED_MEDIA"), "MIME whitelist");
  assert.ok(ACTIONS.includes("MAX_BYTES"), "size cap");
  assert.ok(ACTIONS.includes('revalidatePath(`/v2/catalog/'), "revalidates the V2 routes");
});

// ── editor component: upload / replace / delete, no client storage write ─────

test("editor: upload + replace + delete controls, confirm-before-delete", () => {
  assert.ok(EDITOR.startsWith('"use client"'), "client component");
  assert.ok(EDITOR.includes("uploadProductMedia"), "wired to the upload action");
  assert.ok(EDITOR.includes("removeProductMedia"), "wired to the remove action");
  assert.ok(EDITOR.includes("رفع صورة"), "upload label");
  assert.ok(EDITOR.includes("استبدال الصورة الرئيسية"), "replace label");
  assert.ok(EDITOR.includes("حذف الصورة الرئيسية"), "delete label");
  assert.ok(EDITOR.includes("window.confirm"), "confirm before delete");
  assert.ok(EDITOR.includes("<ProductMedia"), "reuses the read-only display");
  assert.ok(EDITOR.includes("URL.createObjectURL"), "local preview while uploading");
  assert.ok(EDITOR.includes("onChange(res.data)"), "reports fresh media state to the parent");
});

test("editor: NO direct client Storage/Supabase access, NO service role", () => {
  for (const bad of [
    ".storage", ".upload(", "@/lib/supabase", "@supabase/",
    "createClient", "createAdminClient", "SERVICE_ROLE",
  ]) {
    assert.equal(EDITOR.includes(bad), false, `editor must not contain ${bad}`);
  }
});

test("editor: no reorder and no manual set-primary for extra images (out of scope)", () => {
  for (const bad of ["reorder", "sort_order", "setPrimary", "set_primary", "is_primary"]) {
    assert.equal(EDITOR.includes(bad), false, `editor must not contain ${bad}`);
  }
});

test("editor + actions: no AI image logic introduced", () => {
  for (const s of [EDITOR, ACTIONS]) {
    for (const bad of ["editNewProductImage", "editProductImageCore", "OPENAI", "anthropic", "gpt-image"]) {
      assert.equal(s.includes(bad), false, `no AI logic (${bad})`);
    }
  }
});

// ── form integration: completeness syncs with the primary image ──────────────

test("form: media editor drives image_url so completeness updates immediately", () => {
  assert.ok(FORM.includes("ProductMediaEditor"), "renders the editor");
  assert.ok(FORM.includes("function applyMedia"), "media→scalars bridge");
  assert.ok(FORM.includes("image_url: next.primary?.url"), "syncs image_url from the new primary");
  assert.ok(FORM.includes("image_filename: next.primary?.filename"), "syncs image_filename");
  // completeness still derives hasImage from image_url — semantics unchanged.
  assert.ok(FORM.includes('hasImage: (scalars.image_url ?? "").trim() !== ""'), "completeness reads image_url");
});

// ── create gap: persist a product_images row, rollback-safe ──────────────────

test("create: persists a primary product_images row AFTER the product is committed", () => {
  assert.ok(CREATE.includes('.from("product_images")'), "writes the gallery row");
  assert.ok(CREATE.includes("is_primary: true"), "the create photo is primary");
  assert.ok(CREATE.includes("sort_order: 0"), "primary sort order");
  assert.ok(CREATE.includes("product_id: core.productId"), "uses the freshly-created product id");

  // Ordering / rollback safety: the gallery insert must come AFTER the core
  // success branch (so it can never orphan a row) and before the redirect, and
  // it must be best-effort (never returns an error / never blocks the redirect).
  const coreOk = CREATE.indexOf("if (!core.ok) {");
  const galleryInsert = CREATE.indexOf('.from("product_images")');
  const redirect = CREATE.lastIndexOf("redirect(`/v2/catalog/");
  assert.ok(coreOk >= 0 && galleryInsert > coreOk, "gallery insert is after the core-failure guard");
  assert.ok(redirect > galleryInsert, "redirect still happens after the gallery insert");
});

test("create: the gallery insert is best-effort (no new failure path, no orphan)", () => {
  // The insert is wrapped and only logs the filename on failure — it must not
  // introduce a new CREATE_MESSAGES error return between core success and redirect.
  const between = CREATE.slice(CREATE.indexOf('.from("product_images")'), CREATE.lastIndexOf("redirect(`/v2/catalog/"));
  assert.equal(/return \{ error:/.test(between), false, "gallery-insert failure never blocks the create");
  assert.ok(/console\.error\("\[ai-product-creator\] gallery row insert failed/.test(CREATE), "logs filename only on failure");
});

// ── shared contracts + no schema change ──────────────────────────────────────

test("display component stays read-only; controls arrive via the children slot", () => {
  // ProductMedia itself must not gain buttons/handlers — the editor supplies them.
  for (const bad of ["<button", "onClick", "uploadProductMedia", "removeProductMedia", "use client"]) {
    assert.equal(DISPLAY.includes(bad), false, `display must not contain ${bad}`);
  }
  assert.ok(DISPLAY.includes("children"), "renders the optional controls slot");
});

test("no schema change: media actions add no CREATE/ALTER TABLE", () => {
  assert.equal(/create\s+table|alter\s+table|drop\s+table/i.test(ACTIONS), false, "no DDL in the actions");
});
