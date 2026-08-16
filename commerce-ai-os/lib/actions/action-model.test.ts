// AI.1 — Action model tests (§11: Registry, Grouping, Filters, Severity,
// Confidence, Delegation). PURE — no DB, no network, no rendering.
// node --conditions=react-server --experimental-strip-types --test lib/actions/action-model.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import {
  ACTION_TYPES,
  ACTION_REGISTRY,
  buildActionCenter,
  deriveLane,
  filterActions,
  groupActionsByType,
  normalizeAction,
  sortActions,
  summarizeActions,
  type Action,
  type ActionInput,
  type ActionType,
} from "./action-model.ts";

const base = (over: Partial<ActionInput> = {}): ActionInput => ({
  id: over.id ?? "IMAGE_REQUIRED:analytics:catalog",
  type: over.type ?? "IMAGE_REQUIRED",
  source: over.source ?? "analytics",
  confidence: over.confidence ?? "high",
  title: over.title ?? "t",
  reason: over.reason ?? "r",
  evidence: over.evidence ?? [],
  currentState: over.currentState ?? null,
  suggestedState: over.suggestedState ?? null,
  entityId: over.entityId ?? null,
  entityLabel: over.entityLabel ?? null,
  workflowHref: over.workflowHref ?? null,
  ...over,
});

// ── Registry (§2) ─────────────────────────────────────────────────────────────
test("registry has an entry for every action type, incl. UNKNOWN", () => {
  assert.equal(ACTION_TYPES.length, 16);
  assert.ok(ACTION_TYPES.includes("UNKNOWN"));
  for (const t of ACTION_TYPES) {
    const spec = ACTION_REGISTRY[t];
    assert.ok(spec, `${t} has a registry entry`);
    assert.ok(spec.label.length > 0, `${t} has a label`);
    assert.ok(spec.workflow.startsWith("/"), `${t} workflow is a route`);
    assert.ok(["critical", "warning", "info"].includes(spec.defaultSeverity));
  }
});

// ── Delegation (§6 Open Original Workflow) ────────────────────────────────────
test("every action delegates to an EXISTING workflow route (no executor, real page)", () => {
  const routeExists = (href: string): boolean => {
    if (href === "/v2/catalog") return existsSync(new URL("../../app/(v2)/v2/catalog/page.tsx", import.meta.url));
    if (href.startsWith("/v2/")) {
      const rel = href.replace(/^\/v2/, "");
      return existsSync(new URL(`../../app/(v2)/v2${rel}/page.tsx`, import.meta.url));
    }
    return false;
  };
  for (const t of ACTION_TYPES) {
    // normalize with no explicit href → registry workflow is the delegation target
    const a = normalizeAction(base({ type: t, id: `${t}:x:y` }));
    assert.ok(a.workflowHref, `${t} has a delegation href`);
    assert.ok(routeExists(a.workflowHref!), `${t} → ${a.workflowHref} resolves to a real page`);
  }
});

// ── Severity (§ default + override) ───────────────────────────────────────────
test("severity defaults from the registry and can be overridden by the source", () => {
  assert.equal(normalizeAction(base({ type: "OUT_OF_STOCK" })).severity, "critical");
  assert.equal(normalizeAction(base({ type: "KEYWORDS_UPDATE" })).severity, "info");
  assert.equal(normalizeAction(base({ type: "KEYWORDS_UPDATE", severity: "critical" })).severity, "critical");
});

test("unrecognized type collapses to UNKNOWN (never throws)", () => {
  const a = normalizeAction(base({ type: "NOPE" as ActionType, id: "NOPE:x:y" }));
  assert.equal(a.type, "UNKNOWN");
  assert.equal(a.workflowHref, ACTION_REGISTRY.UNKNOWN.workflow);
});

// ── Confidence + lane derivation (§5) ─────────────────────────────────────────
test("lane derivation: critical wins; blocked waits; auto-eligible needs high confidence", () => {
  assert.equal(deriveLane({ severity: "critical", confidence: "low", type: "OUT_OF_STOCK" }), "critical");
  assert.equal(deriveLane({ severity: "warning", confidence: "high", type: "BARCODE_REQUIRED", blocked: true }), "waiting");
  // KEYWORDS_UPDATE is auto-eligible in the registry
  assert.equal(deriveLane({ severity: "info", confidence: "high", type: "KEYWORDS_UPDATE" }), "auto_eligible");
  // same type but only medium confidence → needs approval, not auto
  assert.equal(deriveLane({ severity: "info", confidence: "medium", type: "KEYWORDS_UPDATE" }), "approval_required");
  // not auto-eligible type → approval
  assert.equal(deriveLane({ severity: "warning", confidence: "high", type: "IMAGE_REQUIRED" }), "approval_required");
});

