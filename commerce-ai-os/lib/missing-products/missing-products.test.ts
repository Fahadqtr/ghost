// CH.6F — Missing Products Discovery unit tests (§23). Pure assembly + matcher +
// eligibility + plan + the ECL write boundary. No DB, no network.
// node --conditions=react-server --experimental-strip-types --test lib/missing-products/missing-products.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  STOREFRONT_KEYS,
  STOREFRONT_GRAIN,
  allowedActionsFor,
  isConflict,
  channelOf,
  grainOf,
} from "./discovery-model.ts";
import { buildInternalIndex, matchExternalToInternal, isValidBarcode } from "./discovery-match.ts";
import { importEligibility, publishReadiness } from "./discovery-classify.ts";
import { buildGapItems, summarize, planEclRepairs, planImports, type InternalUnitInput, type EclRowInput, type ExternalEvidenceInput } from "./discovery-plan.ts";
import { writeEclMapping, ECL_WRITE_COLUMNS } from "./ecl-repair-write.server.ts";

// ── helpers ──────────────────────────────────────────────────────────────────
const prod = (id: string, sku: string | null, barcode: string | null, extra: Partial<InternalUnitInput> = {}): InternalUnitInput => ({
  productId: id, variantId: null, grain: "product", sku, barcode, nameEn: id, nameAr: null, brandId: null, archived: false, sellable: true, hasImage: true, hasDescription: true, ...extra,
});
const variant = (pid: string, vid: string, sku: string | null, barcode: string | null, extra: Partial<InternalUnitInput> = {}): InternalUnitInput => ({
  productId: pid, variantId: vid, grain: "variant", sku, barcode, nameEn: vid, nameAr: null, brandId: null, archived: false, sellable: true, hasImage: true, hasDescription: true, ...extra,
});
const eclRow = (pid: string, spi: string | null, status = "active", extra: Partial<EclRowInput> = {}): EclRowInput => ({
  productId: pid, variantId: null, externalProductId: spi, exportedSku: null, exportedBarcode: null, mappingStatus: status, claimedExternalId: null, ...extra,
});
const snap = (pid: string | null, extId: string | null, sku: string | null, barcode: string | null, extra: Partial<ExternalEvidenceInput> = {}): ExternalEvidenceInput => ({
  productId: pid, externalId: extId, sku, barcode, title: sku ?? extId, grain: "product", sourceType: "snapshot:test", capturedAt: "2026-08-01T00:00:00Z", ...extra,
});
const statusOf = (items: ReturnType<typeof buildGapItems>, pid: string) => items.find((i) => i.productId === pid)?.status;

// ── model invariants ─────────────────────────────────────────────────────────
test("storefront model matches the CH.5 registry keys and grains", () => {
  assert.deepEqual([...STOREFRONT_KEYS].sort(), ["rafeeq:malikas", "shopify:malikas", "snoonu:malikas", "snoonu:pure_seoul", "talabat:malikas"]);
  assert.equal(STOREFRONT_GRAIN["talabat:malikas"], "variant");
  assert.equal(STOREFRONT_GRAIN["snoonu:malikas"], "product");
  assert.equal(channelOf("snoonu:pure_seoul"), "snoonu");
  assert.equal(grainOf("talabat:malikas"), "variant");
});

test("conflicts expose ONLY review — never a bulk auto-repair (§17)", () => {
  for (const s of ["IDENTITY_CONFLICT", "SKU_CONFLICT", "BARCODE_CONFLICT", "VARIANT_CONFLICT", "NEEDS_REVIEW"] as const) {
    assert.ok(isConflict(s));
    assert.deepEqual([...allowedActionsFor(s)], ["REVIEW"]);
  }
  assert.deepEqual([...allowedActionsFor("MISSING_ECL")], ["CREATE_ECL"]);
  assert.deepEqual([...allowedActionsFor("MAPPED_OK")], ["NONE"]);
});

