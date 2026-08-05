// Tests for the «مكافآت الجمال» (Beauty Rewards) entries in the V2 sidebar.
// PURE tests only — no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/v2/loyalty-nav.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { V2_NAV_LINKS, activeNavHref, groupNavLinks } from "./nav.ts";

const SIDEBAR_SRC = readFileSync(new URL("../../components/v2/V2Sidebar.tsx", import.meta.url), "utf8");
const REDIRECT_SRC = readFileSync(new URL("./legacy-redirect.ts", import.meta.url), "utf8");

const LOYALTY_HREFS = [
  "/loyalty",
  "/loyalty/customers",
  "/loyalty/prizes",
  "/loyalty/cards",
  "/loyalty/qr",
  "/rewards",
];

// ── The links themselves ─────────────────────────────────────────────────────

test("every Beauty Rewards page is reachable from the V2 sidebar", () => {
  const hrefs = V2_NAV_LINKS.map((l) => l.href);
  for (const href of LOYALTY_HREFS) {
    assert.ok(hrefs.includes(href), `sidebar links ${href}`);
  }
});

test("the entries use the canonical label and sit under العملاء", () => {
  const links = V2_NAV_LINKS.filter((l) => LOYALTY_HREFS.includes(l.href));
  assert.equal(links.length, LOYALTY_HREFS.length);
  for (const l of links) {
    assert.equal(l.section, "العملاء", `${l.href} is a customers entry, not a catalog one`);
    assert.equal(l.icon, "rewards");
    assert.equal(l.external, true, `${l.href} is marked as leaving the V2 shell`);
  }
  // The canonical label from lib/constants.ts.
  assert.equal(V2_NAV_LINKS.find((l) => l.href === "/loyalty")!.label, "مكافآت الجمال");
});

test("the catalog section is unchanged", () => {
  const catalog = V2_NAV_LINKS.filter((l) => l.section === "الكتالوج");
  assert.deepEqual(catalog.map((l) => l.href), ["/v2/catalog", "/v2/catalog/shopify"]);
  assert.deepEqual(catalog.map((l) => l.label), ["كتالوج ماليكاس", "كتالوج Shopify"]);
  for (const l of catalog) assert.equal(l.external, undefined, "V2 pages are not external");
});

test("links are grouped by section, in declaration order", () => {
  const sections = groupNavLinks();
  assert.deepEqual(sections.map((s) => s.title), ["الكتالوج", "العملاء"]);
  assert.deepEqual(sections[1]!.links.map((l) => l.href), LOYALTY_HREFS);
  const flat = sections.flatMap((s) => s.links.map((l) => l.href));
  assert.equal(flat.length, V2_NAV_LINKS.length);
  assert.equal(new Set(flat).size, flat.length, "no duplicate hrefs");
});

test("grouping tolerates malformed input without throwing", () => {
  assert.deepEqual(groupNavLinks([]), []);
  assert.deepEqual(groupNavLinks(null as never), []);
  assert.deepEqual(groupNavLinks([null as never]), []);
});

// ── These pages really are still reachable ───────────────────────────────────

test("no Beauty Rewards route is in the legacy-redirect list", () => {
  // The whole approach depends on these pages still working. Only /dashboard,
  // /products, /inventory and /platforms are redirected to V2.
  assert.ok(
    /LEGACY_PREFIXES: readonly string\[\] = \["\/dashboard", "\/products", "\/inventory", "\/platforms"\]/.test(
      REDIRECT_SRC,
    ),
    "the redirect list is exactly the four legacy admin prefixes",
  );
  for (const href of LOYALTY_HREFS) {
    for (const prefix of ["/dashboard", "/products", "/inventory", "/platforms"]) {
      assert.ok(!href.startsWith(prefix), `${href} is not redirected away`);
    }
  }
});

// ── The active-route rule still behaves ──────────────────────────────────────

test("adding external links did not disturb the V2 catalog routes", () => {
  assert.equal(activeNavHref("/v2/catalog"), "/v2/catalog");
  assert.equal(activeNavHref("/v2/catalog/shopify"), "/v2/catalog/shopify");
  assert.equal(activeNavHref("/v2/catalog/some-product-id"), "/v2/catalog");
});

test("longest-match still wins among the loyalty entries", () => {
  assert.equal(activeNavHref("/loyalty"), "/loyalty");
  assert.equal(activeNavHref("/loyalty/customers"), "/loyalty/customers");
  assert.equal(activeNavHref("/loyalty/prizes"), "/loyalty/prizes");
  // An unlisted sub-page falls back to its parent, not to a sibling.
  assert.equal(activeNavHref("/loyalty/voucher/abc123"), "/loyalty");
  // A mere prefix matches nothing.
  assert.equal(activeNavHref("/loyaltyx"), null);
});

// ── Sidebar rendering ────────────────────────────────────────────────────────

test("the sidebar renders grouped sections with a per-link icon", () => {
  assert.ok(/groupNavLinks\(\)/.test(SIDEBAR_SRC), "renders grouped sections");
  assert.ok(/\{section\.title\}/.test(SIDEBAR_SRC), "renders each section heading");
  assert.ok(/function RewardsIcon/.test(SIDEBAR_SRC), "rewards icon exists");
  assert.ok(/<NavIcon icon=\{link\.icon\} \/>/.test(SIDEBAR_SRC), "icon chosen per link");
  assert.ok(!/>الكتالوج<\/div>/.test(SIDEBAR_SRC), "the heading is data-driven, not hard-coded");
});

test("links that leave the V2 shell are visibly and accessibly marked", () => {
  assert.ok(/link\.external \?/.test(SIDEBAR_SRC), "external links render a marker");
  assert.ok(/يفتح في الواجهة السابقة/.test(SIDEBAR_SRC), "the marker says where it goes");
  assert.ok(/aria-label="يفتح في الواجهة السابقة"/.test(SIDEBAR_SRC), "announced to screen readers");
});

test("the sidebar still holds no write action and no data access", () => {
  for (const banned of [
    "createClient",
    "supabase",
    "process.env",
    "console.",
    "fetch(",
    ".insert(",
    ".update(",
    ".delete(",
    ".rpc(",
    "setInterval",
    "setTimeout",
  ]) {
    assert.ok(!SIDEBAR_SRC.includes(banned), `sidebar must not use ${banned}`);
  }
});

test("no Beauty Rewards page was reimplemented inside /v2", () => {
  // This phase links the working pages; it does not fork them. A /v2 copy would
  // create a second implementation of a live customer-facing feature.
  for (const l of V2_NAV_LINKS.filter((x) => x.section === "العملاء")) {
    assert.ok(!l.href.startsWith("/v2/"), `${l.href} points at the existing page, not a V2 fork`);
  }
});
