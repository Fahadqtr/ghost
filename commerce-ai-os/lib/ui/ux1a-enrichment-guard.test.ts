// UX.1A — AI Enrichment UX polish guard (source scan). Proves the polish is
// UI-ONLY and wires every required affordance:
//   • three-level select controls (page / all filtered / clear) + "X of Y" counter
//   • sticky bulk toolbar hosting the existing Apply/Generate actions (not dupes)
//   • client-side pagination (huge filtered sets never render every checkbox)
//   • clamped long values with expand/collapse + copy + full-text tooltip
//   • empty state; clearer row accents
//   • NO schema / business-logic / server-action / DB changes; component stays
//     DB-free and still calls the SAME four enrichment actions.
// node --conditions=react-server --experimental-strip-types --test lib/ui/ux1a-enrichment-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const COMPONENT = "components/v2/operations/AiEnrichment.tsx";
const TOOLBAR = "components/v2/ui/SelectionToolbar.tsx";
const CLAMP = "components/v2/ui/ClampText.tsx";
const EMPTY = "components/v2/ui/EmptyState.tsx";
const SELECTION = "lib/ui/selection.ts";
const PAGINATION = "lib/ui/pagination.ts";
const TEXT = "lib/ui/text.ts";
const ACTIONS = "app/(v2)/v2/operations/ai-enrichment-actions.ts";

// ── pure helpers stay pure (framework-free, no writes) ────────────────────────
test("lib/ui helpers are pure (no @/ imports, no React, no I/O)", () => {
  for (const f of [SELECTION, PAGINATION, TEXT]) {
    const s = read(f);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} has no @/ import`);
    assert.equal(/from\s+["']react["']|useState|"use client"/.test(s), false, `${f} is not a React module`);
    assert.equal(/\.from\(|\.insert\(|\.update\(|createClient/.test(s), false, `${f} performs no I/O`);
  }
});

// ── three-level select controls + always-visible counter ──────────────────────
test("the sticky toolbar offers page / all-filtered / clear and an X-of-Y counter", () => {
  const t = read(TOOLBAR);
  assert.ok(/\bsticky\b/.test(t), "toolbar is sticky");
  assert.ok(/formatSelectionCount\(/.test(t), "renders the X of Y counter");
  assert.ok(/onSelectPage/.test(t) && /onSelectAllFiltered/.test(t) && /onClear/.test(t), "all three select levels");
  assert.ok(/تحديد الصفحة/.test(t) && /تحديد كل النتائج/.test(t) && /مسح التحديد/.test(t), "labelled controls");
});

// ── component wires the toolbar for BOTH selectable tables, hosting real actions ─
test("the component hosts existing Apply/Generate actions inside the toolbar (no duplicates)", () => {
  const c = read(COMPONENT);
  assert.ok(/<SelectionToolbar/.test(c), "uses the sticky selection toolbar");
  // Apply still operates on the current suggestion selection (unchanged behavior)
  assert.ok(/onClick=\{apply\}/.test(c), "Apply button retained");
  assert.ok(/تطبيق المحدَّد \(\{sugSelectedCount\}\)/.test(c), "Apply reflects the live selection count");
  // Generate retained inside the scan toolbar
  assert.ok(/onClick=\{generateSelected\}/.test(c) && /onClick=\{generateAll\}/.test(c), "Generate actions retained");
});

// ── pagination keeps rendering bounded (no thousands of checkboxes) ────────────
test("both tables paginate the rendered rows (bounded render)", () => {
  const c = read(COMPONENT);
  assert.ok(/paginate\(/.test(c), "uses the pure paginate helper");
  assert.ok(/scanPageView\.pageItems\.map/.test(c), "scan table renders only the current page");
  assert.ok(/sugPageView\.pageItems\.map/.test(c), "suggestions table renders only the current page");
  // selecting all filtered grows the key set, it does not render every row
  assert.ok(/selectKeys\(prev, scanAllKeys\)/.test(c) && /selectKeys\(prev, sugAllKeys\)/.test(c), "select-all-filtered works on keys, not rendered rows");
});

// ── long values are clamped with expand/collapse + copy + tooltip, no truncation ─
test("ClampText clamps to 3 lines with expand/collapse, copy, and a full-text tooltip", () => {
  const clamp = read(CLAMP);
  assert.ok(/WebkitLineClamp:\s*CLAMP_LINES/.test(clamp), "clamps to CLAMP_LINES");
  assert.ok(/isExpandableText\(/.test(clamp), "decides the toggle via the pure heuristic");
  assert.ok(/navigator\.clipboard\.writeText/.test(clamp), "copy-to-clipboard preserved");
  assert.ok(/title=\{value\}/.test(clamp), "full text in the tooltip (no data truncation)");
  assert.ok(/aria-expanded/.test(clamp), "accessible expand/collapse");
  // the suggestions table renders values through ClampText (both current + suggested)
  const c = read(COMPONENT);
  assert.ok((c.match(/<ClampText/g) ?? []).length >= 2, "current + suggested values are clamped");
});

// ── empty state ───────────────────────────────────────────────────────────────
test("an empty scan/suggestions set renders a proper empty state, not a blank table", () => {
  const e = read(EMPTY);
  assert.ok(/<svg/.test(e) && /role="img"/.test(e), "illustration");
  const c = read(COMPONENT);
  assert.ok(/<EmptyState/.test(c), "component shows the empty state");
  assert.ok(/scanRows\.length === 0/.test(c), "empty state gates on zero rows");
});

// ── row accents (§4): READY green, selected blue, needs-attention orange/red ───
test("rows carry status/selection accents", () => {
  const c = read(COMPONENT);
  assert.ok(/border-s-blue-400/.test(c), "selected → blue accent");
  assert.ok(/border-s-emerald-400/.test(c), "READY → green accent");
  assert.ok(/border-s-amber-400/.test(c) && /border-s-rose-400/.test(c), "needs-attention → orange/red accent");
});

// ── UI-ONLY: no schema / logic / API / DB changes in the polish ───────────────
test("the polish is UI-only: no DB access and the SAME four enrichment actions", () => {
  const c = read(COMPONENT);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /@anthropic-ai/]) {
    assert.equal(bad.test(c), false, `component must not contain ${bad}`);
  }
  for (const act of ["scanEnrichmentAction", "generateEnrichmentAction", "generateAllEligibleAction", "applyEnrichmentAction"]) {
    assert.ok(c.includes(act), `still calls ${act} (API unchanged)`);
  }
  // the new UI components perform no writes / DB access either
  for (const f of [TOOLBAR, CLAMP, EMPTY]) {
    const s = read(f);
    assert.equal(/\.from\(|\.insert\(|\.update\(|createClient|@\/lib\/supabase/.test(s), false, `${f} is presentational only`);
  }
  // the server actions file is untouched by this phase (no new exports referenced)
  assert.ok(/scanEnrichmentAction|generateEnrichmentAction/.test(read(ACTIONS)), "actions module still present");
});
