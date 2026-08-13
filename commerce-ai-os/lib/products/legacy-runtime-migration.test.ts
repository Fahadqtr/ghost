// UX.4E-9A — legacy product create/edit runtime migration guards. Proves the V2
// flow (AiProductCreator / ProductEditForm → VariantStudio) is the ONLY active
// runtime path for product editing: the legacy URLs redirect to their precise V2
// replacements, ProductForm has no active runtime importers, the legacy
// create/edit actions are no longer called by runtime code, inbound links point
// at V2, and the save cores are untouched. Legacy files stay in the repo (their
// deletion is UX.4E-9C) — these guards only prove they are runtime-dead.
// PURE — no DB, no network, no React.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/legacy-runtime-migration.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Every runtime .ts/.tsx file under the given dirs (tests excluded). */
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

const LEGACY_NEW_PAGE = "app/(app)/products/new/page.tsx";
const LEGACY_EDIT_PAGE = "app/(app)/products/[id]/edit/page.tsx";

// ── 1. Legacy URLs are precise redirects into V2 ─────────────────────────────

// Doc comments on the redirect pages legitimately NAME the legacy files they
// replace, so these guards check IMPORT statements, not mere mentions.
const importsToken = (src: string, token: string) =>
  new RegExp(`import[^;]*${token}[^;]*from`).test(src) || new RegExp(`from\\s+["'][^"']*${token}`).test(src);

test("legacy create page is a pure redirect to the V2 wizard (no form, no DB)", () => {
  const src = read(LEGACY_NEW_PAGE);
  assert.ok(src.includes('permanentRedirect("/v2/catalog/new")'), "redirects to /v2/catalog/new");
  assert.equal(importsToken(src, "ProductForm"), false, "no legacy form import");
  assert.equal(importsToken(src, "supabase"), false, "no DB read remains");
});

test("legacy edit page is a pure redirect to the V2 editor for the same id", () => {
  const src = read(LEGACY_EDIT_PAGE);
  assert.ok(/permanentRedirect\(`\/v2\/catalog\/\$\{encodeURIComponent\(id\)\}\/edit`\)/.test(src), "redirects to /v2/catalog/{id}/edit");
  assert.equal(importsToken(src, "ProductForm"), false, "no legacy form import");
  assert.equal(importsToken(src, "supabase"), false, "no DB reads remain");
  assert.equal(importsToken(src, "ProductImages"), false, "no legacy image manager remains");
});

// ── 2. ProductForm has NO active runtime importers ───────────────────────────

