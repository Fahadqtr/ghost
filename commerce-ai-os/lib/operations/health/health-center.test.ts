// OPS.6 — Platform Health Center composer unit tests (§18). Pure — node:test loads
// it directly.
// node --conditions=react-server --experimental-strip-types --test lib/operations/health/health-center.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHealthCenter,
  buildCatalogHealth,
  buildInventoryHealth,
  buildAvailabilityHealth,
  buildChannelsHealth,
  buildAiHealth,
  buildMediaHealth,
  buildEclHealth,
  buildSecurityHealth,
  buildSystemHealth,
  buildOverall,
  buildFindings,
  worstStatus,
  parseHealthFilters,
  filterFindings,
  DOMAIN_ORDER,
  type HealthSignals,
  type DomainHealth,
} from "./health-center.ts";

// ── fixtures ───────────────────────────────────────────────────────────────────
function signals(over: Partial<HealthSignals> = {}): HealthSignals {
  return {
    catalog: { total: 200, active: 180, archived: 20, missingImages: 0, missingBarcode: 0, missingDescription: 0 },
    inventory: { negativeInventory: 0, negativeVariant: 0 },
    availability: { total: 200, unknown: 0, drift: 0 },
    channels: [{ key: "shopify:malikas", label: "Shopify", status: "HEALTHY", missingMappings: 0, needsReview: 0, conflicts: 0, operationalBlocked: false }],
    ai: { missingKeywords: 0, missingDescriptions: 0, providerConfigured: true },
    media: { missingImages: 0 },
    ecl: { totalMappings: 300, active: 300, needsReview: 0 },
    security: { ownerConfigured: true, extraWriterCount: 1, strictEnforcementCertified: true },
    system: { vercelEnv: "production", providerConfigured: true, recentFailures: 0, snoonuSessionState: "SESSION_REQUIRED" },
    ...over,
  };
}

// ── overall aggregation (§3) ─────────────────────────────────────────────────────
test("all-healthy domains → overall HEALTHY", () => {
  assert.equal(buildHealthCenter(signals()).overall.status, "HEALTHY");
});

test("any ACTION_REQUIRED → overall ACTION_REQUIRED (worst wins, reasons exposed)", () => {
  const m = buildHealthCenter(signals({ ecl: { totalMappings: 10, active: 5, needsReview: 5 } }));
  assert.equal(m.overall.status, "ACTION_REQUIRED");
  assert.ok(m.overall.reasons.includes("الهوية / ECL"));
});

test("worstStatus rank: ACTION_REQUIRED > OPERATIONALLY_BLOCKED > WARNING > UNKNOWN > HEALTHY", () => {
  assert.equal(worstStatus(["HEALTHY", "UNKNOWN", "WARNING"]), "WARNING");
  assert.equal(worstStatus(["WARNING", "OPERATIONALLY_BLOCKED"]), "OPERATIONALLY_BLOCKED");
  assert.equal(worstStatus(["OPERATIONALLY_BLOCKED", "ACTION_REQUIRED"]), "ACTION_REQUIRED");
  assert.equal(worstStatus(["HEALTHY", "UNKNOWN"]), "UNKNOWN"); // unknown outranks healthy
  assert.equal(worstStatus([]), "HEALTHY");
});

test("overall never claims HEALTHY when a domain is UNKNOWN", () => {
  const domains: DomainHealth[] = [
    { key: "catalog", label: "c", status: "HEALTHY", reasons: [], metrics: [], note: null },
    { key: "inventory", label: "i", status: "UNKNOWN", reasons: [], metrics: [], note: null },
  ];
  assert.equal(buildOverall(domains).status, "UNKNOWN");
});

// ── catalog (§4) ─────────────────────────────────────────────────────────────────
test("catalog: clean → HEALTHY; small gaps → WARNING; large gaps → ACTION_REQUIRED", () => {
  assert.equal(buildCatalogHealth({ total: 200, active: 200, archived: 0, missingImages: 0, missingBarcode: 0, missingDescription: 0 }).status, "HEALTHY");
  assert.equal(buildCatalogHealth({ total: 200, active: 200, archived: 0, missingImages: 3, missingBarcode: 0, missingDescription: 0 }).status, "WARNING");
  assert.equal(buildCatalogHealth({ total: 200, active: 200, archived: 0, missingImages: 30, missingBarcode: 10, missingDescription: 10 }).status, "ACTION_REQUIRED");
});

