// UX.2 — In-page navigation: source scans.
// PURE tests only — no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/v2/in-page-nav.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const NAV = readFileSync(new URL("../../components/v2/InPageNav.tsx", import.meta.url), "utf8");
const PRODUCT = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/page.tsx", import.meta.url), "utf8");
const OPS = readFileSync(new URL("../../components/v2/operations/OperationsDashboard.tsx", import.meta.url), "utf8");

const PRODUCT_ANCHORS = ["#details", "#platforms", "#tasks", "#activity", "#history"];
const OPS_ANCHORS = ["#kpis", "#platform-health", "#platform-overview", "#unified-queue", "#work-queues", "#products"];

// ── InPageNav component ─────────────────────────────────────────────────────

test("InPageNav is a Server Component with NO client JS", () => {
  assert.equal(NAV.includes('"use client"'), false);
  assert.equal(NAV.includes("useState"), false);
  assert.equal(NAV.includes("onClick"), false);
  assert.equal(NAV.includes("useEffect"), false);
});

test("InPageNav is anchor-only, RTL, mobile-first, sticky, horizontally scrollable", () => {
  assert.ok(NAV.includes('href={it.href}'), "renders anchor links from items");
  assert.ok(NAV.includes('dir="rtl"'), "RTL");
  assert.ok(NAV.includes("overflow-x-auto"), "horizontal scroll on small screens");
  assert.ok(NAV.includes("sticky"), "sticky strip");
  assert.ok(/whitespace-nowrap/.test(NAV), "items do not wrap (scroll instead)");
});

test("InPageNav does no I/O — no reader/query/data logic", () => {
  for (const bad of ["fetch(", "createClient", "process.env", ".from(", ".rpc(", "load"]) {
    assert.equal(NAV.includes(bad), false, `InPageNav must not contain ${bad}`);
  }
});

// ── Product page ────────────────────────────────────────────────────────────

test("product page renders the in-page nav", () => {
  assert.ok(PRODUCT.includes("InPageNav"), "InPageNav used on the product page");
});

test("product page: every expected anchor href is present", () => {
  for (const a of PRODUCT_ANCHORS) {
    assert.ok(PRODUCT.includes(`href: "${a}"`), `nav item ${a} present`);
  }
});

test("product page: every anchor has a matching section id", () => {
  for (const a of PRODUCT_ANCHORS) {
    const id = a.slice(1);
    assert.ok(PRODUCT.includes(`id="${id}"`), `section id="${id}" present`);
  }
});

test("product page keeps its sections (no deletions; diff stays inside المنصات)", () => {
  for (const c of ["ProductDetail", "PlatformMatrix", "ProductTasksWidget", "ProductActivityWidget", "PlatformHistory"]) {
    assert.ok(PRODUCT.includes(c), `${c} still rendered`);
  }
  // Cross-Platform Diff remains built inside the platforms section (via PlatformMatrix).
  assert.ok(PRODUCT.includes("buildCrossPlatformDiff"), "diff still built for the platforms section");
  // Full timeline stays a drilldown from the activity widget (not a new page link here).
  assert.ok(PRODUCT.includes("ProductActivityWidget"), "activity widget (timeline drilldown) intact");
});

test("product page adds no client JS and no new reader", () => {
  assert.equal(PRODUCT.includes('"use client"'), false);
  // UX.2 introduces no data loader — the only loaders are the pre-existing ones.
  assert.equal(PRODUCT.includes("loadCrossPlatformDiff"), false);
  assert.equal(PRODUCT.includes("in-page-nav-read"), false);
});

// ── Operations page ─────────────────────────────────────────────────────────

test("operations dashboard renders the in-page nav", () => {
  assert.ok(OPS.includes("InPageNav"), "InPageNav used on the operations dashboard");
});

test("operations: every expected anchor href is present", () => {
  for (const a of OPS_ANCHORS) {
    assert.ok(OPS.includes(`href: "${a}"`), `nav item ${a} present`);
  }
});

test("operations: every anchor has a matching section id", () => {
  for (const a of OPS_ANCHORS) {
    const id = a.slice(1);
    assert.ok(OPS.includes(`id="${id}"`), `section id="${id}" present`);
  }
});

test("operations: the existing #unified-queue anchor is REUSED (defined once)", () => {
  const occurrences = OPS.split('id="unified-queue"').length - 1;
  assert.equal(occurrences, 1, "unified-queue id defined exactly once (reused, not duplicated)");
});

test("operations dashboard is still a Server Component (no client JS added)", () => {
  assert.equal(OPS.includes('"use client"'), false);
});

test("operations dashboard keeps its sections (no deletions, semantics unchanged)", () => {
  for (const c of ["PlatformHealthSection", "PlatformOverviewSection", "UnifiedQueueSection"]) {
    assert.ok(OPS.includes(c), `${c} still rendered`);
  }
  // health strip still sits above the platform overview (CI.4 invariant).
  assert.ok(OPS.indexOf("PlatformHealthSection") < OPS.indexOf("PlatformOverviewSection"), "health above overview");
  // queue + work-lists + search/filter untouched.
  assert.ok(OPS.includes("قوائم العمل"), "work queues section present");
  assert.ok(OPS.includes('method="get"'), "search/filter GET form intact");
});

test("operations: nav adds no route/query changes or new reads", () => {
  // The nav is anchors only — it must not introduce query-param navigation or loaders.
  assert.ok(OPS.includes('href: "#kpis"'), "anchors are fragments, not routes/queries");
  assert.equal(OPS.includes("loadOperations"), false, "no reader is imported into the component");
});