// ── Sorting ───────────────────────────────────────────────────────────────────
test("sort orders by severity desc, then confidence desc", () => {
  const actions = [
    normalizeAction(base({ id: "a", type: "KEYWORDS_UPDATE" })), // info
    normalizeAction(base({ id: "b", type: "OUT_OF_STOCK" })), // critical
    normalizeAction(base({ id: "c", type: "BARCODE_REQUIRED" })), // warning
  ];
  const sorted = sortActions(actions);
  assert.deepEqual(sorted.map((a) => a.severity), ["critical", "warning", "info"]);
});

// ── Grouping (§5 grouped by type) ─────────────────────────────────────────────
test("grouping collects by type, orders by §4 order, group severity = worst", () => {
  const actions = [
    normalizeAction(base({ id: "k1", type: "KEYWORDS_UPDATE" })),
    normalizeAction(base({ id: "o1", type: "OUT_OF_STOCK" })),
    normalizeAction(base({ id: "o2", type: "OUT_OF_STOCK" })),
  ];
  const groups = groupActionsByType(actions);
  // IMAGE... KEYWORDS_UPDATE (idx 3) comes before OUT_OF_STOCK (idx 11)
  assert.deepEqual(groups.map((g) => g.type), ["KEYWORDS_UPDATE", "OUT_OF_STOCK"]);
  const oos = groups.find((g) => g.type === "OUT_OF_STOCK")!;
  assert.equal(oos.count, 2);
  assert.equal(oos.severity, "critical");
});

// ── Summary (§5) ──────────────────────────────────────────────────────────────
test("summary counts lanes and keeps Completed Today a placeholder (0)", () => {
  const actions: Action[] = [
    normalizeAction(base({ id: "1", type: "OUT_OF_STOCK" })), // critical
    normalizeAction(base({ id: "2", type: "IMAGE_REQUIRED" })), // approval
    normalizeAction(base({ id: "3", type: "KEYWORDS_UPDATE", confidence: "high" })), // auto
    normalizeAction(base({ id: "4", type: "BARCODE_REQUIRED", blocked: true })), // waiting
  ];
  const s = summarizeActions(actions);
  assert.equal(s.critical, 1);
  assert.equal(s.approvalRequired, 1);
  assert.equal(s.autoEligible, 1);
  assert.equal(s.waiting, 1);
  assert.equal(s.completedToday, 0);
  assert.equal(s.total, 4);
});

// ── Filters (§11) ─────────────────────────────────────────────────────────────
test("filterActions narrows by lane, type, severity, source, confidence and query", () => {
  const actions = [
    normalizeAction(base({ id: "1", type: "OUT_OF_STOCK", source: "analytics", title: "نفد الحليب" })),
    normalizeAction(base({ id: "2", type: "IMAGE_REQUIRED", source: "ops_media", title: "صورة سيروم" })),
  ];
  assert.equal(filterActions(actions, { lane: "critical" }).length, 1);
  assert.equal(filterActions(actions, { type: "IMAGE_REQUIRED" })[0]!.id, "2");
  assert.equal(filterActions(actions, { source: "ops_media" })[0]!.id, "2");
  assert.equal(filterActions(actions, { severity: "critical" })[0]!.id, "1");
  assert.equal(filterActions(actions, { query: "سيروم" })[0]!.id, "2");
  assert.equal(filterActions(actions, { query: "زبادي" }).length, 0);
});

// ── buildActionCenter dedup + shape ───────────────────────────────────────────
test("buildActionCenter de-duplicates by stable id and reports sources + generatedAt", () => {
  const view = buildActionCenter(
    [
      base({ id: "dup", type: "IMAGE_REQUIRED" }),
      base({ id: "dup", type: "IMAGE_REQUIRED" }), // same id → collapses
      base({ id: "other", type: "OUT_OF_STOCK" }),
    ],
    { sources: [{ source: "analytics", ok: true, count: 2 }], generatedAt: "2026-08-16T00:00:00.000Z" },
  );
  assert.equal(view.actions.length, 2);
  assert.equal(view.summary.total, 2);
  assert.equal(view.sources[0]!.source, "analytics");
  assert.equal(view.generatedAt, "2026-08-16T00:00:00.000Z");
  // malformed inputs are ignored, never thrown on
  const safe = buildActionCenter([null as never, undefined as never], {});
  assert.equal(safe.actions.length, 0);
});
