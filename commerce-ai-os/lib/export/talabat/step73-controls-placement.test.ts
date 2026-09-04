// STEP 73 — the Talabat package-generation section ("توليد حزمة طلبات") moved
// from the BOTTOM of the preview page (below the results table) to the TOP:
// under the headline summary cards, above reasons-by-type / filters / table.
//
// LAYOUT ONLY. The section is relocated as a whole through a positional slot —
// the same <TalabatPackageControls> element with the same plan prop — so its
// markup, stat cards, blue notice, buttons and disabled states are untouched.
//
// Rendering is asserted by source scan: the runner uses --conditions=react-server,
// under which react-dom/server refuses to load, so a client component cannot be
// rendered to markup here (same idiom as the INT.2A/2B guards and STEP 71).
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step73-controls-placement.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const PAGE = "app/(v2)/v2/export/[destination]/page.tsx";
const PREVIEW = "components/v2/export/TalabatPreview.tsx";
const CONTROLS = "components/v2/export/TalabatPackageControls.tsx";

// ── 1: the section renders exactly once, through the top slot ───────────────

test("1: the package section renders exactly ONCE, via afterSummary", () => {
  const page = code(PAGE);
  assert.equal((page.match(/<TalabatPackageControls\s/g) ?? []).length, 1, "rendered exactly once");
  assert.match(page, /afterSummary=\{<TalabatPackageControls plan=\{previewGenerationPlan\(result\.rows, \{ mode: "ready" \}\)\} \/>\}/,
    "passed through the slot with the SAME plan prop as before");
});

test("2: it no longer renders at the bottom, after the preview element", () => {
  const page = code(PAGE);
  // the old shape was: <TalabatPreview ... />  then  <TalabatPackageControls .../>
  assert.equal(
    /\/>\s*\n\s*<TalabatPackageControls/.test(page), false,
    "no sibling render after the closing preview tag",
  );
  // the only mention sits inside the TalabatPreview element's props
  const el = page.slice(page.indexOf("<TalabatPreview"), page.indexOf("</>", page.indexOf("<TalabatPreview")));
  assert.equal((el.match(/<TalabatPackageControls/g) ?? []).length, 1, "the sole render is inside the preview element");
});

// ── 3: placement — after the summary, before reasons/filters/table ─────────

test("3: the slot renders under the headline stats and above reasons/filters/table", () => {
  const c = code(PREVIEW);
  const slot = c.indexOf("{afterSummary ?? null}");
  assert.ok(slot > 0, "the slot is rendered");
  const summaryCards = c.indexOf("SummaryCard value={vm.summary.total}");
  const counts = c.indexOf("صف قابل للبيع");
  const reasons = c.indexOf("أسباب حسب النوع");
  const filters = c.indexOf('placeholder="بحث بالـ SKU');
  const table = c.indexOf("<table");
  for (const [name, i] of [["summary cards", summaryCards], ["counts line", counts]] as const) {
    assert.ok(i > 0 && i < slot, `${name} comes BEFORE the slot`);
  }
  for (const [name, i] of [["reasons", reasons], ["filters", filters], ["table", table]] as const) {
    assert.ok(i > slot, `${name} comes AFTER the slot`);
  }
});

// ── 4: the section itself is byte-unchanged ────────────────────────────────

test("4: the moved section's own content is untouched", () => {
  const ctl = raw(CONTROLS);
  assert.match(ctl, /<h2 className="text-sm font-semibold text-ink">توليد حزمة طلبات<\/h2>/, "title");
  assert.match(ctl, /توليد حزمة الجاهزة/, "generate button label");
  assert.match(ctl, /نشر إلى طلبات \(غير متاح\)/, "publish button label + disabled wording");
  assert.match(ctl, /أسباب الحظر \(مُستبعَدة من الحزمة\)/, "blocked-reasons block");
  // the slot is positional only: it introduces no wrapper markup of its own
  assert.match(code(PREVIEW), /\{afterSummary \?\? null\}/, "rendered verbatim, no wrapper div");
});

// ── 5: no business logic changed ───────────────────────────────────────────

test("5: no export, pricing or counting logic changed", () => {
  const page = code(PAGE);
  // the plan is still computed from the same rows with the same mode
  assert.equal((page.match(/previewGenerationPlan\(result\.rows, \{ mode: "ready" \}\)/g) ?? []).length, 1);
  // the preview still receives the same VM fields
  for (const f of ["summary: result.summary", "counts: result.counts", "primaryImageUrl: r.primaryImageUrl"]) {
    assert.ok(page.includes(f), `${f} still passed`);
  }
  // the presentational component still does no I/O and derives no rule
  const c = code(PREVIEW);
  for (const forbidden of ["createClient", "supabase", "fetch(", "resolveTalabatSellingPrice", "previewGenerationPlan"]) {
    assert.equal(c.includes(forbidden), false, `${forbidden} must not appear in the preview component`);
  }
  // STEP 71 thumbnails survive the move
  assert.match(c, /<ProductThumb/);
  assert.match(c, /imageUrl=\{r\.primaryImageUrl\}/);
});
