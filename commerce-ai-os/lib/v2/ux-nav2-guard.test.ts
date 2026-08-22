// UX.NAV.2 — Navigation & Legacy Surface Cleanup guard (source scan + nav model).
// Proves this phase is navigation/UX ONLY and pins the acceptance criteria:
//   • ONE obvious sidebar path per operator concern (no duplicated certified
//     functionality, no dead links — existence is enforced by nav.test.ts /
//     nav1-guard.test.ts route checks);
//   • the sidebar has collapsible groups but still drives from the ONE pure nav
//     model (no second navigation system);
//   • the Media Center is the canonical media overview with contextual quick
//     actions to the related certified surfaces;
//   • diagnostic/developer UI (MEDIA.1C-HOTFIX3) is tucked behind «تشخيص متقدم»
//     and the per-mode trace suffix never dominates a normal operator row
//     (display-only strip; the model and CSV keep the full evidence);
//   • the retired legacy export page redirects to the Export Center dashboard
//     and no legacy export generator is reintroduced.
// node --conditions=react-server --experimental-strip-types --test lib/v2/ux-nav2-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { V2_NAV_LINKS } from "./nav.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SIDEBAR = "components/v2/V2Sidebar.tsx";
const MEDIA_PAGE = "app/(v2)/v2/operations/media/page.tsx";
const DISCOVERY_PAGE = "app/(v2)/v2/operations/media/discovery/page.tsx";
const BULK_UI = "components/v2/operations/SnoonuBulkRecovery.tsx";
const LEGACY_EXPORT = "app/(app)/import-export/export/page.tsx";
const LEGACY_HUB = "app/(app)/import-export/page.tsx";

// ── acceptance: ONE obvious sidebar path per concern ──────────────────────────
test("one canonical sidebar entry per operator concern (exact href + label)", () => {
  const CANONICAL: ReadonlyArray<readonly [string, string, string]> = [
    ["catalog", "/v2/catalog", "كتالوج ماليكاس"],
    ["launch blockers", "/v2/catalog/launch", "حملة الإطلاق"],
    ["images", "/v2/operations/media", "مركز الصور"],
    ["snoonu image recovery", "/v2/operations/media?storefront=snoonu:malikas", "استرجاع الصور الناقصة"],
    ["session setup", "/v2/settings/connections/snoonu/session-helper", "جلسة Snoonu"],
    ["channel health", "/v2/operations/channels", "مركز القنوات"],
    ["export", "/v2/export", "مركز التصدير"],
    ["analytics", "/v2/analytics", "لوحة الإدارة"],
    ["rewards", "/v2/loyalty", "مكافآت الجمال"],
    ["legacy sync tools", "/import-export", "الاستيراد والمزامنة (قديم)"],
  ];
  for (const [concern, href, label] of CANONICAL) {
    const hits = V2_NAV_LINKS.filter((l) => l.href === href);
    assert.equal(hits.length, 1, `${concern}: exactly one sidebar entry (${href})`);
    assert.equal(hits[0]!.label, label, `${concern}: canonical label`);
  }
  // and no label is ever reused for a second entry (no duplicated feature)
  const labels = V2_NAV_LINKS.map((l) => l.label);
  assert.equal(labels.length, new Set(labels).size, "every sidebar label is unique");
});

