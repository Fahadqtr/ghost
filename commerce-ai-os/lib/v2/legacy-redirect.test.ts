// Tests for the V2-only interface routing helpers + wiring source assertions.
// Run: node --conditions=react-server --experimental-strip-types --test lib/v2/legacy-redirect.test.ts
// PURE — no DB, no network, no Next runtime.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canonicalRedirectTarget,
  legacyMigrationStatus,
  legacyRedirectPath,
  movedRoutePath,
  safeInternalPath,
  V2_HOME,
} from "./legacy-redirect.ts";

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ── legacyRedirectPath ───────────────────────────────────────────────────────

test("V2_HOME is the Executive Home, not catalog or operations", () => {
  assert.equal(V2_HOME, "/v2");
});

test("root resolves to Executive Home while generic product routes resolve to catalog", () => {
  assert.equal(legacyRedirectPath("/"), "/v2");
  assert.equal(legacyRedirectPath("/products"), "/v2/catalog");
});

test("critical legacy routes have canonical V2 destinations", () => {
  assert.deepEqual(canonicalRedirectTarget("/dashboard"), { pathname: "/v2" });
  assert.deepEqual(canonicalRedirectTarget("/platforms"), { pathname: "/v2/operations/channels" });
  assert.deepEqual(canonicalRedirectTarget("/channels"), { pathname: "/v2/operations/channels" });
  assert.deepEqual(canonicalRedirectTarget("/catalog/health"), { pathname: "/v2/operations/health" });
  assert.deepEqual(canonicalRedirectTarget("/catalog/enrich"), { pathname: "/v2/operations/ai" });
  assert.deepEqual(canonicalRedirectTarget("/import-export/export"), { pathname: "/v2/export" });
});

test("platform detail routes preserve canonical context when possible", () => {
  assert.deepEqual(canonicalRedirectTarget("/platforms/shopify"), {
    pathname: "/v2/operations/channels",
    query: { channel: "shopify" },
  });
  assert.deepEqual(canonicalRedirectTarget("/platforms/pure_seoul"), {
    pathname: "/v2/operations/channels",
    query: { storefront: "snoonu:pure_seoul" },
  });
});

test("inventory is RELOCATED to /v2/inventory/* (INV.V2.3) — sub-path kept, never the catalog funnel", () => {
  // Every daily destination now has a V2 wrapper, so /inventory moved out of
  // NEEDS_MIGRATION and into the moved-prefix map (middleware keeps the query).
  for (const [p, to] of [
    ["/inventory", "/v2/inventory"],
    ["/inventory/stocktake", "/v2/inventory/stocktake"],
    ["/inventory/movements/123", "/v2/inventory/movements/123"],
  ] as const) {
    assert.equal(canonicalRedirectTarget(p), null, p);
    assert.equal(legacyRedirectPath(p), null, p);
    assert.equal(legacyMigrationStatus(p), null, p);
    assert.equal(movedRoutePath(p), to, p);
  }
});

// ── Precise product-editing mappings (UX.4E-9A) ─────────────────────────────

test("legacy create URL lands on the V2 wizard, not the catalog home", () => {
  assert.equal(legacyRedirectPath("/products/new"), "/v2/catalog/new");
});

test("legacy edit URL lands on the V2 editor for the SAME product", () => {
  const id = "3f2a1b0c-9d8e-4f00-a1b2-c3d4e5f60789";
  assert.equal(legacyRedirectPath(`/products/${id}/edit`), `/v2/catalog/${id}/edit`);
  assert.equal(legacyRedirectPath("/products/123/edit"), "/v2/catalog/123/edit");
});

test("non-create/edit product paths keep the funnel-to-home behavior", () => {
  for (const p of ["/products", "/products/123", "/products/123/edit/extra", "/products/new/x"]) {
    assert.equal(legacyRedirectPath(p), "/v2/catalog", `funnel ${p}`);
  }
});

test("an unsafe id segment falls back to the funnel (never a crafted V2 path)", () => {
  for (const p of ["/products/a%2Fb/edit", "/products/a.b/edit", "/products/a b/edit"]) {
    assert.equal(legacyRedirectPath(p), "/v2/catalog", `unsafe ${p}`);
  }
});

test("/v2/catalog does not loop (V2 paths are excluded)", () => {
  assert.equal(legacyRedirectPath("/v2/catalog"), null);
  assert.equal(legacyRedirectPath("/v2/catalog/p1"), null);
  assert.equal(legacyRedirectPath("/v2"), null);
});

test("/login remains accessible (not redirected)", () => {
  assert.equal(legacyRedirectPath("/login"), null);
  assert.equal(legacyRedirectPath("/login/whatever"), null);
});

test("/api routes are not redirected", () => {
  for (const p of ["/api", "/api/shopify/callback", "/api/cron/availability-sync", "/api/malak"]) {
    assert.equal(legacyRedirectPath(p), null, `api path ${p}`);
  }
});

test("webhook + auth routes are not redirected", () => {
  assert.equal(legacyRedirectPath("/api/webhooks/shopify"), null);
  assert.equal(legacyRedirectPath("/auth/recovery"), null);
});

