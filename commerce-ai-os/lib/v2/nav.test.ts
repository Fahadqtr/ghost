// UX.1 — Navigation Cleanup: nav model tests.
// PURE tests only — no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/v2/nav.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { V2_NAV_LINKS, activeNavHref, activeNavSection, groupNavLinks } from "./nav.ts";

test("operations label is «مركز العمليات» (matches the page H1; no longer «لوحة العمليات»)", () => {
  const ops = V2_NAV_LINKS.find((l) => l.href === "/v2/operations");
  assert.ok(ops, "operations link exists");
  assert.equal(ops!.label, "مركز العمليات");
  assert.equal(
    V2_NAV_LINKS.some((l) => l.label === "لوحة العمليات"),
    false,
    "the old label is gone",
  );
});

test("TickTick integrations lives under «الإعدادات» (in-shell, not external)", () => {
  const tt = V2_NAV_LINKS.find((l) => l.href === "/v2/settings/integrations/ticktick");
  assert.ok(tt, "TickTick link exists");
  assert.equal(tt!.label, "تكاملات TickTick");
  assert.equal(tt!.section, "الإعدادات");
  assert.equal(tt!.external, undefined, "TickTick is a V2 route — not external");
});

test("Import/Export is an external «أدوات إضافية ↗» link to /import-export", () => {
  const ie = V2_NAV_LINKS.find((l) => l.href === "/import-export");
  assert.ok(ie, "Import/Export link exists");
  assert.equal(ie!.label, "الاستيراد والتصدير");
  assert.equal(ie!.section, "أدوات إضافية ↗");
  assert.equal(ie!.external, true, "Import/Export leaves the V2 shell — external (↗ badge)");
});

test("only Import/Export is added under extra tools this PR (no Studio/CRM/Social/Inbox)", () => {
  const extra = V2_NAV_LINKS.filter((l) => l.section === "أدوات إضافية ↗");
  assert.equal(extra.length, 1);
  for (const bad of ["/studio", "/crm", "/social", "/inbox", "/content", "/channels", "/order-operations", "/shopify-orders"]) {
    assert.equal(V2_NAV_LINKS.some((l) => l.href === bad), false, `${bad} must not be added this PR`);
  }
});

test("no duplicate hrefs", () => {
  const hrefs = V2_NAV_LINKS.map((l) => l.href);
  assert.equal(hrefs.length, new Set(hrefs).size, "every href is unique");
});

test("no dead V2 href introduced — every /v2 link points at a real page.tsx", () => {
  // Import/Export (/import-export) is a legacy route (external) and lives in the
  // (app) tree, so it is checked separately below.
  const routeToFile = (href: string): string => {
    const rel = href.replace(/^\/v2/, "");
    return `../../app/(v2)/v2${rel}/page.tsx`;
  };
  for (const link of V2_NAV_LINKS) {
    if (!link.href.startsWith("/v2")) continue;
    const url = new URL(routeToFile(link.href), import.meta.url);
    assert.ok(existsSync(url), `${link.href} must resolve to a real page: ${url.pathname}`);
  }
});

test("external Import/Export target exists in the legacy (app) tree", () => {
  const url = new URL("../../app/(app)/import-export/page.tsx", import.meta.url);
  assert.ok(existsSync(url), "/import-export legacy page exists");
});

test("existing catalog / operations / customers links are unchanged", () => {
  const byHref = (h: string) => V2_NAV_LINKS.find((l) => l.href === h);
  assert.deepEqual(
    { l: byHref("/v2/catalog")?.label, s: byHref("/v2/catalog")?.section },
    { l: "كتالوج ماليكاس", s: "الكتالوج" },
  );
  assert.deepEqual(
    { l: byHref("/v2/catalog/shopify")?.label, s: byHref("/v2/catalog/shopify")?.section },
    { l: "كتالوج Shopify", s: "الكتالوج" },
  );
  assert.equal(byHref("/v2/tasks")?.label, "المهام");
  assert.equal(byHref("/v2/tasks")?.section, "العمليات");
  // Customers (loyalty) group intact — 6 entries incl. the external card page.
  const customers = V2_NAV_LINKS.filter((l) => l.section === "العملاء");
  assert.equal(customers.length, 6);
  assert.equal(byHref("/rewards")?.external, true);
});

test("section order (NAV.1): الكتالوج, العمليات, التحليلات, العملاء, الإعدادات, أدوات إضافية ↗", () => {
  assert.deepEqual(
    groupNavLinks().map((s) => s.title),
    ["الكتالوج", "العمليات", "التحليلات", "العملاء", "الإعدادات", "أدوات إضافية ↗"],
  );
});

