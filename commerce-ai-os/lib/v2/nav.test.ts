// UX.1 — Navigation Cleanup: nav model tests.
// PURE tests only — no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/v2/nav.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { V2_NAV_LINKS, activeNavHref, groupNavLinks } from "./nav.ts";

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

test("section order: الكتالوج, العمليات, العملاء, الإعدادات, أدوات إضافية ↗", () => {
  assert.deepEqual(
    groupNavLinks().map((s) => s.title),
    ["الكتالوج", "العمليات", "العملاء", "الإعدادات", "أدوات إضافية ↗"],
  );
});

test("activeNavHref behavior unchanged — longest-match still wins", () => {
  // parent stays active on its own sub-pages
  assert.equal(activeNavHref("/v2/catalog/12345"), "/v2/catalog");
  // a more specific link claims its own subtree
  assert.equal(activeNavHref("/v2/catalog/shopify"), "/v2/catalog/shopify");
  // operations sub-path
  assert.equal(activeNavHref("/v2/operations"), "/v2/operations");
  // the new settings link lights up on its own page
  assert.equal(activeNavHref("/v2/settings/integrations/ticktick"), "/v2/settings/integrations/ticktick");
  // segment boundary respected — /v2/catalogue never matches /v2/catalog
  assert.equal(activeNavHref("/v2/catalogue"), null);
  // unmatched path
  assert.equal(activeNavHref("/nope"), null);
});
