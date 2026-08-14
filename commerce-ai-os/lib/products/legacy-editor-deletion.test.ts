// UX.4E-9C — legacy product editor retirement guards. The runtime migration
// (UX.4E-9A/9B) proved the legacy create/edit form and its actions were dead;
// this phase DELETES them and ports the last legacy-only UX (the barcode scanner
// Enter-flow) into the shared V2 studio. These guards prove the deletion is
// complete and the scanner lives in exactly ONE shared place.
//
// PURE — no DB, no network, no React. It reads source text, checks file
// existence, and imports only the framework-free middleware redirect helper.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/legacy-editor-deletion.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function runtimeFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true })) {
      const rel = join(dir, String(entry));
      if (!/\.(ts|tsx)$/.test(rel) || /\.test\.(ts|tsx)$/.test(rel)) continue;
      if (!statSync(join(ROOT, rel)).isFile()) continue;
      out.push(rel);
    }
  }
  return out;
}

const ACTIONS = "app/(app)/products/actions.ts";

// ── 1. The legacy editor file is gone ────────────────────────────────────────

test("components/ProductForm.tsx no longer exists", () => {
  assert.equal(existsSync(join(ROOT, "components/ProductForm.tsx")), false, "legacy editor deleted");
});

// ── 2. The legacy create/edit action exports are gone ────────────────────────
// The actions file itself survives — it still holds the approval/status/delete
// workflows — but the create/edit save actions are removed.

test("createProduct / updateProduct / nextProductSku are no longer exported", () => {
  const src = read(ACTIONS);
  for (const sym of ["createProduct", "updateProduct", "nextProductSku"]) {
    assert.equal(
      new RegExp(`export\\s+async\\s+function\\s+${sym}\\b`).test(src),
      false,
      `${sym} export removed`,
    );
  }
});

test("non-editor product workflows are retained in the actions file", () => {
  const src = read(ACTIONS);
  for (const sym of ["setProductApproval", "setProductStatus", "setProductsApproval", "deleteProduct", "createAddToPlatformTasks"]) {
    assert.ok(new RegExp(`export\\s+async\\s+function\\s+${sym}\\b`).test(src), `${sym} kept`);
  }
  // The shared input-shape types stay re-exported for those workflows/callers.
  assert.ok(/export type \{[^}]*ProductInput[^}]*\} from "@\/lib\/products\/product-save"/.test(src), "ProductInput re-export kept");
});

// ── 3. Nothing imports the deleted symbols or the deleted file ────────────────

