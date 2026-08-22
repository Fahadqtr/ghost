// NAV.1 — Unified Navigation Refresh guard (source scan §11). Proves this is a
// navigation/UI change ONLY: the pure nav model is framework-free and side-effect
// free; the shell/sidebar/topbar are presentational (no data client, no writes,
// no server actions, no secrets, no network); every nav href points at a route
// that ALREADY ships (no new routes minted); and the canonical routes are never
// renamed.
// node --conditions=react-server --experimental-strip-types --test lib/v2/nav1-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { V2_NAV_LINKS } from "./nav.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const NAV = "lib/v2/nav.ts";
const SIDEBAR = "components/v2/V2Sidebar.tsx";
const SHELL = "components/v2/V2Shell.tsx";
const TOPBAR = "components/v2/V2Topbar.tsx";
const COMPONENTS = [SIDEBAR, SHELL, TOPBAR];

const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/];
const DATA = [/createClient\(/, /@\/lib\/supabase/, /\.from\(/, /\.select\(/, /"use server"/, /@anthropic-ai/, /process\.env/, /fetch\(/];

// ── the pure nav model is framework-free and side-effect free ─────────────────
test("nav model is PURE (no @/ imports, no server-only, no IO/writes/clock)", () => {
  const raw = read(NAV);
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ imports");
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "not server-only");
  const s = strip(raw);
  for (const bad of [...WRITES, ...DATA, /Date\.now/, /new Date\(/]) {
    assert.equal(bad.test(s), false, `nav model must not contain ${bad}`);
  }
});

// ── §11 shell / sidebar / topbar are navigation-only presentational ───────────
test("shell, sidebar and topbar are presentational — no data client, writes, actions, secrets or network", () => {
  for (const f of COMPONENTS) {
    // Set.add/.delete on the subscriber registry is client-state bookkeeping,
    // not a Supabase query-builder write — neutralise it (cf. bi2's Array.from).
    const s = strip(read(f)).replace(/Listeners\.(add|delete)\(/g, "Listeners_op(");
    for (const bad of [...WRITES, ...DATA]) {
      assert.equal(bad.test(s), false, `${f} must not contain ${bad}`);
    }
  }
});

test("sidebar navigates via next/link and reads the pure nav model only", () => {
  const s = read(SIDEBAR);
  assert.ok(/from\s+["']next\/link["']/.test(s), "sidebar uses next/link");
  assert.ok(/from\s+["']@\/lib\/v2\/nav["']/.test(s), "sidebar reads @/lib/v2/nav");
  // the only @/ import allowed in the sidebar is the pure nav model
  const atImports = (s.match(/from\s+["']@\/[^"']+["']/g) ?? []).map((m) => m.replace(/from\s+["']|["']/g, ""));
  for (const imp of atImports) {
    assert.equal(imp, "@/lib/v2/nav", `unexpected @/ import in sidebar: ${imp}`);
  }
});

// ── §11 no business logic — no engine / read-model / loader imports ───────────
test("navigation imports no business-logic engines, read models or data loaders", () => {
  const BUSINESS = [
    /@\/lib\/inventory/,
    /@\/lib\/operations/,
    /@\/lib\/analytics/,
    /@\/lib\/dashboard/,
    /@\/lib\/channels/,
    /load[A-Z]\w+\(/, // e.g. loadAnalytics(, loadOperationsDashboard(
  ];
  for (const f of [NAV, ...COMPONENTS]) {
    const s = strip(read(f));
    for (const bad of BUSINESS) {
      assert.equal(bad.test(s), false, `${f} must not touch business logic (${bad})`);
    }
  }
});

// ── §2 no new routes: every nav href points at a route that already ships ─────
test("no new routes — every /v2 nav href resolves to an existing page.tsx", () => {
  for (const link of V2_NAV_LINKS) {
    if (!link.href.startsWith("/v2")) continue; // external legacy routes checked below
    // NAV.MEDIA's recovery shortcut deep-links with a query string — the route
    // is the path before the `?` (still an EXISTING page, nothing minted).
    const rel = link.href.split("?")[0]!.replace(/^\/v2/, "");
    const page = join(ROOT, `app/(v2)/v2${rel}/page.tsx`);
    assert.ok(existsSync(page), `${link.href} must resolve to a real page: ${page}`);
  }
});

test("external legacy targets still exist (no route invented)", () => {
  for (const [href, file] of [
    ["/rewards", "app/rewards/page.tsx"],
    ["/import-export", "app/(app)/import-export/page.tsx"],
  ] as const) {
    if (V2_NAV_LINKS.some((l) => l.href === href)) {
      assert.ok(existsSync(join(ROOT, file)), `${href} legacy page exists (${file})`);
    }
  }
});

// ── §2 routes are never renamed — the canonical href set is present verbatim ───
test("canonical routes are never renamed — exact hrefs present", () => {
  const canonical = [
    "/v2/catalog",
    "/v2/catalog/shopify",
    "/v2/operations",
    "/v2/operations/media",
    "/v2/operations/channels",
    "/v2/operations/ai",
    "/v2/operations/health",
    "/v2/analytics",
    "/v2/tasks",
  ];
  const hrefs = new Set(V2_NAV_LINKS.map((l) => l.href));
  for (const href of canonical) {
    assert.ok(hrefs.has(href), `${href} must be present exactly (never renamed)`);
  }
});
