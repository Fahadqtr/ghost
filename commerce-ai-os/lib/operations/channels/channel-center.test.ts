// OPS.3 — Channel Command Center composer unit tests (§19). Pure — node:test loads
// the composer directly.
// node --conditions=react-server --experimental-strip-types --test lib/operations/channels/channel-center.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChannelCenter,
  buildStorefrontCards,
  buildChannelAlerts,
  buildChannelQueues,
  buildActivity,
  buildFilterOptions,
  buildQuickActions,
  computeStorefrontStatus,
  searchLocal,
  filterStorefrontCards,
  filterAlerts,
  selectQueue,
  filterItems,
  parseChannelFilters,
  worstStatus,
  REASON_MISSING_BARCODE,
  REASON_MISSING_IMAGE,
  ROUTES,
  type ChannelCenterInput,
  type CcItem,
  type StorefrontMetrics,
} from "./channel-center.ts";

// ── fixtures ────────────────────────────────────────────────────────────────
function item(over: Partial<CcItem>): CcItem {
  return {
    id: "p",
    sku: null,
    barcode: null,
    nameAr: null,
    nameEn: null,
    brandId: null,
    category: null,
    readinessPercent: 100,
    needsImage: false,
    needsReview: false,
    reasons: [],
    shopifyStatus: null,
    ...over,
  };
}

function baseInput(over: Partial<ChannelCenterInput> = {}): ChannelCenterInput {
  return {
    kpis: { totalProducts: 100, needsImage: 4, needsReview: 3, ready: 80, readinessAverage: 82 },
    overview: {
      shopify: { available: true, published: 70, missing: 10, different: 2, reviewRequired: 1, stale: false, lastCapturedAt: "2026-08-15T10:00:00Z" },
      puresoul: { available: true, published: 40, missing: 5, priceDifferent: 3, reviewRequired: 0, outOfStock: 2, stale: true, lastCapturedAt: "2026-08-10T10:00:00Z" },
      talabat: { available: true, present: 30, missing: 8, review: 4, linked: 10, stale: false, lastCapturedAt: "2026-08-14T10:00:00Z" },
      rafeeq: { available: true, present: 20, missing: 6, linked: 5, stale: false, lastCapturedAt: null },
    },
    platformHealth: [],
    items: [
      item({ id: "a", sku: "SKU-A", barcode: "111", nameEn: "Alpha", brandId: "b1", category: "Makeup", needsImage: true, reasons: [REASON_MISSING_IMAGE], shopifyStatus: "missing", puresoulState: "price_different", talabatState: "missing", rafeeqState: "linked" }),
      item({ id: "b", sku: "SKU-B", barcode: "222", nameAr: "بيتا", brandId: "b2", category: "Hair", needsReview: true, reasons: [REASON_MISSING_BARCODE], shopifyStatus: "different", talabatState: "review", rafeeqState: "missing" }),
    ],
    degraded: { puresoul: false, talabat: false, rafeeq: false },
    snoonuMalikasReaderAvailable: false,
    ...over,
  };
}

const cardByKey = (input: ChannelCenterInput, key: string) => buildStorefrontCards(input).find((c) => c.key === key)!;

// ── storefront isolation (§2) ─────────────────────────────────────────────────
test("the five storefronts are first-class and never collapsed", () => {
  const cards = buildStorefrontCards(baseInput());
  assert.deepEqual(
    cards.map((c) => c.key),
    ["shopify:malikas", "snoonu:malikas", "snoonu:pure_seoul", "talabat:malikas", "rafeeq:malikas"],
  );
});

test("Snoonu Malikas and Pure Seoul are strictly isolated (no shared SPI/session/state)", () => {
  // Give Pure Seoul concrete numbers; Malikas must NOT inherit any of them.
  const malikas = cardByKey(baseInput(), "snoonu:malikas");
  const pure = cardByKey(baseInput(), "snoonu:pure_seoul");
  assert.equal(malikas.status, "OPERATIONALLY_BLOCKED");
  assert.equal(malikas.mapped, null);
  assert.equal(malikas.missingMappings, null);
  assert.notEqual(pure.mapped, null);
  assert.equal(pure.mapped, 40);
  // isolation: the blocked store carries none of Pure Seoul's counts
  assert.notEqual(malikas.mapped, pure.mapped);
});