test("no runtime source imports ProductForm or the deleted create/edit actions", () => {
  const banned = ["createProduct", "updateProduct", "nextProductSku"];
  const offenders: string[] = [];
  for (const rel of runtimeFiles(["app", "components"])) {
    if (rel === ACTIONS) continue; // the definitions module
    const src = read(rel);
    if (/from\s+["']@\/components\/ProductForm["']/.test(src)) offenders.push(`${rel} imports ProductForm`);
    const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@\/app\/\(app\)\/products\/actions["']/g;
    for (const m of src.matchAll(importRe)) {
      for (const sym of banned) {
        if (new RegExp(`\\b${sym}\\b`).test(m[1])) offenders.push(`${rel} imports ${sym}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "no import of deleted editor symbols remains");
});

// ── 4. Legacy routes still redirect (compatibility preserved) ────────────────

test("/products/new stays a permanent redirect to the V2 wizard", () => {
  const src = read("app/(app)/products/new/page.tsx");
  assert.ok(src.includes('permanentRedirect("/v2/catalog/new")'), "redirects to /v2/catalog/new");
});

test("/products/[id]/edit still redirects to the V2 editor for the SAME product id", () => {
  const src = read("app/(app)/products/[id]/edit/page.tsx");
  assert.ok(
    /permanentRedirect\(`\/v2\/catalog\/\$\{encodeURIComponent\(id\)\}\/edit`\)/.test(src),
    "redirects preserving the product id",
  );
});

test("middleware legacyRedirectPath maps the old editing URLs precisely", async () => {
  const { legacyRedirectPath } = await import("../v2/legacy-redirect.ts");
  assert.equal(legacyRedirectPath("/products/new"), "/v2/catalog/new");
  assert.equal(legacyRedirectPath("/products/abc-123/edit"), "/v2/catalog/abc-123/edit");
});

// ── 5. V2 is the sole editor and both mount the shared studio ─────────────────

test("V2 Create and Edit both mount VariantStudio", () => {
  assert.ok(read("app/(v2)/v2/catalog/new/page.tsx").includes("AiProductCreator"), "V2 create page");
  assert.ok(read("app/(v2)/v2/catalog/[id]/edit/page.tsx").includes("ProductEditForm"), "V2 edit page");
  assert.ok(read("components/v2/catalog/AiProductCreator.tsx").includes("<VariantStudio"), "create renders studio");
  assert.ok(read("components/v2/catalog/ProductEditForm.tsx").includes("<VariantStudio"), "edit renders studio");
});

// ── 6. The scanner Enter-flow lives in ONE shared place ──────────────────────

const STUDIO = read("components/v2/catalog/VariantStudio.tsx");
const ROW = read("components/v2/catalog/VariantRow.tsx");
const CREATE = read("components/v2/catalog/AiProductCreator.tsx");
const EDIT = read("components/v2/catalog/ProductEditForm.tsx");

test("VariantStudio owns the scanner flow via the pure ordering helper", () => {
  assert.ok(STUDIO.includes('from "@/lib/products/variant-scanner"'), "imports the pure helper");
  assert.ok(STUDIO.includes("nextActiveBarcodeKey(rows"), "uses the pure decision");
  assert.ok(STUDIO.includes('e.key !== "Enter"'), "acts only on Enter");
  assert.ok(STUDIO.includes('field !== "barcode"'), "acts only on the barcode field");
  assert.ok(STUDIO.includes("e.preventDefault()"), "blocks the scanner's implicit submit");
  assert.ok(STUDIO.includes(".focus()") && STUDIO.includes(".select()"), "moves + selects focus");
});

test("VariantRow stays presentational — generic per-field hooks, no barcode logic", () => {
  assert.ok(ROW.includes("onFieldKeyDown"), "forwards a generic keydown");
  assert.ok(ROW.includes("registerFieldRef"), "forwards a generic ref registrar");
  assert.equal(/["']barcode["']/.test(ROW), false, "no barcode-specific branch in the row");
  assert.equal(/preventDefault|nextActiveBarcodeKey|\.focus\(\)/.test(ROW), false, "no scanner business logic in the row");
});

test("neither parent carries its own scanner implementation", () => {
  for (const [name, src] of [["Create", CREATE], ["Edit", EDIT]] as const) {
    assert.equal(src.includes("nextActiveBarcodeKey"), false, `${name} has no scanner ordering logic`);
    assert.equal(/data-vbc/.test(src), false, `${name} has no legacy scanner markup`);
    assert.equal(/onKeyDown[^\n]*Enter/.test(src), false, `${name} has no barcode Enter handler`);
  }
});

// ── 7. Scanner introduces no auto row creation ───────────────────────────────

test("the scanner never adds a row — it only moves focus among existing rows", () => {
  // Bound the slice to the handler itself: from its declaration to its last
  // statement (el.select()). It must not call any row-adding callback.
  const start = STUDIO.indexOf("const handleBarcodeKeyDown");
  const end = STUDIO.indexOf("el.select();", start);
  assert.ok(start >= 0 && end > start, "scanner handler located");
  const handler = STUDIO.slice(start, end);
  assert.equal(/onAddRow\b|onAddRows|addRow\(/.test(handler), false, "no row creation in the scanner handler");
});
