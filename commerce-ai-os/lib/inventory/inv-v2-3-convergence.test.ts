// INV.V2.3 — Inventory Sub-Center Convergence guard (source scan + pure rules).
// Proves this phase is CONVERGENCE/ROUTING ONLY:
//   • every hub destination resolves to a real /v2/inventory/* page;
//   • every V2 wrapper renders the EXISTING legacy component (no copied logic,
//     no DB client, no writes, no engine calls of its own);
//   • the reports wrapper forwards searchParams (?days=… lands on the same view);
//   • legacy /inventory/* is relocated via the moved-prefix map, and the
//     middleware's moved branch preserves the query string;
//   • the embedded legacy surfaces link ONLY to canonical /v2/inventory/* for
//     daily navigation (no legacy-shell jump remains);
//   • canonical authority untouched: quantity mutations still delegate to the
//     Inventory Engine and availability to the Availability Engine — no direct
//     stock_quantity / stock_status write anywhere in the touched surfaces.
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-v2-3-convergence.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { INVENTORY_HUB_LINKS } from "./hub.ts";
import { movedRoutePath, NEEDS_MIGRATION_PREFIXES } from "../v2/legacy-redirect.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ["app/(v2)/v2/inventory/movements/page.tsx", "@/app/(app)/inventory/movements/page"],
  ["app/(v2)/v2/inventory/stocktake/page.tsx", "@/app/(app)/inventory/stocktake/page"],
  ["app/(v2)/v2/inventory/shelves/page.tsx", "@/app/(app)/inventory/shelves/page"],
  ["app/(v2)/v2/inventory/shelves/labels/page.tsx", "@/app/(app)/inventory/shelves/labels/page"],
  ["app/(v2)/v2/inventory/out-of-stock/page.tsx", "@/app/(app)/inventory/out-of-stock/page"],
  ["app/(v2)/v2/inventory/approvals/page.tsx", "@/app/(app)/inventory/approvals/page"],
  ["app/(v2)/v2/inventory/reports/page.tsx", "@/app/(app)/inventory/reports/page"],
  ["app/(v2)/v2/inventory/labels/page.tsx", "@/app/(app)/inventory/labels/page"],
];

const BANNED_IN_WRAPPERS = [
  "createClient", "createAdminClient", '"use server"', ".rpc(", ".from(", ".insert(", ".update(", ".delete(",
  "stock_quantity", "stock_status", "setAbsolute", "applyMovement", "setProductAvailabilityState",
];

test("every hub destination resolves to a real /v2/inventory page (no dead quick link)", () => {
  for (const link of INVENTORY_HUB_LINKS) {
    const rel = `app/(v2)/v2${link.href.replace(/^\/v2/, "")}/page.tsx`;
    assert.ok(existsSync(join(ROOT, rel)), `${link.href} → ${rel} exists`);
  }
});

test("every V2 wrapper reuses the legacy component and holds ZERO business logic", () => {
  for (const [wrapper, legacyImport] of WRAPPERS) {
    const s = read(wrapper);
    assert.ok(s.includes(`"${legacyImport}"`), `${wrapper} imports the EXISTING legacy page (${legacyImport})`);
    for (const banned of BANNED_IN_WRAPPERS) {
      assert.equal(s.includes(banned), false, `${wrapper} must not contain ${banned}`);
    }
    assert.ok(s.includes('href="/v2/inventory"'), `${wrapper} carries the hub breadcrumb`);
  }
});

test("reports wrapper forwards searchParams so ?days=… keeps working", () => {
  const s = read("app/(v2)/v2/inventory/reports/page.tsx");
  assert.match(s, /searchParams.*Promise<\{ days\?: string \}>/, "typed pass-through");
  assert.match(s, /searchParams=\{searchParams\}/, "forwarded to the legacy component");
});

test("legacy /inventory/* relocates via the moved-prefix map; middleware keeps the query", () => {
  assert.equal(NEEDS_MIGRATION_PREFIXES.includes("/inventory"), false, "no longer NEEDS_MIGRATION");
  for (const link of INVENTORY_HUB_LINKS) {
    const legacy = link.href.replace(/^\/v2/, "");
    assert.equal(movedRoutePath(legacy), link.href, `${legacy} → ${link.href}`);
  }
  // middleware's moved branch keeps request.nextUrl.search untouched (unlike the
  // legacy funnel, which clears it) — that is what preserves ?days=…
  const mw = read("lib/supabase/middleware.ts");
  const movedBlock = /const moved = movedRoutePath\(path\);[\s\S]*?NextResponse\.redirect\(movedUrl\);/.exec(mw)?.[0] ?? "";
  assert.ok(movedBlock.length > 0, "middleware wires movedRoutePath");
  assert.equal(/movedUrl\.search\s*=/.test(movedBlock), false, "moved redirects never clear the query string");
});

test("no daily legacy /inventory href remains inside the embedded surfaces (V2-only navigation)", () => {
  const pages = [
    "app/(app)/inventory/page.tsx",
    ...WRAPPERS.map(([, imp]) => `${imp.replace("@/", "")}.tsx`),
  ];
  for (const rel of pages) {
    const s = read(rel);
    assert.equal(/href="\/inventory/.test(s), false, `${rel} links only to canonical /v2/inventory/*`);
  }
});

test("canonical authority untouched: engine/availability delegation pinned, no direct writes introduced", () => {
  const actions = read("app/(app)/inventory/actions.ts");
  assert.match(actions, /setAbsolute\(admin, id, stock\)/, "absolute quantity → Inventory Engine");
  assert.match(actions, /applyMovement\(/, "movements → Inventory Engine");
  assert.match(actions, /setProductAvailabilityState/, "availability → Availability Engine");
  assert.doesNotMatch(actions, /stock_quantity\s*:\s*inStock/);
  // this phase changed ONLY hrefs inside the legacy pages — never their actions:
  // the actions module keeps zero references to V2 routes (no coupling added).
  assert.equal(actions.includes("/v2/inventory"), false, "actions.ts untouched by convergence");
});