test("ProductForm is no longer imported by any runtime module", () => {
  const offenders: string[] = [];
  for (const rel of runtimeFiles(["app", "components"])) {
    if (rel.endsWith("components/ProductForm.tsx")) continue; // the legacy file itself
    const src = read(rel);
    if (/from\s+["']@\/components\/ProductForm["']/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "no runtime file imports ProductForm");
});

// ── 3. Legacy create/edit actions are runtime-dead ───────────────────────────
// The approval/status actions in the same file (setProductApproval etc.) remain
// legitimately used — the guard is scoped to the CREATE/EDIT symbols only.

test("createProduct / updateProduct / nextProductSku are not imported by runtime code", () => {
  const banned = ["createProduct", "updateProduct", "nextProductSku"];
  const offenders: string[] = [];
  for (const rel of runtimeFiles(["app", "components"])) {
    if (rel.endsWith("components/ProductForm.tsx")) continue; // legacy file, runtime-dead itself
    if (rel.endsWith("app/(app)/products/actions.ts")) continue; // the definitions
    const src = read(rel);
    // import statements pulling from the legacy actions module
    const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@\/app\/\(app\)\/products\/actions["']/g;
    for (const m of src.matchAll(importRe)) {
      for (const sym of banned) {
        if (new RegExp(`\\b${sym}\\b`).test(m[1])) offenders.push(`${rel} imports ${sym}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "no runtime import of the legacy create/edit actions");
});

// ── 4. Inbound links point at V2 ─────────────────────────────────────────────

test("runtime links now target the V2 create/edit pages", () => {
  assert.ok(read("app/(app)/products/page.tsx").includes('href="/v2/catalog/new"'), "products list + New → V2");
  assert.ok(read("app/(app)/products/[id]/page.tsx").includes("/v2/catalog/${product.id}/edit"), "detail Edit → V2");
  assert.ok(read("components/CatalogEnrich.tsx").includes("/v2/catalog/${t.id}/edit"), "enrich ✏️ → V2");
  assert.ok(read("components/PendingProductsList.tsx").includes("/v2/catalog/${p.id}/edit"), "pending ✏️ → V2");
});

test("no runtime link builds a legacy /products/new or /products/{id}/edit URL", () => {
  const offenders: string[] = [];
  for (const rel of runtimeFiles(["app", "components"])) {
    if (rel === LEGACY_NEW_PAGE || rel === LEGACY_EDIT_PAGE) continue; // the redirect pages name themselves
    const src = read(rel);
    if (src.includes('"/products/new"')) offenders.push(`${rel} → /products/new`);
    if (/href=\{?[`"']\/products\/[^`"']*\/edit/.test(src)) offenders.push(`${rel} → /products/*/edit`);
  }
  assert.deepEqual(offenders, [], "no legacy-editing hrefs remain");
});

// ── 5. Old URLs still work: middleware maps them to the precise V2 targets ────

test("middleware-level legacyRedirectPath maps old editing URLs precisely", async () => {
  const { legacyRedirectPath } = await import("../v2/legacy-redirect.ts");
  assert.equal(legacyRedirectPath("/products/new"), "/v2/catalog/new");
  assert.equal(legacyRedirectPath("/products/abc-123/edit"), "/v2/catalog/abc-123/edit");
  assert.equal(legacyRedirectPath("/products"), "/v2/catalog", "other product paths keep the home funnel");
});

// ── 6. V2 is the active editor and its save path is unchanged ────────────────

test("V2 pages mount the Variant Studio editors", () => {
  assert.ok(read("app/(v2)/v2/catalog/new/page.tsx").includes("AiProductCreator"), "V2 create mounts AiProductCreator");
  assert.ok(read("app/(v2)/v2/catalog/[id]/edit/page.tsx").includes("ProductEditForm"), "V2 edit mounts ProductEditForm");
  assert.ok(read("components/v2/catalog/AiProductCreator.tsx").includes("<VariantStudio"), "create renders VariantStudio");
  assert.ok(read("components/v2/catalog/ProductEditForm.tsx").includes("<VariantStudio"), "edit renders VariantStudio");
});

test("V2 save behavior untouched: same shared cores as before the migration", () => {
  const createActions = read("app/(v2)/v2/catalog/new/actions.ts");
  assert.ok(createActions.includes("createProductCore"), "create still uses createProductCore");
  const editActions = read("app/(v2)/v2/catalog/[id]/edit/actions.ts");
  assert.ok(editActions.includes("updateProductCore"), "edit still uses updateProductCore");
});

// ── 7. No permission regressions ─────────────────────────────────────────────

test("auth surface unchanged: /products and /v2 stay protected", () => {
  const mw = read("lib/supabase/middleware.ts");
  assert.equal(/PUBLIC_PATHS\s*=\s*\[[^\]]*["']\/products["']/s.test(mw), false, "/products not made public");
  assert.equal(/PUBLIC_PATHS\s*=\s*\[[^\]]*["']\/v2["']/s.test(mw), false, "/v2 not made public");
  assert.ok(mw.includes("!user && !isPublic"), "unauthenticated gate preserved");
});

// ── 8. Legacy files remain in place (deletion belongs to UX.4E-9C) ───────────

test("legacy files still exist — this phase only stops using them", () => {
  for (const rel of ["components/ProductForm.tsx", "app/(app)/products/actions.ts"]) {
    assert.ok(read(rel).length > 0, `${rel} still present`);
  }
});
