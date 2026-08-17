// INT.2A — export foundation model tests (PURE).
// node --conditions=react-server --experimental-strip-types --test lib/export/export-model.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { STOREFRONT_KEYS } from "../channels/storefronts.ts";
import {
  EXPORT_DESTINATIONS,
  EXPORT_DESTINATION_KEYS,
  exportDestinationByKey,
  destinationHasCapability,
  isSellableListingGrain,
} from "./destinations.ts";
import {
  summarizeValidation,
  EMPTY_VALIDATION_SUMMARY,
  EXPORT_REASON_CODES,
  type ExportValidationItem,
} from "./validation.ts";
import { EXPORT_GRAINS, emptyPreview } from "./preview.ts";
import { unavailableHistory } from "./history.ts";
import { buildExportCenter, UNKNOWN, exportDetailHref } from "./export-center.ts";

// ── registry: five destinations, exactly the certified storefront keys ────────
test("registry has exactly the five canonical destinations = storefront keys (no second registry)", () => {
  assert.deepEqual([...EXPORT_DESTINATION_KEYS], [...STOREFRONT_KEYS]);
  assert.deepEqual([...EXPORT_DESTINATION_KEYS].sort(), [
    "rafeeq:malikas",
    "shopify:malikas",
    "snoonu:malikas",
    "snoonu:pure_seoul",
    "talabat:malikas",
  ]);
  assert.equal(EXPORT_DESTINATIONS.length, 5);
  assert.equal(exportDestinationByKey("nope:nope"), null);
});

test("Snoonu two storefronts are isolated (distinct destinations, same channel)", () => {
  const mal = exportDestinationByKey("snoonu:malikas");
  const ps = exportDestinationByKey("snoonu:pure_seoul");
  assert.ok(mal && ps);
  assert.equal(mal!.channel, "snoonu");
  assert.equal(ps!.channel, "snoonu");
  assert.notEqual(mal!.key, ps!.key);
  assert.notEqual(mal!.businessUnit, ps!.businessUnit);
});

test("capability metadata matches the spec per destination", () => {
  assert.deepEqual(exportDestinationByKey("shopify:malikas")!.capabilities, [
    "validate", "preview", "publish", "update", "images", "pricing",
  ]);
  assert.deepEqual(exportDestinationByKey("talabat:malikas")!.capabilities, [
    "validate", "preview", "xlsx", "image_package", "flattened_variants",
  ]);
  for (const k of ["snoonu:malikas", "snoonu:pure_seoul", "rafeeq:malikas"]) {
    assert.deepEqual(exportDestinationByKey(k)!.capabilities, ["validate", "preview", "xlsx", "image_package"]);
  }
  assert.equal(destinationHasCapability("shopify:malikas", "publish"), true);
  assert.equal(destinationHasCapability("talabat:malikas", "publish"), false);
});

// ── Talabat SELLABLE_LISTING invariant (§10) ──────────────────────────────────
test("Talabat lists at the sellable (variant) grain; product-grain destinations do not", () => {
  assert.equal(isSellableListingGrain("talabat:malikas"), true);
  assert.equal(exportDestinationByKey("talabat:malikas")!.listingGrain, "variant");
  assert.equal(destinationHasCapability("talabat:malikas", "flattened_variants"), true);
  for (const k of ["shopify:malikas", "snoonu:malikas", "snoonu:pure_seoul", "rafeeq:malikas"]) {
    assert.equal(isSellableListingGrain(k), false, `${k} is product-grain`);
    assert.equal(destinationHasCapability(k, "flattened_variants"), false);
  }
});