// ── NAV.1: the OPS sub-centers are now discoverable under «العمليات» ──────────
test("NAV.1 surfaces the four OPS sub-centers under «العمليات» (existing routes, in-shell)", () => {
  const byHref = (h: string) => V2_NAV_LINKS.find((l) => l.href === h);
  const expected: ReadonlyArray<readonly [string, string, string]> = [
    ["/v2/operations/media", "مركز الصور", "media"],
    ["/v2/operations/channels", "مركز القنوات", "channels"],
    ["/v2/operations/ai", "مركز الذكاء الاصطناعي", "ai"],
    ["/v2/operations/health", "صحة المنصة", "health"],
  ];
  for (const [href, label, icon] of expected) {
    const link = byHref(href);
    assert.ok(link, `${href} is in the nav`);
    assert.equal(link!.label, label, `${href} label`);
    assert.equal(link!.section, "العمليات", `${href} sits under العمليات`);
    assert.equal(link!.icon, icon, `${href} icon`);
    assert.equal(link!.external, undefined, `${href} is a V2 route — not external`);
  }
});

test("NAV.1/INT.2A «العمليات» group order: center, media, channels, ai, health, export, then tasks", () => {
  const ops = groupNavLinks().find((s) => s.title === "العمليات");
  assert.ok(ops, "العمليات group exists");
  assert.deepEqual(
    ops!.links.map((l) => l.href),
    [
      "/v2/operations",
      "/v2/operations/media",
      "/v2/operations/channels",
      "/v2/operations/ai",
      "/v2/operations/health",
      "/v2/export",
      "/v2/tasks",
    ],
  );
});

test("INT.2A adds «العمليات» → «مركز التصدير» (/v2/export, export icon, in-shell)", () => {
  const ex = V2_NAV_LINKS.find((l) => l.href === "/v2/export");
  assert.ok(ex, "/v2/export link exists");
  assert.equal(ex!.label, "مركز التصدير");
  assert.equal(ex!.section, "العمليات");
  assert.equal(ex!.icon, "export");
  assert.equal(ex!.external, undefined, "Export Center is a V2 route — not external");
});

// ── NAV.1: the BI.2 Executive Dashboard gets its own «التحليلات» group ────────
test("NAV.1 adds «التحليلات» → «لوحة الإدارة» (/v2/analytics, BarChart icon, in-shell)", () => {
  const an = V2_NAV_LINKS.find((l) => l.href === "/v2/analytics");
  assert.ok(an, "analytics link exists");
  assert.equal(an!.label, "لوحة الإدارة");
  assert.equal(an!.section, "التحليلات");
  assert.equal(an!.icon, "analytics");
  assert.equal(an!.external, undefined, "analytics is a V2 route — not external");
  const analytics = groupNavLinks().find((s) => s.title === "التحليلات");
  // AI.1 added «مركز الإجراءات» (/v2/actions) alongside the dashboard.
  assert.deepEqual(analytics?.links.map((l) => l.href), ["/v2/analytics", "/v2/actions"]);
});

test("AI.1 adds «مركز الإجراءات» (/v2/actions) under التحليلات (in-shell, real page)", () => {
  const ac = V2_NAV_LINKS.find((l) => l.href === "/v2/actions");
  assert.ok(ac, "action center link exists");
  assert.equal(ac!.label, "مركز الإجراءات");
  assert.equal(ac!.section, "التحليلات");
  assert.equal(ac!.external, undefined, "action center is a V2 route — not external");
});

test("activeNavHref behavior unchanged — longest-match still wins", () => {
  // parent stays active on its own sub-pages
  assert.equal(activeNavHref("/v2/catalog/12345"), "/v2/catalog");
  // a more specific link claims its own subtree
  assert.equal(activeNavHref("/v2/catalog/shopify"), "/v2/catalog/shopify");
  // operations sub-path
  assert.equal(activeNavHref("/v2/operations"), "/v2/operations");
  // OPS sub-centers claim their own subtree — the Operations Center above them
  // does NOT re-light (longest-match wins), incl. on their deep sub-pages
  assert.equal(activeNavHref("/v2/operations/media"), "/v2/operations/media");
  assert.equal(activeNavHref("/v2/operations/channels"), "/v2/operations/channels");
  assert.equal(activeNavHref("/v2/operations/ai"), "/v2/operations/ai");
  assert.equal(activeNavHref("/v2/operations/health"), "/v2/operations/health");
  assert.equal(activeNavHref("/v2/operations/health/anything"), "/v2/operations/health");
  // analytics lights up on its own page and sub-pages
  assert.equal(activeNavHref("/v2/analytics"), "/v2/analytics");
  // the settings link lights up on its own page
  assert.equal(activeNavHref("/v2/settings/integrations/ticktick"), "/v2/settings/integrations/ticktick");
  // segment boundary respected — /v2/catalogue never matches /v2/catalog
  assert.equal(activeNavHref("/v2/catalogue"), null);
  // unmatched path
  assert.equal(activeNavHref("/nope"), null);
});

test("activeNavSection returns the active link's group (for current-group highlight)", () => {
  assert.equal(activeNavSection("/v2/catalog/12345"), "الكتالوج");
  assert.equal(activeNavSection("/v2/operations"), "العمليات");
  assert.equal(activeNavSection("/v2/operations/media"), "العمليات");
  assert.equal(activeNavSection("/v2/analytics"), "التحليلات");
  assert.equal(activeNavSection("/v2/loyalty/qr"), "العملاء");
  assert.equal(activeNavSection("/v2/settings/integrations/ticktick"), "الإعدادات");
  // no match → no active group
  assert.equal(activeNavSection("/nope"), null);
});