// ── Snoonu Malikas card (§4) ──────────────────────────────────────────────────
test("Snoonu Malikas is OPERATIONALLY_BLOCKED with a merchant-session reason (no reader wired)", () => {
  const card = cardByKey(baseInput(), "snoonu:malikas");
  assert.equal(card.operationalBlocked, true);
  assert.deepEqual(card.reasons, ["no_operational_source"]);
  // it still links to the real workflows (recover images / availability / barcode)
  const hrefs = card.actions.map((a) => a.href);
  assert.ok(hrefs.includes(ROUTES.media));
  assert.ok(hrefs.includes(ROUTES.availabilitySync));
  assert.ok(hrefs.includes(ROUTES.barcodeCompletion));
});

test("Snoonu Malikas becomes assessable once a reader is wired", () => {
  const card = cardByKey(baseInput({ snoonuMalikasReaderAvailable: true }), "snoonu:malikas");
  // with a reader but no data it is UNKNOWN (not blocked, not 'missing')
  assert.equal(card.status, "UNKNOWN");
});

// ── Snoonu Pure Seoul card (§5) ───────────────────────────────────────────────
test("Snoonu Pure Seoul reports its own numbers and is degradable independently", () => {
  const card = cardByKey(baseInput(), "snoonu:pure_seoul");
  assert.equal(card.mapped, 40);
  assert.equal(card.missingMappings, 5);
  assert.equal(card.availabilityDrift, 3);
  assert.equal(card.stale, true);
  // degrade ONLY pure seoul → blocked, and Malikas/Talabat unaffected
  const degraded = baseInput({ degraded: { puresoul: true, talabat: false, rafeeq: false } });
  assert.equal(cardByKey(degraded, "snoonu:pure_seoul").status, "OPERATIONALLY_BLOCKED");
  assert.equal(cardByKey(degraded, "talabat:malikas").status !== "OPERATIONALLY_BLOCKED", true);
});

// ── Shopify health (§6) ───────────────────────────────────────────────────────
test("Shopify health reflects mapping/drift/review and connection loss", () => {
  const card = cardByKey(baseInput(), "shopify:malikas");
  assert.equal(card.mapped, 70);
  assert.equal(card.missingMappings, 10);
  assert.equal(card.availabilityDrift, 2);
  assert.equal(card.status, "ACTION_REQUIRED"); // missing > 0
  // connection loss → blocked (cannot assess), never 'missing'
  const down = baseInput();
  down.overview.shopify.available = false;
  assert.equal(cardByKey(down, "shopify:malikas").status, "UNKNOWN");
});

// ── Talabat variant flattening (§7) ───────────────────────────────────────────
test("Talabat is variant-grain and never claims parent coverage is sufficient", () => {
  const card = cardByKey(baseInput(), "talabat:malikas");
  assert.equal(card.listingGrain, "variant");
  assert.ok(card.grainNote && card.grainNote.length > 0, "carries a variant-grain caveat");
  assert.equal(card.missingMappings, 8); // missing variant listings surfaced
  // the alert for Talabat gaps is explicitly a VARIANT_MAPPING_GAP
  const alerts = buildChannelAlerts(baseInput());
  const t = alerts.find((a) => a.storefront === "talabat:malikas" && a.type === "VARIANT_MAPPING_GAP");
  assert.ok(t, "Talabat missing gap is a variant mapping gap");
});

// ── Rafeeq needs_review / conflicts (§8) ──────────────────────────────────────
test("Rafeeq conflicts stay needs_review — surfaced only with evidence, never auto-resolved", () => {
  // no conflict count → no conflict alert (honest: never fabricated)
  assert.equal(buildChannelAlerts(baseInput()).some((a) => a.type === "RAFEEQ_CONFLICT"), false);
  // with evidence → a manual-review link (never a resolver)
  const withConflicts = baseInput({ rafeeqConflicts: 4 });
  const alert = buildChannelAlerts(withConflicts).find((a) => a.type === "RAFEEQ_CONFLICT");
  assert.ok(alert);
  assert.equal(alert!.storefront, "rafeeq:malikas");
  assert.equal(alert!.count, 4);
  assert.match(alert!.href, /status=NEEDS_REVIEW/);
  // and the card status escalates to ACTION_REQUIRED with a conflicts reason
  const card = cardByKey(withConflicts, "rafeeq:malikas");
  assert.equal(card.status, "ACTION_REQUIRED");
  assert.ok(card.reasons.includes("conflicts"));
});