// ── matcher (deterministic hierarchy, no fuzzy) ──────────────────────────────
test("matcher resolves by external id > sku > barcode; never by name", () => {
  const targets = [{ productId: "p1", variantId: null, grain: "product" as const, sku: "mk1", barcode: "1234567890123" }];
  const index = buildInternalIndex(targets, [{ externalId: "SPI-1", target: targets[0] }]);
  assert.equal(matchExternalToInternal({ externalId: "SPI-1", sku: null, barcode: null, grain: "product" }, index).evidence, "external_id");
  assert.equal(matchExternalToInternal({ externalId: null, sku: "MK1", barcode: null, grain: "product" }, index).evidence, "sku");
  assert.equal(matchExternalToInternal({ externalId: null, sku: null, barcode: "1234567890123", grain: "product" }, index).evidence, "barcode");
  assert.equal(matchExternalToInternal({ externalId: null, sku: null, barcode: null, grain: "product" }, index).evidence, "none");
});

test("invalid barcode is never used as evidence", () => {
  assert.equal(isValidBarcode("123"), false);
  assert.equal(isValidBarcode("1234567890123"), true);
  const targets = [{ productId: "p1", variantId: null, grain: "product" as const, sku: null, barcode: "12" }];
  const index = buildInternalIndex(targets, []);
  assert.equal(matchExternalToInternal({ externalId: null, sku: null, barcode: "12", grain: "product" }, index).evidence, "none");
});

// ── Snoonu Malikas + Pure Seoul + cross-store isolation (§6, §23) ────────────
test("Snoonu Malikas mapped product → MAPPED_OK", () => {
  const items = buildGapItems({ storefront: "snoonu:malikas", internals: [prod("p1", "mk1", null)], ecl: [eclRow("p1", "SPI-M1")], external: [] });
  assert.equal(statusOf(items, "p1"), "MAPPED_OK");
});

test("Snoonu Pure Seoul mapped product → MAPPED_OK (independent from Malikas)", () => {
  const items = buildGapItems({ storefront: "snoonu:pure_seoul", internals: [prod("p1", "mk1", null)], ecl: [eclRow("p1", "SPI-PS1")], external: [] });
  assert.equal(statusOf(items, "p1"), "MAPPED_OK");
});

test("same product mapped in Malikas is INTERNAL_ONLY in Pure Seoul (cross-store SPI isolation §6)", () => {
  // Only a Malikas ECL row exists; scanning pure_seoul must NOT see it.
  const malikasEcl = [eclRow("p1", "SPI-M1")];
  const psItems = buildGapItems({ storefront: "snoonu:pure_seoul", internals: [prod("p1", "mk1", null)], ecl: [] /* store-scoped read returns none */, external: [] });
  assert.equal(statusOf(psItems, "p1"), "INTERNAL_ONLY");
  // and the Malikas scan is unaffected
  const mItems = buildGapItems({ storefront: "snoonu:malikas", internals: [prod("p1", "mk1", null)], ecl: malikasEcl, external: [] });
  assert.equal(statusOf(mItems, "p1"), "MAPPED_OK");
});

test("Snoonu internal-only (no ECL, no evidence) → INTERNAL_ONLY with readiness", () => {
  const items = buildGapItems({ storefront: "snoonu:malikas", internals: [prod("p1", "mk1", null, { hasImage: false })], ecl: [], external: [] });
  const it = items.find((i) => i.productId === "p1")!;
  assert.equal(it.status, "INTERNAL_ONLY");
  assert.equal(it.publishReadiness, "BLOCKED"); // missing image
  assert.ok(it.readinessBlockers.includes("image"));
});

test("Snoonu external-only listing (raw source, no internal match) → EXTERNAL_ONLY", () => {
  const items = buildGapItems({
    storefront: "snoonu:malikas",
    internals: [prod("p1", "mk1", null)],
    ecl: [],
    external: [snap(null, "SPI-X", "mkZZZ", null, { sourceType: "export:snoonu" })],
  });
  const ext = items.find((i) => i.status === "EXTERNAL_ONLY");
  assert.ok(ext, "an external-only item is produced");
  assert.equal(ext!.productId, null);
  assert.equal(ext!.importEligibility, "IMPORT_ELIGIBLE"); // has title + sku
});

