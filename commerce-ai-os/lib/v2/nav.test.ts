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

test("Snoonu session helper (MEDIA.1A-P4) stays reachable — NAV.MEDIA moved it under «الصور والوسائط»", () => {
  const sh = V2_NAV_LINKS.find((l) => l.href === "/v2/settings/connections/snoonu/session-helper");
  assert.ok(sh, "session-helper link exists — the owner page must be reachable from the menu");
  assert.equal(sh!.label, "جلسة Snoonu");
  assert.equal(sh!.section, "الصور والوسائط");
  // NAV-HOTFIX: connection-style icon pinned so the shortcut can't silently
  // lose its identity (and, via the checks above, can't disappear at all).
  assert.equal(sh!.icon, "channels", "connection/status icon");
  assert.equal(sh!.external, undefined, "session helper is a V2 route — not external");
});

test("legacy hub is an external «أدوات إضافية ↗» link, clearly labelled as legacy (UX.NAV.2)", () => {
  const ie = V2_NAV_LINKS.find((l) => l.href === "/import-export");
  assert.ok(ie, "legacy hub link exists");
  assert.equal(ie!.label, "الاستيراد والمزامنة (قديم)", "label marks the hub as legacy import/sync tools");
  assert.equal(ie!.section, "أدوات إضافية ↗");
  assert.equal(ie!.external, true, "the hub leaves the V2 shell — external (↗ badge)");
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
  // (app) tree, so it is checked separately below. NAV.MEDIA's recovery shortcut
  // deep-links with a query string — the route is the path before the `?`.
  const routeToFile = (href: string): string => {
    const rel = href.split("?")[0]!.replace(/^\/v2/, "");
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

test("section order includes the Inventory Hub immediately after Home", () => {
  assert.deepEqual(
    groupNavLinks().map((s) => s.title),
    ["الرئيسية", "المخزون", "الكتالوج", "العمليات", "الصور والوسائط", "التحليلات", "العملاء", "الإعدادات", "أدوات إضافية ↗"],
  );
});

test("INV.V2.1 adds one in-shell inventory home", () => {
  const inventory = V2_NAV_LINKS.filter((l) => l.href === "/v2/inventory");
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0]!.label, "مركز المخزون");
  assert.equal(inventory[0]!.section, "المخزون");
  assert.equal(inventory[0]!.external, undefined);
  assert.equal(activeNavHref("/v2/inventory"), "/v2/inventory");
});

test("HOME.1 adds «الرئيسية» → the Executive Home (/v2, home icon, in-shell) as the first link", () => {
  const home = V2_NAV_LINKS.find((l) => l.href === "/v2");
  assert.ok(home, "home link exists");
  assert.equal(home!.label, "الرئيسية");
  assert.equal(home!.section, "الرئيسية");
  assert.equal(home!.icon, "home");
  assert.equal(home!.external, undefined, "home is a V2 route — not external");
  assert.equal(V2_NAV_LINKS[0]!.href, "/v2", "home heads the sidebar");
  // exact-match only: the root never becomes a subtree catch-all.
  assert.equal(activeNavHref("/v2"), "/v2");
  assert.equal(activeNavHref("/v2/catalogue"), null);
  assert.equal(activeNavSection("/v2"), "الرئيسية");
});

// ── NAV.1: the OPS sub-centers are discoverable (NAV.MEDIA moved media out) ───
test("NAV.1 keeps the OPS sub-centers reachable — media now lives under «الصور والوسائط»", () => {
  const byHref = (h: string) => V2_NAV_LINKS.find((l) => l.href === h);
  const expected: ReadonlyArray<readonly [string, string, string, string]> = [
    ["/v2/operations/media", "مركز الصور", "media", "الصور والوسائط"],
    ["/v2/operations/channels", "مركز القنوات", "channels", "العمليات"],
    ["/v2/operations/ai", "مركز الذكاء الاصطناعي", "ai", "العمليات"],
    ["/v2/operations/health", "صحة المنصة", "health", "العمليات"],
  ];
  for (const [href, label, icon, section] of expected) {
    const link = byHref(href);
    assert.ok(link, `${href} is in the nav`);
    assert.equal(link!.label, label, `${href} label`);
    assert.equal(link!.section, section, `${href} section`);
    assert.equal(link!.icon, icon, `${href} icon`);
    assert.equal(link!.external, undefined, `${href} is a V2 route — not external`);
  }
});

test("NAV.1/INT.2A/NAV.MEDIA «العمليات» group order: center, channels, ai, health, export, then tasks", () => {
  const ops = groupNavLinks().find((s) => s.title === "العمليات");
  assert.ok(ops, "العمليات group exists");
  assert.deepEqual(
    ops!.links.map((l) => l.href),
    [
      "/v2/operations",
      "/v2/operations/channels",
      "/v2/operations/ai",
      "/v2/operations/health",
      "/v2/export",
      "/v2/tasks",
    ],
  );
});

// ── NAV.MEDIA/UX.NAV.2: «الصور والوسائط» collects the media/Snoonu tools ──────
test("media group pins the four media shortcuts (existing routes only, exact hrefs/labels/icons, in order)", () => {
  const group = groupNavLinks().find((s) => s.title === "الصور والوسائط");
  assert.ok(group, "«الصور والوسائط» group exists");
  // UX.NAV.2: حملة الإطلاق moved to its ONE canonical home (الكتالوج); the
  // media group keeps the four media surfaces in operator order.
  assert.deepEqual(
    group!.links.map((l) => [l.href, l.label, l.icon]),
    [
      ["/v2/operations/media", "مركز الصور", "media"],
      ["/v2/operations/media/discovery", "اكتشاف وسائط Snoonu", "media"],
      ["/v2/operations/media?storefront=snoonu:malikas", "استرجاع الصور الناقصة", "media"],
      ["/v2/settings/connections/snoonu/session-helper", "جلسة Snoonu", "channels"],
    ],
    "the four shortcuts, hrefs pinned exactly",
  );
  for (const l of group!.links) assert.equal(l.external, undefined, `${l.href} is a V2 route — not external`);
});

test("every feature has ONE sidebar home — media routes in the media group, launch in the catalog (UX.NAV.2)", () => {
  for (const href of [
    "/v2/operations/media",
    "/v2/operations/media/discovery",
    "/v2/settings/connections/snoonu/session-helper",
  ]) {
    const hits = V2_NAV_LINKS.filter((l) => l.href === href);
    assert.equal(hits.length, 1, `${href} appears exactly once (no confusing duplicate entries)`);
    assert.equal(hits[0]!.section, "الصور والوسائط", `${href} lives in the media group only`);
  }
  // Launch Campaign: one canonical entry, under the catalog it belongs to.
  const launch = V2_NAV_LINKS.filter((l) => l.href === "/v2/catalog/launch");
  assert.equal(launch.length, 1, "حملة الإطلاق appears exactly once");
  assert.equal(launch[0]!.section, "الكتالوج", "حملة الإطلاق lives under الكتالوج (canonical)");
  // The recovery shortcut is a deep link into the EXISTING Media Center bulk
  // recovery (validated `storefront` param) — no new page is minted and no
  // legacy media/recovery route is reintroduced anywhere in the nav.
  const recovery = V2_NAV_LINKS.find((l) => l.label === "استرجاع الصور الناقصة");
  assert.ok(recovery, "recovery shortcut exists");
  assert.equal(recovery!.href.split("?")[0], "/v2/operations/media", "recovery points at the existing Media Center");
  for (const l of V2_NAV_LINKS) {
    assert.equal(
      /image-recovery|media-recovery|\/recovery\b|\/media\/import|\/media\/upload/.test(l.href),
      false,
      `no legacy/new media route in the nav: ${l.href}`,
    );
  }
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
  // NAV.MEDIA: the discovery link claims its own subtree; the query-string
  // recovery deep link never matches a pathname, so exactly one link lights up.
  assert.equal(activeNavHref("/v2/operations/media/discovery"), "/v2/operations/media/discovery");
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
  assert.equal(activeNavSection("/v2/operations/media"), "الصور والوسائط");
  assert.equal(activeNavSection("/v2/analytics"), "التحليلات");
  assert.equal(activeNavSection("/v2/loyalty/qr"), "العملاء");
  assert.equal(activeNavSection("/v2/settings/integrations/ticktick"), "الإعدادات");
  // no match → no active group
  assert.equal(activeNavSection("/nope"), null);
});