// ── alerts (§9) ───────────────────────────────────────────────────────────────
test("every alert identifies storefront, explains a reason, and links to a workflow", () => {
  const alerts = buildChannelAlerts(baseInput({ rafeeqConflicts: 1 }));
  assert.ok(alerts.length > 0);
  for (const a of alerts) {
    assert.equal(typeof a.reason, "string");
    assert.ok(a.reason.length > 0, "has a reason");
    assert.match(a.href, /^\/v2\//, "links to an existing workflow route");
    assert.ok(a.type, "has a type");
  }
  // no generic Fix-All affordance in the model
  assert.equal(alerts.some((a) => /fix.?all/i.test(a.type) || /fix.?all/i.test(a.reason)), false);
});

test("merchant-session-missing alert fires for Snoonu Malikas", () => {
  const alerts = buildChannelAlerts(baseInput());
  const s = alerts.find((a) => a.type === "MERCHANT_SESSION_MISSING");
  assert.ok(s);
  assert.equal(s!.storefront, "snoonu:malikas");
});

test("image/barcode catalog alerts are emitted from evidence", () => {
  const alerts = buildChannelAlerts(baseInput());
  assert.ok(alerts.find((a) => a.type === "IMAGE_MISSING"));
  assert.ok(alerts.find((a) => a.type === "BARCODE_MISSING"));
});

// ── queues (§10) ──────────────────────────────────────────────────────────────
test("all nine channel queues exist with the right hand-off semantics", () => {
  const queues = buildChannelQueues(baseInput());
  const keys = queues.map((q) => q.key);
  assert.deepEqual(keys, [
    "needs_mapping",
    "needs_review",
    "availability_drift",
    "missing_barcode",
    "missing_image",
    "external_only",
    "internal_only",
    "sync_errors",
    "operational_blockers",
  ]);
  // external_only + sync_errors are workflow ENTRY-POINTS (count computed there)
  const ext = queues.find((q) => q.key === "external_only")!;
  const sync = queues.find((q) => q.key === "sync_errors")!;
  assert.equal(ext.entryPoint, true);
  assert.equal(ext.count, null);
  assert.equal(sync.entryPoint, true);
  // evidenced queues carry counts + rows
  const img = queues.find((q) => q.key === "missing_image")!;
  assert.equal(img.count, 1);
  assert.equal(img.rows.length, 1);
  // operational_blockers includes snoonu:malikas (no reader)
  const blk = queues.find((q) => q.key === "operational_blockers")!;
  assert.ok(blk.rows.some((r) => r.storefront === "snoonu:malikas"));
});

test("queues never ship the whole catalog (bounded top-N)", () => {
  const many = Array.from({ length: 50 }, (_, i) => item({ id: `x${i}`, needsImage: true }));
  const queues = buildChannelQueues(baseInput({ items: many }), 8);
  const img = queues.find((q) => q.key === "missing_image")!;
  assert.equal(img.count, 50);
  assert.equal(img.rows.length, 8);
});

// ── health calculation (§11) ──────────────────────────────────────────────────
test("storefront status is deterministic with the documented precedence", () => {
  const m = (o: Partial<StorefrontMetrics>): StorefrontMetrics => ({ hasReader: true, degraded: false, available: true, missingMappings: 0, needsReview: 0, conflicts: 0, availabilityDrift: 0, syncErrors: 0, stale: false, ...o });
  assert.equal(computeStorefrontStatus(m({ hasReader: false })).status, "OPERATIONALLY_BLOCKED");
  assert.equal(computeStorefrontStatus(m({ degraded: true })).status, "OPERATIONALLY_BLOCKED");
  assert.equal(computeStorefrontStatus(m({ available: false })).status, "UNKNOWN");
  assert.equal(computeStorefrontStatus(m({ missingMappings: 1 })).status, "ACTION_REQUIRED");
  assert.equal(computeStorefrontStatus(m({ conflicts: 1 })).status, "ACTION_REQUIRED");
  assert.equal(computeStorefrontStatus(m({ needsReview: 1 })).status, "WARNING");
  assert.equal(computeStorefrontStatus(m({ availabilityDrift: 1 })).status, "WARNING");
  assert.equal(computeStorefrontStatus(m({ stale: true })).status, "WARNING");
  assert.equal(computeStorefrontStatus(m({})).status, "HEALTHY");
  // action outranks warning
  assert.equal(computeStorefrontStatus(m({ missingMappings: 1, stale: true })).status, "ACTION_REQUIRED");
});

test("status exposes its reasons and unknown never becomes missing", () => {
  const r = computeStorefrontStatus({ hasReader: true, degraded: false, available: false, missingMappings: 0, needsReview: 0, conflicts: 0, availabilityDrift: 0, syncErrors: 0, stale: false });
  assert.deepEqual(r.reasons, ["no_snapshot"]);
  assert.equal(r.status, "UNKNOWN");
});

test("worstStatus rolls up to the most severe", () => {
  const cards = buildStorefrontCards(baseInput());
  assert.equal(worstStatus(cards), "ACTION_REQUIRED");
});

// ── search by external identity (§13) ─────────────────────────────────────────
test("local search matches SKU/barcode exactly and name by substring — never fuzzy", () => {
  const items = baseInput().items;
  assert.deepEqual(searchLocal(items, "SKU-A").map((m) => m.matchedOn), ["sku"]);
  assert.deepEqual(searchLocal(items, "111").map((m) => m.matchedOn), ["barcode"]);
  assert.deepEqual(searchLocal(items, "alph").map((m) => m.matchedOn), ["name"]);
  assert.equal(searchLocal(items, "").length, 0);
  // a near-miss SKU does NOT fuzzily match
  assert.equal(searchLocal(items, "SKU-").some((m) => m.matchedOn === "sku"), false);
});

// ── filters (§14) ─────────────────────────────────────────────────────────────
test("filters parse and apply over cards / alerts / queues / items", () => {
  const f = parseChannelFilters({ channel: "snoonu", status: "OPERATIONALLY_BLOCKED", issue: "missing_image", brand: "b1" });
  assert.equal(f.channel, "snoonu");
  assert.equal(f.status, "OPERATIONALLY_BLOCKED");
  assert.equal(f.issueType, "missing_image");
  const cards = buildStorefrontCards(baseInput());
  const onlySnoonu = filterStorefrontCards(cards, f);
  assert.ok(onlySnoonu.every((c) => c.channel === "snoonu" && c.status === "OPERATIONALLY_BLOCKED"));
  const queues = selectQueue(buildChannelQueues(baseInput()), f.issueType);
  assert.deepEqual(queues.map((q) => q.key), ["missing_image"]);
  const items = filterItems(baseInput().items, f);
  assert.ok(items.every((i) => i.brandId === "b1"));
  // bad status/issue values fall back to null (never throw)
  const bad = parseChannelFilters({ status: "NONSENSE", issue: "nope" });
  assert.equal(bad.status, null);
  assert.equal(bad.issueType, null);
});

test("alert filtering respects storefront and channel scoping", () => {
  const alerts = buildChannelAlerts(baseInput({ rafeeqConflicts: 2 }));
  const onlyRafeeq = filterAlerts(alerts, parseChannelFilters({ storefront: "rafeeq:malikas" }));
  assert.ok(onlyRafeeq.every((a) => a.storefront === "rafeeq:malikas"));
});

// ── quick-action links (§15) ──────────────────────────────────────────────────
test("every quick action + storefront action links to an EXISTING workflow route", () => {
  const allowedPrefixes = [
    ROUTES.catalog,
    ROUTES.shopifyCatalog,
    ROUTES.operations,
    ROUTES.channels,
    ROUTES.missingProducts,
    ROUTES.media,
    ROUTES.aiEnrichment,
    ROUTES.barcodeCompletion,
    ROUTES.availabilitySync,
  ];
  const ok = (href: string) => allowedPrefixes.some((p) => href === p || href.startsWith(`${p}?`));
  for (const a of buildQuickActions()) assert.ok(ok(a.href), `quick action ${a.href}`);
  for (const card of buildStorefrontCards(baseInput())) {
    for (const a of card.actions) assert.ok(ok(a.href), `${card.key} action ${a.href}`);
  }
});

// ── activity (§12) ────────────────────────────────────────────────────────────
test("recent activity is snapshot-only and sorted newest-first with nulls last", () => {
  const act = buildActivity(baseInput());
  assert.ok(act.every((e) => e.kind === "snapshot"));
  assert.equal(act[0].at, "2026-08-15T10:00:00Z"); // Shopify newest
  assert.equal(act[act.length - 1].at, null); // Rafeeq (no snapshot) last
});

// ── filter options (§14) ──────────────────────────────────────────────────────
test("filter options expose channels, storefronts, statuses, brands, categories", () => {
  const opts = buildFilterOptions(baseInput());
  assert.deepEqual(opts.brands, ["b1", "b2"]);
  assert.deepEqual(opts.categories, ["Hair", "Makeup"]);
  assert.equal(opts.storefronts.length, 5);
  assert.ok(opts.channels.includes("snoonu"));
});

// ── whole model (read-only shape) ─────────────────────────────────────────────
test("buildChannelCenter composes a complete read-only model", () => {
  const model = buildChannelCenter(baseInput({ rafeeqConflicts: 1 }));
  assert.equal(model.storefronts.length, 5);
  assert.equal(model.counts.storefronts, 5);
  assert.equal(model.counts.blocked, 1); // snoonu:malikas
  assert.equal(model.overallStatus, "ACTION_REQUIRED");
  assert.ok(model.alerts.length > 0);
  assert.equal(model.queues.length, 9);
  assert.equal(model.activity.length, 4);
  assert.equal(model.quickActions.length, 7);
});
