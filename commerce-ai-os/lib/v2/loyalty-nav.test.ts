// Tests for the «مكافآت الجمال» (Beauty Rewards) entries in the V2 sidebar.
// PURE tests only — no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/v2/loyalty-nav.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { V2_NAV_LINKS, activeNavHref, groupNavLinks } from "./nav.ts";
import { movedRoutePath } from "./legacy-redirect.ts";

const SIDEBAR_SRC = readFileSync(new URL("../../components/v2/V2Sidebar.tsx", import.meta.url), "utf8");
const REDIRECT_SRC = readFileSync(new URL("./legacy-redirect.ts", import.meta.url), "utf8");

const LOYALTY_HREFS = [
  "/v2/loyalty",
  "/v2/loyalty/customers",
  "/v2/loyalty/prizes",
  "/v2/loyalty/cards",
  "/v2/loyalty/qr",
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
  }
  // The admin pages now live inside V2 and render in the V2 shell.
  for (const l of links.filter((x) => x.href.startsWith("/v2/"))) {
    assert.equal(l.external, undefined, `${l.href} is an internal V2 page now`);
  }
  // …and only the public customer card still leaves the shell.
  assert.equal(V2_NAV_LINKS.find((l) => l.href === "/rewards")!.external, true);
  assert.equal(V2_NAV_LINKS.find((l) => l.href === "/v2/loyalty")!.label, "مكافآت الجمال");
});

test("the catalog section is unchanged", () => {
  const catalog = V2_NAV_LINKS.filter((l) => l.section === "الكتالوج");
  assert.deepEqual(catalog.map((l) => l.href), ["/v2/catalog", "/v2/catalog/shopify"]);
  assert.deepEqual(catalog.map((l) => l.label), ["كتالوج ماليكاس", "كتالوج Shopify"]);
  for (const l of catalog) assert.equal(l.external, undefined, "V2 pages are not external");
});

