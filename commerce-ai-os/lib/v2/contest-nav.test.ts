// Tests for the beauty-contest sidebar entry and its page shell.
// PURE tests only — no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/v2/contest-nav.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { V2_NAV_LINKS, activeNavHref, groupNavLinks } from "./nav.ts";

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PAGE_SRC = readFileSync(new URL("../../app/(v2)/v2/contest/page.tsx", import.meta.url), "utf8");
const SIDEBAR_SRC = readFileSync(new URL("../../components/v2/V2Sidebar.tsx", import.meta.url), "utf8");

// ── Nav entry ────────────────────────────────────────────────────────────────

test("the contest link exists and points at /v2/contest", () => {
  const link = V2_NAV_LINKS.find((l) => l.href === "/v2/contest");
  assert.ok(link !== undefined, "contest link present");
  assert.equal(link!.label, "مسابقة الجمال");
  assert.equal(link!.icon, "contest");
});

test("the contest link is NOT filed under the catalog heading", () => {
  const link = V2_NAV_LINKS.find((l) => l.href === "/v2/contest")!;
  assert.notEqual(link.section, "الكتالوج", "a contest is not a catalog entry");
  assert.equal(link.section, "التسويق");
});

test("the catalog section still holds exactly the two catalog links, in order", () => {
  const catalog = V2_NAV_LINKS.filter((l) => l.section === "الكتالوج");
  assert.deepEqual(catalog.map((l) => l.href), ["/v2/catalog", "/v2/catalog/shopify"]);
});

test("links are grouped by section, preserving section and link order", () => {
  const sections = groupNavLinks();
  assert.deepEqual(sections.map((s) => s.title), ["الكتالوج", "التسويق"]);
  assert.deepEqual(sections[0]!.links.map((l) => l.href), ["/v2/catalog", "/v2/catalog/shopify"]);
  assert.deepEqual(sections[1]!.links.map((l) => l.href), ["/v2/contest"]);
  // Every declared link appears exactly once across the groups.
  const flat = sections.flatMap((s) => s.links.map((l) => l.href));
  assert.equal(flat.length, V2_NAV_LINKS.length);
  assert.equal(new Set(flat).size, flat.length, "no duplicates");
});

test("grouping tolerates malformed input without throwing", () => {
  assert.deepEqual(groupNavLinks([]), []);
  assert.deepEqual(groupNavLinks(null as never), []);
  assert.deepEqual(groupNavLinks([null as never]), []);
});

// ── Active-route rule still correct with a third link ────────────────────────

test("/v2/contest activates the contest link only", () => {
  assert.equal(activeNavHref("/v2/contest"), "/v2/contest");
});

test("adding the contest link did not disturb the catalog routes", () => {
  assert.equal(activeNavHref("/v2/catalog"), "/v2/catalog");
  assert.equal(activeNavHref("/v2/catalog/shopify"), "/v2/catalog/shopify");
  assert.equal(activeNavHref("/v2/catalog/some-product-id"), "/v2/catalog");
});

test("a contest sub-page keeps the contest link active", () => {
  assert.equal(activeNavHref("/v2/contest/anything"), "/v2/contest");
  // …and a mere prefix does not match.
  assert.equal(activeNavHref("/v2/contests"), null);
});

// ── Sidebar rendering ────────────────────────────────────────────────────────

test("the sidebar renders grouped sections and the contest icon", () => {
  assert.ok(/groupNavLinks\(\)/.test(SIDEBAR_SRC), "renders grouped sections");
  assert.ok(/\{section\.title\}/.test(SIDEBAR_SRC), "renders each section heading");
  assert.ok(/function ContestIcon/.test(SIDEBAR_SRC), "contest icon exists");
  assert.ok(/<NavIcon icon=\{link\.icon\} \/>/.test(SIDEBAR_SRC), "icon chosen per link");
  // The heading is no longer hard-coded to the catalog.
  assert.ok(
    !/>الكتالوج<\/div>/.test(SIDEBAR_SRC),
    "the catalog heading is data-driven, not hard-coded",
  );
});

// ── Page shell ───────────────────────────────────────────────────────────────

test("the contest page renders its title, badge and description", () => {
  assert.ok(PAGE_SRC.includes("مسابقة الجمال"), "title");
  assert.ok(PAGE_SRC.includes("قيد الإعداد"), "state badge");
  assert.ok(PAGE_SRC.includes("إدارة مسابقة الجمال والمشاركات والنتائج"), "description");
});

test("the page shows a fixed empty state, not fabricated content", () => {
  assert.ok(
    PAGE_SRC.includes("لم يتم إعداد المسابقة بعد. سيظهر هنا سجل المشاركات والنتائج فور ربط البيانات."),
    "fixed empty-state message",
  );
});

test("counters render — (unknown), never a fabricated zero", () => {
  // A hard 0 would assert "no participants" as fact; the truth is "not connected".
  assert.ok(/<div className="text-xl font-bold text-ink">—<\/div>/.test(PAGE_SRC), "counter shows a dash");
  assert.ok(!/>0</.test(PAGE_SRC), "no hard-coded zero counter");
  for (const label of ["المشاركات", "المتأهلات", "الفائزات"]) {
    assert.ok(PAGE_SRC.includes(label), `counter label: ${label}`);
  }
});

test("the page is a Server Component that reads and writes nothing", () => {
  const src = strip(PAGE_SRC);
  assert.ok(!/^\s*["']use client["']/m.test(PAGE_SRC), "no 'use client'");
  assert.ok(/export const dynamic = "force-dynamic"/.test(src), "force-dynamic");
  for (const banned of [
    "createClient",
    "supabase",
    "createAdminClient",
    "service_role",
    "process.env",
    "console.",
    "fetch(",
    ".insert(",
    ".update(",
    ".upsert(",
    ".delete(",
    ".rpc(",
    "useState",
    "useEffect",
    "setInterval",
    "setTimeout",
  ]) {
    assert.ok(!src.includes(banned), `contest page must not use ${banned}`);
  }
});

test("the page invents no data model and no placeholder records", () => {
  const src = strip(PAGE_SRC);
  for (const banned of ["contest_entries", "contestants", "participants_table", "MOCK", "mock", "TODO", "lorem"]) {
    assert.ok(!src.includes(banned), `contest page must not reference ${banned}`);
  }
});

test("the page is auth-protected by the (v2) layout, not public", () => {
  const layout = strip(readFileSync(new URL("../../app/(v2)/v2/layout.tsx", import.meta.url), "utf8"));
  assert.ok(/auth\.getUser\s*\(/.test(layout), "layout checks the session");
  assert.ok(/redirect\(\s*["']\/login["']\s*\)/.test(layout), "redirects to /login");
  assert.ok(!/force-static|export const runtime/.test(strip(PAGE_SRC)), "page does not bypass the gate");
});