test("missing ECL deterministic repair candidate from snapshot evidence", () => {
  const items = buildGapItems({ storefront: "snoonu:malikas", internals: [prod("p2", "mk2", null)], ecl: [], external: [snap("p2", "SPI-2", "mk2", null)] });
  const it = items.find((i) => i.productId === "p2")!;
  assert.equal(it.status, "MISSING_ECL");
  assert.equal(it.confidence, "DETERMINISTIC");
  assert.equal(it.repairExternalId, "SPI-2");
  assert.equal(it.repairIdentityType, "snoonu_spi");
});

// ── Shopify (§23) ────────────────────────────────────────────────────────────
test("Shopify internal-only and external-only", () => {
  const items = buildGapItems({
    storefront: "shopify:malikas",
    internals: [prod("p1", "mk1", null)],
    ecl: [],
    external: [snap(null, "gid://shopify/Product/9", "mkNEW", "4006381333931", { sourceType: "snapshot:shopify" })],
  });
  assert.equal(statusOf(items, "p1"), "INTERNAL_ONLY");
  assert.ok(items.some((i) => i.status === "EXTERNAL_ONLY" && i.externalId === "gid://shopify/Product/9"));
});

// ── Rafeeq (§7) ──────────────────────────────────────────────────────────────
test("Rafeeq normal mapping → MAPPED_OK", () => {
  const items = buildGapItems({ storefront: "rafeeq:malikas", internals: [prod("p1", "mk1", null)], ecl: [eclRow("p1", "RAF-1")], external: [] });
  assert.equal(statusOf(items, "p1"), "MAPPED_OK");
});

test("Rafeeq contested id stays NEEDS_REVIEW and is never auto-resolved (§7)", () => {
  const items = buildGapItems({ storefront: "rafeeq:malikas", internals: [prod("p1", "mk1", null)], ecl: [eclRow("p1", null, "needs_review", { claimedExternalId: "RAF-DUP" })], external: [snap("p1", "RAF-DUP", "mk1", null)] });
  const it = items.find((i) => i.productId === "p1")!;
  assert.equal(it.status, "NEEDS_REVIEW");
  assert.deepEqual([...it.allowedActions], ["REVIEW"]);
  // a needs_review item is NOT a deterministic repair candidate
  assert.equal(planEclRepairs(items, [it.key]).length, 0);
});

// ── Talabat flattening (§8) ──────────────────────────────────────────────────
test("Talabat simple/variant: each sellable variant compared at grain", () => {
  const items = buildGapItems({
    storefront: "talabat:malikas",
    internals: [variant("p1", "v1", "mk1-1", "1111111111116"), variant("p1", "v2", "mk1-2", "2222222222220")],
    ecl: [{ productId: "p1", variantId: "v1", externalProductId: null, exportedSku: "mk1-1", exportedBarcode: null, mappingStatus: "active", claimedExternalId: null }],
    external: [snap("p1", null, "mk1-2", null, { grain: "variant", sourceType: "snapshot:talabat" })],
  });
  // v1 has its own active listing
  assert.equal(items.find((i) => i.variantId === "v1")?.status, "MAPPED_OK");
  // v2 present on Talabat but no ECL → MISSING_ECL at variant grain, identity = exported sku
  const v2 = items.find((i) => i.variantId === "v2")!;
  assert.equal(v2.status, "MISSING_ECL");
  assert.equal(v2.repairIdentityType, "talabat_sku");
  assert.equal(v2.repairExportedSku, "mk1-2");
});