// ── sidebar: collapsible groups, still ONE nav system ─────────────────────────
test("sidebar groups are collapsible natively and still render from the pure nav model", () => {
  const s = read(SIDEBAR);
  assert.ok(/<details/.test(s) && /<summary/.test(s), "expanded groups are native <details>/<summary> (no custom nav state system)");
  assert.ok(/groupNavLinks\(\)/.test(s), "still renders the shared grouped link list");
  assert.ok(/activeNavHref\s*\(/.test(s) && /activeNavSection\s*\(/.test(s), "highlight still comes from the pure rules");
  assert.equal(/useState|useEffect|useReducer/.test(strip(s)), false, "no bespoke collapse state — DOM-native only");
});

// ── Media Center: canonical overview + contextual quick actions ───────────────
test("Media Center page offers the contextual quick actions (existing certified routes only)", () => {
  const s = read(MEDIA_PAGE);
  for (const href of ["/v2/operations/media/discovery", "/v2/catalog/launch", "/v2/settings/connections/snoonu/session-helper"]) {
    assert.ok(s.includes(`"${href}"`), `quick action → ${href}`);
  }
  // recovery is the bulk card on this very page — no self-link needed, and the
  // page keeps its read-only assembly (writer gate + reader untouched).
  assert.ok(/requireMalakWriter\(/.test(s) && /loadMediaCenter\(/.test(s), "page assembly unchanged");
});

// ── diagnostics never dominate the operator view ──────────────────────────────
test("discovery diagnostics live behind a collapsed «تشخيص متقدم» disclosure (owner-only unchanged)", () => {
  const s = read(DISCOVERY_PAGE);
  assert.ok(/تشخيص متقدم/.test(s), "advanced-diagnostics label present");
  const details = /<details[\s\S]*?<\/details>/.exec(s)?.[0] ?? "";
  assert.ok(/SnoonuSearchDiagnostics/.test(details), "the diagnostics panel renders INSIDE the disclosure");
  assert.ok(/owner\s*&&/.test(s), "still owner-gated");
  assert.equal(/<details[^>]*\bopen\b/.test(s), false, "disclosure starts collapsed");
});

test("bulk rows show the plain reason; the per-mode trace stays in the tooltip (display-only strip)", () => {
  const s = read(BULK_UI);
  assert.ok(/stripModeTraceSuffix\(r\.reason\)/.test(s), "rows render the stripped reason");
  assert.ok(/title=\{r\.reason\}/.test(s), "the FULL reason (evidence suffix included) stays in the tooltip");
  // the strip is presentation-only: the pure model still appends the suffix
  const model = read("lib/adapters/snoonu/merchant/recovery-model.ts");
  assert.ok(/formatModeTraceReason/.test(model), "model-level evidence untouched");
});

// ── legacy surfaces: redirect, don't duplicate ────────────────────────────────
test("retired legacy export page redirects to the Export Center dashboard; no generator reintroduced", () => {
  const s = read(LEGACY_EXPORT);
  assert.ok(/redirect\("\/v2\/export"\)/.test(s), "permanent redirect → /v2/export");
  assert.equal(/TalabatExport|ExportButtons|xlsx/i.test(strip(s)), false, "no legacy export UI/generator remains");
});

test("legacy hub points at the certified V2 surfaces and reintroduces no export tool", () => {
  const s = read(LEGACY_HUB);
  assert.ok(s.includes('"/v2/operations/media"'), "hub points to the canonical Media Center");
  assert.ok(s.includes('"/v2/catalog/import"'), "hub points to the V2 importer");
  assert.ok(s.includes('"/import-export/export"'), "export card goes through the retired page's redirect");
  assert.equal(/ExportButtons|TalabatExport/.test(s), false, "no legacy export component on the hub");
});

// ── this phase is navigation/UX only ──────────────────────────────────────────
test("UX.NAV.2 touches no engine: nav model stays pure; touched pages issue no new writes", () => {
  const nav = strip(read("lib/v2/nav.ts"));
  for (const bad of [/process\.env/, /\bfetch\(/, /\.from\(/, /\.insert\(/, /\.update\(/, /\.delete\(/, /\.rpc\(/]) {
    assert.equal(bad.test(nav), false, `nav model must not contain ${bad}`);
  }
  for (const f of [MEDIA_PAGE, DISCOVERY_PAGE, LEGACY_HUB, LEGACY_EXPORT]) {
    const s = strip(read(f));
    for (const bad of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /storePrimaryProductImage/]) {
      assert.equal(bad.test(s), false, `${f} must not contain ${bad}`);
    }
  }
});