// ── inventory (§5) — strict enforcement + UNKNOWN ────────────────────────────────
test("inventory: zero negatives → HEALTHY; negatives → ACTION_REQUIRED; unread → UNKNOWN", () => {
  assert.equal(buildInventoryHealth({ negativeInventory: 0, negativeVariant: 0 }).status, "HEALTHY");
  assert.equal(buildInventoryHealth({ negativeInventory: 2, negativeVariant: 0 }).status, "ACTION_REQUIRED");
  assert.equal(buildInventoryHealth({ negativeInventory: null, negativeVariant: null }).status, "UNKNOWN");
});

// ── availability (§6) ────────────────────────────────────────────────────────────
test("availability: drift → WARNING; explicit separation note; unread unknown → UNKNOWN", () => {
  assert.equal(buildAvailabilityHealth({ total: 200, unknown: 0, drift: 3 }).status, "WARNING");
  assert.equal(buildAvailabilityHealth({ total: 200, unknown: 0, drift: 0 }).status, "HEALTHY");
  assert.equal(buildAvailabilityHealth({ total: 200, unknown: null, drift: 0 }).status, "UNKNOWN");
  assert.match(buildAvailabilityHealth({ total: 200, unknown: 0, drift: 0 }).note ?? "", /لا يُشتق من الكمية/);
});

// ── channels (§7) ────────────────────────────────────────────────────────────────
test("channels: rolls up to the worst storefront state", () => {
  const d = buildChannelsHealth([
    { key: "shopify:malikas", label: "Shopify", status: "HEALTHY", missingMappings: 0, needsReview: 0, conflicts: 0, operationalBlocked: false },
    { key: "rafeeq:malikas", label: "Rafeeq", status: "ACTION_REQUIRED", missingMappings: 6, needsReview: 5, conflicts: 5, operationalBlocked: false },
    { key: "snoonu:malikas", label: "Snoonu Malikas", status: "OPERATIONALLY_BLOCKED", missingMappings: null, needsReview: null, conflicts: null, operationalBlocked: true },
  ]);
  assert.equal(d.status, "ACTION_REQUIRED");
  assert.match(d.note ?? "", /Talabat|رفيق/);
});

// ── ai (§8) ──────────────────────────────────────────────────────────────────────
test("ai: no provider → OPERATIONALLY_BLOCKED; missing content → WARNING; else HEALTHY", () => {
  assert.equal(buildAiHealth({ missingKeywords: 0, missingDescriptions: 0, providerConfigured: false }).status, "OPERATIONALLY_BLOCKED");
  assert.equal(buildAiHealth({ missingKeywords: 5, missingDescriptions: 0, providerConfigured: true }).status, "WARNING");
  assert.equal(buildAiHealth({ missingKeywords: 0, missingDescriptions: 0, providerConfigured: true }).status, "HEALTHY");
});

// ── media (§9) ───────────────────────────────────────────────────────────────────
test("media: missing images → WARNING; else HEALTHY", () => {
  assert.equal(buildMediaHealth({ missingImages: 4 }).status, "WARNING");
  assert.equal(buildMediaHealth({ missingImages: 0 }).status, "HEALTHY");
});

// ── ecl (§10) ────────────────────────────────────────────────────────────────────
test("ecl: needs_review → ACTION_REQUIRED; unread → UNKNOWN; clean → HEALTHY", () => {
  assert.equal(buildEclHealth({ totalMappings: 100, active: 90, needsReview: 5 }).status, "ACTION_REQUIRED");
  assert.equal(buildEclHealth({ totalMappings: null, active: null, needsReview: null }).status, "UNKNOWN");
  assert.equal(buildEclHealth({ totalMappings: 100, active: 100, needsReview: 0 }).status, "HEALTHY");
});

// ── security (§11) ───────────────────────────────────────────────────────────────
test("security: writer configured → HEALTHY; strict enforcement is a certified note", () => {
  const d = buildSecurityHealth({ ownerConfigured: true, extraWriterCount: 2, strictEnforcementCertified: true });
  assert.equal(d.status, "HEALTHY");
  assert.match(d.note ?? "", /لا أسرار|معتمد/);
  // no email/secret ever appears in metrics/reasons
  assert.equal(JSON.stringify(d).includes("@"), false);
});

// ── system (§12) ─────────────────────────────────────────────────────────────────
test("system: recent failures / no provider → WARNING; else HEALTHY", () => {
  assert.equal(buildSystemHealth({ vercelEnv: "production", providerConfigured: true, recentFailures: 0, snoonuSessionState: "CONNECTED" }).status, "HEALTHY");
  assert.equal(buildSystemHealth({ vercelEnv: "production", providerConfigured: true, recentFailures: 3, snoonuSessionState: "CONNECTED" }).status, "WARNING");
  assert.equal(buildSystemHealth({ vercelEnv: null, providerConfigured: false, recentFailures: 0, snoonuSessionState: "UNKNOWN" }).status, "WARNING");
});