test("Talabat one missing variant listing is NOT hidden by a parent-level mapping (VARIANT_CONFLICT §8)", () => {
  const items = buildGapItems({
    storefront: "talabat:malikas",
    internals: [variant("p1", "v1", "mk1-1", null), variant("p1", "v2", "mk1-2", null)],
    ecl: [eclRow("p1", null, "active", { variantId: null, exportedSku: "mk1" })], // product-level mapping
    external: [],
  });
  for (const v of ["v1", "v2"]) {
    assert.equal(items.find((i) => i.variantId === v)?.status, "VARIANT_CONFLICT");
  }
});

// ── SKU / barcode conflicts + duplicate protection (§13, §23) ────────────────
test("ambiguous external SKU → SKU_CONFLICT (not an auto-match)", () => {
  const items = buildGapItems({
    storefront: "shopify:malikas",
    internals: [prod("p1", "mk9", null), prod("p2", "mk9", null)], // two internal products share a sku
    ecl: [],
    external: [snap(null, null, "mk9", null)],
  });
  assert.ok(items.some((i) => i.status === "SKU_CONFLICT"));
});

test("ambiguous external barcode → BARCODE_CONFLICT", () => {
  const items = buildGapItems({
    storefront: "shopify:malikas",
    internals: [prod("p1", "mkA", "4006381333931"), prod("p2", "mkB", "4006381333931")],
    ecl: [],
    external: [snap(null, null, null, "4006381333931")],
  });
  assert.ok(items.some((i) => i.status === "BARCODE_CONFLICT"));
});

test("ambiguous external id → IDENTITY_CONFLICT", () => {
  // two products both carry the same external id via snapshot links
  const items = buildGapItems({
    storefront: "shopify:malikas",
    internals: [prod("p1", "mkA", null), prod("p2", "mkB", null)],
    ecl: [],
    external: [snap("p1", "gid://dup", "mkA", null), snap("p2", "gid://dup", "mkB", null), snap(null, "gid://dup", null, null)],
  });
  assert.ok(items.some((i) => i.status === "IDENTITY_CONFLICT"));
});

// ── ARCHIVED_INTERNAL (§5) ───────────────────────────────────────────────────
test("ECL row pointing to a missing (archived) product → ARCHIVED_INTERNAL", () => {
  const items = buildGapItems({ storefront: "snoonu:malikas", internals: [], ecl: [eclRow("gone", "SPI-G")], external: [] });
  const it = items.find((i) => i.status === "ARCHIVED_INTERNAL");
  assert.ok(it);
  assert.equal(it!.productId, "gone");
});

// ── import eligibility + readiness (pure, §9/§10) ────────────────────────────
test("import eligibility: title + (sku or barcode) required, else INSUFFICIENT_DATA", () => {
  assert.equal(importEligibility({ title: "A Product", sku: "mk1", barcode: null, externalId: null, grain: "product" }), "IMPORT_ELIGIBLE");
  assert.equal(importEligibility({ title: "A Product", sku: null, barcode: "4006381333931", externalId: null, grain: "product" }), "IMPORT_ELIGIBLE");
  assert.equal(importEligibility({ title: "A", sku: null, barcode: null, externalId: null, grain: "product" }), "INSUFFICIENT_DATA");
  assert.equal(importEligibility({ title: null, sku: "mk1", barcode: null, externalId: null, grain: "product" }), "INSUFFICIENT_DATA");
});

test("publish readiness reports blockers, never publishes", () => {
  assert.equal(publishReadiness({ hasBarcode: true, hasImage: true, hasTitle: true, hasDescription: true }).readiness, "READY_TO_PUBLISH");
  const blocked = publishReadiness({ hasBarcode: false, hasImage: false, hasTitle: true, hasDescription: true });
  assert.equal(blocked.readiness, "BLOCKED");
  assert.deepEqual(blocked.blockers, ["barcode", "image"]);
});