// ── validation model + summary ────────────────────────────────────────────────
test("validation summary counts by status and groups reason codes", () => {
  const items: ExportValidationItem[] = [
    { entityId: "a", destination: "talabat:malikas", status: "READY", reasons: [] },
    { entityId: "b", destination: "talabat:malikas", status: "WARNING", reasons: [{ code: "MISSING_IMAGE", blocking: false }] },
    { entityId: "c", destination: "talabat:malikas", status: "BLOCKED", reasons: [{ code: "MISSING_SKU", blocking: true }, { code: "MISSING_IMAGE", blocking: true }] },
    { entityId: "d", destination: "talabat:malikas", status: "UNKNOWN", reasons: [] },
  ];
  const s = summarizeValidation(items);
  assert.deepEqual({ total: s.total, ready: s.ready, warnings: s.warnings, blocked: s.blocked, unknown: s.unknown }, {
    total: 4, ready: 1, warnings: 1, blocked: 1, unknown: 1,
  });
  assert.equal(s.byReason.MISSING_IMAGE, 2);
  assert.equal(s.byReason.MISSING_SKU, 1);
  assert.deepEqual(summarizeValidation(null), EMPTY_VALIDATION_SUMMARY);
  assert.deepEqual(summarizeValidation([]), EMPTY_VALIDATION_SUMMARY);
});

test("reason codes include the full required set", () => {
  for (const c of ["MISSING_SKU", "DUPLICATE_SKU", "MISSING_BARCODE", "DUPLICATE_BARCODE", "MISSING_IMAGE",
    "MISSING_TITLE", "MISSING_PRICE", "MISSING_CATEGORY", "LIFECYCLE_NOT_ELIGIBLE", "IDENTITY_MISSING",
    "IDENTITY_CONFLICT", "VARIANT_NOT_READY", "UNSUPPORTED"]) {
    assert.ok((EXPORT_REASON_CODES as readonly string[]).includes(c), `reason ${c}`);
  }
});

// ── preview grain ─────────────────────────────────────────────────────────────
test("preview supports PRODUCT / VARIANT / SELLABLE_LISTING grain; empty preview is a placeholder", () => {
  assert.deepEqual([...EXPORT_GRAINS], ["PRODUCT", "VARIANT", "SELLABLE_LISTING"]);
  const p = emptyPreview("talabat:malikas", "SELLABLE_LISTING");
  assert.equal(p.grain, "SELLABLE_LISTING");
  assert.equal(p.placeholder, true);
  assert.deepEqual(p.items, []);
});

// ── history unavailable ───────────────────────────────────────────────────────
test("export history is honestly UNAVAILABLE (no durable source in INT.2A)", () => {
  const h = unavailableHistory("rafeeq:malikas");
  assert.equal(h.availability, "UNAVAILABLE");
  assert.deepEqual(h.runs, []);
});

// ── dashboard composer ────────────────────────────────────────────────────────
test("buildExportCenter emits one card per destination; per-card counts UNKNOWN, baseline passthrough", () => {
  const model = buildExportCenter({
    eligible: 42,
    blocked: 7,
    warningsByDestination: { "talabat:malikas": 3 },
    generatedAt: "2026-08-17T00:00:00.000Z",
  });
  assert.equal(model.destinations.length, 5);
  assert.equal(model.readinessBaseline.eligible, 42);
  assert.equal(model.readinessBaseline.blocked, 7);
  assert.equal(model.historyAvailable, false);
  const talabat = model.destinations.find((d) => d.key === "talabat:malikas")!;
  assert.equal(talabat.warnings, 3); // from the facts map
  assert.equal(talabat.productsEligible, UNKNOWN); // destination-specific rules deferred
  assert.equal(talabat.productsBlocked, UNKNOWN);
  assert.equal(talabat.lastExport, UNKNOWN);
  assert.equal(talabat.detailHref, "/v2/export/talabat%3Amalikas");
  const shopify = model.destinations.find((d) => d.key === "shopify:malikas")!;
  assert.equal(shopify.warnings, UNKNOWN); // no entry in the facts map ⇒ UNKNOWN
  assert.equal(shopify.operationalState, "FOUNDATION_READY");
});

test("exportDetailHref encodes the destination key", () => {
  assert.equal(exportDetailHref("snoonu:pure_seoul"), "/v2/export/snoonu%3Apure_seoul");
});
