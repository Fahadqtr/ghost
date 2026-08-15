// CH.6A — Snoonu diagnostics compute tests (candidate counts, per storefront).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/snoonu-diagnostics.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { computeSnoonuDiagnostics, computeSnoonuStorefrontDiagnostics, type SnoonuDiagEclRow } from "./snoonu-diagnostics.ts";

const products = [
  { id: "p1", sku: "MK-1", barcode: "29001", hasImage: true },
  { id: "p2", sku: "MK-2", barcode: null,    hasImage: false }, // missing image + barcode
  { id: "p3", sku: "MK-3", barcode: "29003", hasImage: true },
];

const ecl: SnoonuDiagEclRow[] = [
  { productId: "p1", storefrontKey: "snoonu:malikas",    spi: "A1", mappingStatus: "active" },
  { productId: "p2", storefrontKey: "snoonu:malikas",    spi: "A2", mappingStatus: "active" },
  { productId: "p1", storefrontKey: "snoonu:pure_seoul", spi: "B1", mappingStatus: "active" },
  { productId: "p3", storefrontKey: "snoonu:malikas",    spi: null, mappingStatus: "needs_review" },
  { productId: "gone", storefrontKey: "snoonu:malikas",  spi: "A9", mappingStatus: "active" }, // orphan
];

test("per-storefront counts are independent (Malikas vs Pure Seoul)", () => {
  const [mal, ps] = computeSnoonuDiagnostics({ products, eclRows: ecl });
  assert.equal(mal.storefrontKey, "snoonu:malikas");
  assert.equal(mal.mapped, 2);        // p1, p2 (p3 is needs_review w/o SPI; gone is orphan)
  assert.equal(mal.unmapped, 1);      // 3 catalog − 2 mapped
  assert.equal(mal.needsReview, 1);   // p3
  assert.equal(mal.orphaned, 1);      // "gone"
  assert.equal(mal.stale, 0);         // product-grain, no SKU drift

  assert.equal(ps.storefrontKey, "snoonu:pure_seoul");
  assert.equal(ps.mapped, 1);         // only p1 here — store isolation
  assert.equal(ps.unmapped, 2);
});

test("candidate counts: missing image / barcode over MAPPED products", () => {
  const mal = computeSnoonuStorefrontDiagnostics({ products, eclRows: ecl }, "snoonu:malikas");
  assert.equal(mal.missingImageCandidates, 1);   // p2
  assert.equal(mal.missingBarcodeCandidates, 1); // p2
});

test("availability mismatch candidate uses EXPLICIT availability, never quantity", () => {
  const availability = new Map([["p1", "out_of_stock" as const], ["p2", "in_stock" as const]]);
  const mal = computeSnoonuStorefrontDiagnostics({ products, eclRows: ecl, availability }, "snoonu:malikas");
  assert.equal(mal.availabilityMismatchCandidates, 1); // p1 flagged out_of_stock
});

test("a Pure Seoul mapping never counts toward Malikas", () => {
  const only = ecl.filter((r) => r.storefrontKey === "snoonu:pure_seoul");
  const mal = computeSnoonuStorefrontDiagnostics({ products, eclRows: only }, "snoonu:malikas");
  assert.equal(mal.mapped, 0);
  assert.equal(mal.unmapped, 3);
});