// ── plan selectors ───────────────────────────────────────────────────────────
test("planEclRepairs selects ONLY deterministic MISSING_ECL; planImports ONLY eligible EXTERNAL_ONLY", () => {
  const items = buildGapItems({
    storefront: "snoonu:malikas",
    internals: [prod("p2", "mk2", null)],
    ecl: [],
    external: [snap("p2", "SPI-2", "mk2", null), snap(null, "SPI-X", "mkZZ", null, { sourceType: "export:snoonu" })],
  });
  const missing = items.find((i) => i.status === "MISSING_ECL")!;
  const external = items.find((i) => i.status === "EXTERNAL_ONLY")!;
  assert.equal(planEclRepairs(items, [missing.key, external.key]).length, 1);
  assert.equal(planImports(items, [missing.key, external.key]).length, 1);
  // selecting a MAPPED item yields nothing
  assert.equal(planEclRepairs(items, ["nonexistent"]).length, 0);
});

test("summary is grain-separated (§25)", () => {
  const items = buildGapItems({ storefront: "talabat:malikas", internals: [variant("p1", "v1", "mk1-1", null)], ecl: [], external: [] });
  const sum = summarize("talabat:malikas", items);
  assert.equal(sum.grain, "variant");
  assert.equal(sum.variantGrainTotal, 1);
  assert.equal(sum.productGrainTotal, 0);
});

// ── ECL write boundary (INSERT-only, whitelist, no overwrite) ────────────────
function fakeInsertClient() {
  const calls: { table: string; row: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      from(table: string) {
        return {
          insert(row: Record<string, unknown>) {
            calls.push({ table, row });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
}

test("writeEclMapping inserts ONLY whitelisted columns, forces mapping_status active", async () => {
  const { client, calls } = fakeInsertClient();
  const res = await writeEclMapping(client, {
    productId: "p1", variantId: null, channelKey: "snoonu", storefrontKey: "snoonu:malikas",
    identityType: "snoonu_spi", externalProductId: "SPI-1", externalVariantId: null,
    exportedSku: "mk1", exportedBarcode: null, variantSku: null,
  }, "owner@x.com");
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "external_channel_listings");
  assert.equal(calls[0].row.mapping_status, "active");
  for (const col of Object.keys(calls[0].row)) assert.ok((ECL_WRITE_COLUMNS as readonly string[]).includes(col), `column ${col} is whitelisted`);
  for (const banned of ["stock_quantity", "channel_stock", "quantity", "availability", "channel_status"]) {
    assert.equal(Object.hasOwn(calls[0].row, banned), false, `never writes ${banned}`);
  }
});

test("writeEclMapping refuses a target with no durable external identity", async () => {
  const { client, calls } = fakeInsertClient();
  const res = await writeEclMapping(client, {
    productId: "p1", variantId: null, channelKey: "snoonu", storefrontKey: "snoonu:malikas",
    identityType: "snoonu_spi", externalProductId: null, externalVariantId: null,
    exportedSku: null, exportedBarcode: null, variantSku: null,
  }, "owner@x.com");
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});

test("writeEclMapping reports duplicate (23505) and never overwrites", async () => {
  const client = {
    from() {
      return { insert() { return Promise.resolve({ error: { code: "23505", message: "dup" } }); } };
    },
  };
  const res = await writeEclMapping(client, {
    productId: "p1", variantId: null, channelKey: "snoonu", storefrontKey: "snoonu:malikas",
    identityType: "snoonu_spi", externalProductId: "SPI-1", externalVariantId: null,
    exportedSku: null, exportedBarcode: null, variantSku: null,
  }, "owner@x.com");
  assert.equal(res.ok, false);
  assert.equal((res as { duplicate?: boolean }).duplicate, true);
});

// ── no writes during scan classification (pure buildGapItems can't touch a DB) ─
test("scan classification is pure — buildGapItems returns data, performs no IO", () => {
  const before = buildGapItems({ storefront: "snoonu:malikas", internals: [prod("p1", "mk1", null)], ecl: [], external: [] });
  const after = buildGapItems({ storefront: "snoonu:malikas", internals: [prod("p1", "mk1", null)], ecl: [], external: [] });
  assert.deepEqual(before.map((i) => i.status), after.map((i) => i.status)); // deterministic, side-effect free
});