// ── findings + deep links (§13) ─────────────────────────────────────────────────
test("findings map to existing workflows with deep links; actions sorted first; no Fix-All", () => {
  const f = buildFindings(signals({
    catalog: { total: 200, active: 180, archived: 20, missingImages: 5, missingBarcode: 2, missingDescription: 0 },
    ai: { missingKeywords: 10, missingDescriptions: 0, providerConfigured: true },
    availability: { total: 200, unknown: 0, drift: 3 },
    ecl: { totalMappings: 100, active: 90, needsReview: 4 },
  }));
  assert.ok(f.length > 0);
  for (const x of f) {
    assert.match(x.href, /^\/v2\//, "deep-links to an existing v2 route");
    assert.ok(x.reason.length > 0 && x.workflow.length > 0);
  }
  // action findings come before warnings
  const firstWarningIdx = f.findIndex((x) => x.severity === "warning");
  const lastActionIdx = f.map((x) => x.severity).lastIndexOf("action");
  if (firstWarningIdx !== -1 && lastActionIdx !== -1) assert.ok(lastActionIdx < firstWarningIdx);
  // deep-link targets: media, barcode, ai, availability-sync, missing-products
  const hrefs = f.map((x) => x.href).join(" ");
  assert.match(hrefs, /operations\/media/);
  assert.match(hrefs, /operations\/ai/);
  assert.match(hrefs, /availability-sync/);
  assert.equal(/fix.?all/i.test(hrefs), false);
});

test("channel findings deep-link per storefront (blocked + needs_review + missing)", () => {
  const f = buildFindings(signals({
    channels: [
      { key: "snoonu:malikas", label: "Snoonu Malikas", status: "OPERATIONALLY_BLOCKED", missingMappings: null, needsReview: null, conflicts: null, operationalBlocked: true },
      { key: "rafeeq:malikas", label: "Rafeeq", status: "ACTION_REQUIRED", missingMappings: 0, needsReview: 5, conflicts: 5, operationalBlocked: false },
    ],
  }));
  assert.ok(f.some((x) => x.domain === "channels" && /snoonu%3Amalikas/.test(x.href)));
  assert.ok(f.some((x) => x.domain === "channels" && /rafeeq%3Amalikas/.test(x.href)));
});

// ── filters (§15) ────────────────────────────────────────────────────────────────
test("filters validate against known domains/severities; junk → null", () => {
  const f = parseHealthFilters({ domain: "catalog", severity: "action" });
  assert.equal(f.domain, "catalog");
  assert.equal(f.severity, "action");
  const bad = parseHealthFilters({ domain: "evil", severity: "boom" });
  assert.equal(bad.domain, null);
  assert.equal(bad.severity, null);
});

test("filterFindings narrows by domain + severity", () => {
  const all = buildFindings(signals({
    catalog: { total: 200, active: 180, archived: 20, missingImages: 5, missingBarcode: 0, missingDescription: 0 },
    ecl: { totalMappings: 100, active: 90, needsReview: 4 },
  }));
  assert.ok(filterFindings(all, parseHealthFilters({ domain: "ecl" })).every((x) => x.domain === "ecl"));
  assert.ok(filterFindings(all, parseHealthFilters({ severity: "action" })).every((x) => x.severity === "action"));
});

// ── whole model + domain order ──────────────────────────────────────────────────
test("buildHealthCenter returns all nine domains in canonical order", () => {
  const m = buildHealthCenter(signals());
  assert.deepEqual(m.domains.map((d) => d.key), [...DOMAIN_ORDER]);
  assert.equal(m.counts.domains, 9);
});

test("read-only model: operationally-blocked + unknown propagate honestly", () => {
  const m = buildHealthCenter(signals({
    channels: [{ key: "snoonu:malikas", label: "Snoonu Malikas", status: "OPERATIONALLY_BLOCKED", missingMappings: null, needsReview: null, conflicts: null, operationalBlocked: true }],
    inventory: { negativeInventory: null, negativeVariant: null },
    ai: { missingKeywords: 0, missingDescriptions: 0, providerConfigured: false },
  }));
  const byKey = Object.fromEntries(m.domains.map((d) => [d.key, d.status]));
  assert.equal(byKey.channels, "OPERATIONALLY_BLOCKED");
  assert.equal(byKey.inventory, "UNKNOWN");
  assert.equal(byKey.ai, "OPERATIONALLY_BLOCKED");
  // overall = worst present (ACTION_REQUIRED absent here → OPERATIONALLY_BLOCKED)
  assert.equal(m.overall.status, "OPERATIONALLY_BLOCKED");
});