test("links are grouped by section, in declaration order", () => {
  const sections = groupNavLinks();
  // UX.1 added «الإعدادات» and «أدوات إضافية ↗» after «العملاء».
  // NAV.1 surfaced the OPS sub-centers under «العمليات» and added «التحليلات».
  assert.deepEqual(sections.map((s) => s.title), [
    "الكتالوج",
    "العمليات",
    "التحليلات",
    "العملاء",
    "الإعدادات",
    "أدوات إضافية ↗",
  ]);
  assert.deepEqual(sections[1]!.links.map((l) => l.href), [
    "/v2/operations",
    "/v2/operations/media",
    "/v2/operations/channels",
    "/v2/operations/ai",
    "/v2/operations/health",
    "/v2/tasks",
  ]);
  assert.deepEqual(sections[2]!.links.map((l) => l.href), ["/v2/analytics"]);
  assert.deepEqual(sections[3]!.links.map((l) => l.href), LOYALTY_HREFS);
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

test("the legacy admin block is unchanged", () => {
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
      assert.ok(!href.startsWith(prefix), `${href} is not caught by the legacy block`);
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
  assert.equal(activeNavHref("/v2/loyalty"), "/v2/loyalty");
  assert.equal(activeNavHref("/v2/loyalty/customers"), "/v2/loyalty/customers");
  assert.equal(activeNavHref("/v2/loyalty/prizes"), "/v2/loyalty/prizes");
  // An unlisted sub-page falls back to its parent, not to a sibling.
  assert.equal(activeNavHref("/v2/loyalty/voucher/abc123"), "/v2/loyalty");
  // A mere prefix matches nothing.
  assert.equal(activeNavHref("/v2/loyaltyx"), null);
  // The catalog is unaffected by a sibling V2 section.
  assert.equal(activeNavHref("/v2/catalog"), "/v2/catalog");
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

test("the admin pages were MOVED, not duplicated", () => {
  // The port relocates the existing pages into the V2 route group; there must be
  // no surviving copy under the legacy (app) group.
  const movedFiles = [
    "page.tsx",
    "LoyaltyClient.tsx",
    "actions.ts",
    "customers/page.tsx",
    "prizes/page.tsx",
    "cards/page.tsx",
    "qr/page.tsx",
    "voucher/[id]/page.tsx",
  ];
  for (const f of movedFiles) {
    assert.ok(
      existsSync(new URL(`../../app/(v2)/v2/loyalty/${f}`, import.meta.url)),
      `${f} lives under (v2)`,
    );
    assert.ok(
      !existsSync(new URL(`../../app/(app)/loyalty/${f}`, import.meta.url)),
      `${f} no longer exists under (app)`,
    );
  }
});

test("moved loyalty pages do not link back through the legacy route", () => {
  const client = readFileSync(
    new URL("../../app/(v2)/v2/loyalty/LoyaltyClient.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    /href=\{`\/v2\/loyalty\/voucher\/\$\{c\.id\}`\}/.test(client),
    "voucher links stay inside the V2 shell",
  );
  assert.ok(
    !/href=\{`\/loyalty\/voucher\//.test(client),
    "voucher links never bounce through the legacy redirect",
  );
});

// ── Old bookmarks still land on the moved pages ──────────────────────────────

test("moved routes keep their sub-path", () => {
  assert.equal(movedRoutePath("/loyalty"), "/v2/loyalty");
  assert.equal(movedRoutePath("/loyalty/customers"), "/v2/loyalty/customers");
  assert.equal(movedRoutePath("/loyalty/prizes"), "/v2/loyalty/prizes");
  assert.equal(movedRoutePath("/loyalty/cards"), "/v2/loyalty/cards");
  assert.equal(movedRoutePath("/loyalty/qr"), "/v2/loyalty/qr");
  assert.equal(movedRoutePath("/loyalty/voucher/abc123"), "/v2/loyalty/voucher/abc123");
});

test("the public customer card is NEVER moved behind the auth gate", () => {
  // /rewards is opened from the printed QR by people with no account.
  assert.equal(movedRoutePath("/rewards"), null);
});

test("the moved-route rule cannot loop and ignores unrelated paths", () => {
  assert.equal(movedRoutePath("/v2/loyalty"), null, "already moved");
  assert.equal(movedRoutePath("/v2/loyalty/customers"), null);
  assert.equal(movedRoutePath("/v2/catalog"), null);
  assert.equal(movedRoutePath("/loyaltyx"), null, "prefix must end on a segment");
  assert.equal(movedRoutePath("/login"), null);
  assert.equal(movedRoutePath(""), null);
  assert.equal(movedRoutePath(null), null);
  assert.equal(movedRoutePath(undefined), null);
});

test("middleware applies the move while PRESERVING the query string", () => {
  const mw = readFileSync(new URL("../supabase/middleware.ts", import.meta.url), "utf8");
  assert.ok(/movedRoutePath\(path\)/.test(mw), "middleware consults the moved-route rule");
  const block = mw.slice(mw.indexOf("const moved = movedRoutePath(path)"), mw.indexOf("const dest = legacyRedirectPath"));
  assert.ok(/movedUrl\.pathname = moved/.test(block), "rewrites the path");
  assert.ok(!/movedUrl\.search = ""/.test(block), "does NOT clear the query — filters must survive");
});

test("the static card artwork keeps its public path", () => {
  // public/loyalty/beauty-card.png is served at /loyalty/beauty-card.png and is
  // excluded from the proxy matcher by extension, so it must not be rewritten.
  const cards = readFileSync(new URL("../../app/(v2)/v2/loyalty/cards/page.tsx", import.meta.url), "utf8");
  assert.ok(/const CARD_SRC = "\/loyalty\/beauty-card\.png"/.test(cards), "asset path unchanged");
  assert.ok(!/\/v2\/loyalty\/beauty-card\.png/.test(cards), "asset was not rewritten as a route");
  const proxy = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
  assert.ok(/png\|jpg/.test(proxy), "image extensions are excluded from the proxy matcher");
});

test("the legacy sidebar keeps its own link and stays V2-free", () => {
  // The legacy interface is deliberately isolated from V2 (no /v2 links in
  // AppShell/Sidebar/BottomNav/constants). Its Beauty Rewards entry therefore
  // still says /loyalty — and the moved-route redirect carries it to the new
  // page, so the link works without breaking that isolation.
  const constants = readFileSync(new URL("../constants.ts", import.meta.url), "utf8");
  assert.ok(/href: "\/loyalty", label: "مكافآت الجمال"/.test(constants), "legacy entry unchanged");
  assert.ok(!/\/v2\/loyalty/.test(constants), "legacy constants never link into V2");
  assert.equal(movedRoutePath("/loyalty"), "/v2/loyalty", "the redirect makes that link work");
});