test("other non-legacy paths are left untouched (no blanket block)", () => {
  for (const p of ["/staff", "/rewards", "/order-operations", "/malak", "/productsomething"]) {
    assert.equal(legacyRedirectPath(p), null, `untouched ${p}`);
  }
});

test("non-string / empty pathname → null", () => {
  assert.equal(legacyRedirectPath(undefined), null);
  assert.equal(legacyRedirectPath(null), null);
  assert.equal(legacyRedirectPath(123 as unknown as string), null);
  assert.equal(legacyRedirectPath(""), null);
});

// ── safeInternalPath (open-redirect protection) ──────────────────────────────

test("post-login default is /v2", () => {
  assert.equal(safeInternalPath(null), "/v2");
  assert.equal(safeInternalPath(undefined), "/v2");
  assert.equal(safeInternalPath(""), "/v2");
});

test("external next URL rejected → fallback", () => {
  for (const bad of ["https://evil.com", "http://evil.com", "evil.com", "//evil.com", "/\\evil.com", "\\\\evil", "javascript:alert(1)"]) {
    assert.equal(safeInternalPath(bad), "/v2", `rejected ${JSON.stringify(bad)}`);
  }
});

test("non-string next rejected → fallback", () => {
  assert.equal(safeInternalPath(5 as unknown as string), "/v2");
  assert.equal(safeInternalPath({} as unknown as string), "/v2");
  assert.equal(safeInternalPath(["/x"] as unknown as string), "/v2");
});

test("control chars / backslashes rejected → fallback", () => {
  assert.equal(safeInternalPath(`/foo${String.fromCharCode(0)}bar`), "/v2");
  assert.equal(safeInternalPath("/foo\nbar"), "/v2");
  assert.equal(safeInternalPath("/foo\\bar"), "/v2");
});

test("valid same-origin path is preserved (incl. query)", () => {
  assert.equal(safeInternalPath("/v2/catalog"), "/v2/catalog");
  assert.equal(safeInternalPath("/v2/catalog?query=x&page=2"), "/v2/catalog?query=x&page=2");
  assert.equal(safeInternalPath("/v2/catalog/p1"), "/v2/catalog/p1");
});

test("custom fallback is honored", () => {
  assert.equal(safeInternalPath("https://evil.com", "/login"), "/login");
});

// ── Wiring / source assertions ───────────────────────────────────────────────

test("root page redirects to V2 (no /dashboard)", () => {
  const src = strip(readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8"));
  assert.ok(/redirect\(\s*V2_HOME\s*\)/.test(src) || /redirect\(\s*["']\/v2\/catalog["']\s*\)/.test(src), "root redirects to V2");
  assert.ok(!/redirect\(\s*["']\/dashboard["']\s*\)/.test(src), "no /dashboard redirect remains");
});

test("middleware applies canonical redirects before the generic legacy funnel", () => {
  const src = strip(readFileSync(new URL("../supabase/middleware.ts", import.meta.url), "utf8"));
  assert.ok(/canonicalRedirectTarget\s*\(/.test(src), "uses canonical redirect map");
  assert.ok(src.indexOf("canonicalRedirectTarget(path)") < src.indexOf("legacyRedirectPath(path)"));
  assert.ok(/canonicalUrl\.searchParams\.has/.test(src), "preserves caller query context");
});

test("/v2 page remains the HOME dashboard and never redirects to operations", () => {
  const src = strip(readFileSync(new URL("../../app/(v2)/v2/page.tsx", import.meta.url), "utf8"));
  assert.ok(/loadHomeDashboard\s*\(/.test(src), "loads the Executive Home model");
  assert.ok(/<HomeDashboard/.test(src), "renders the Executive Home");
  assert.ok(!/redirect\s*\(/.test(src), "does not redirect away from /v2");
  assert.ok(!src.includes("/v2/operations"), "does not funnel Home to Operations");
});

test("LoginForm post-login destination goes through safeInternalPath (no hardcoded /dashboard)", () => {
  const src = strip(readFileSync(new URL("../../components/LoginForm.tsx", import.meta.url), "utf8"));
  assert.ok(/safeInternalPath\s*\(/.test(src), "uses safeInternalPath");
  assert.ok(!/push\(\s*["']\/dashboard["']\s*\)/.test(src), "no hardcoded /dashboard push");
});

test("middleware blocks legacy for authenticated users, keeps auth gate, sends /login → V2, /v2 stays protected", () => {
  const src = strip(readFileSync(new URL("../supabase/middleware.ts", import.meta.url), "utf8"));
  assert.ok(/legacyRedirectPath\s*\(/.test(src), "uses legacyRedirectPath");
  assert.ok(/if \(user\)/.test(src), "legacy block runs only for authenticated users");
  // unauthenticated protected page still goes to /login (auth gate unchanged)
  assert.ok(/!user && !isPublic/.test(src), "unauth non-public → /login gate preserved");
  assert.ok(/pathname = "\/login"/.test(src), "still redirects to /login");
  // already-logged-in /login now goes to V2, not /dashboard
  assert.ok(!/pathname = "\/dashboard"/.test(src), "logged-in /login no longer targets /dashboard");
  // /v2 must NOT be public → unauthenticated /v2/catalog still reaches /login
  assert.ok(!/["']\/v2["']/.test(src), "/v2 is not added to PUBLIC_PATHS");
});
