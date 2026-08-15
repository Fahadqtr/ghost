// CH.6B — missing-image scan tests (candidates, per-store, summary; no writes).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/missing-image-scan.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { scanMissingImages } from "./missing-image-scan.ts";
import { type ImageCandidateProduct, type MerchantListing } from "./merchant-contract.ts";

const products: ImageCandidateProduct[] = [
  { id: "p1", sku: "MK-1", barcode: "29001", hasPrimaryImage: false }, // candidate, matchable
  { id: "p2", sku: "MK-2", barcode: "29002", hasPrimaryImage: true },  // NOT a candidate (has image)
  { id: "p3", sku: "MK-3", barcode: "29003", hasPrimaryImage: false }, // candidate, no SPI
];

test("only products without a primary image are candidates; MATCHED classification", () => {
  const spiByProduct = new Map([["p1", "SPI-A"], ["p3", null]]);
  const listingByProduct = new Map<string, MerchantListing | null>([
    ["p1", { storefrontKey: "snoonu:malikas", spi: "SPI-A", sku: "MK-1", barcode: "29001", title: "x", imageUrl: "https://cdn.snoonu.com/a.jpg" }],
  ]);
  const { rows, summary } = scanMissingImages({ storefrontKey: "snoonu:malikas", products, spiByProduct, listingByProduct, sessionState: "authenticated" });
  assert.equal(rows.length, 2);          // p1, p3 (p2 excluded — already imaged)
  assert.equal(summary.missing, 2);
  assert.equal(summary.matched, 1);      // p1
  assert.equal(summary.notFound, 1);     // p3 (no SPI)
  assert.equal(rows.find((r) => r.productId === "p1")!.selectable, true);
  assert.equal(rows.find((r) => r.productId === "p3")!.selectable, false);
});

test("session_required marks every candidate SESSION_REQUIRED (no merchant lookups)", () => {
  const { summary } = scanMissingImages({
    storefrontKey: "snoonu:malikas", products, spiByProduct: new Map(), listingByProduct: new Map(), sessionState: "session_required",
  });
  assert.equal(summary.sessionRequired, 2);
  assert.equal(summary.matched, 0);
});

test("Pure Seoul scan uses its own SPIs — a Malikas mapping never leaks in", () => {
  // Only a Malikas SPI is known; scanning Pure Seoul finds no SPI → NOT_FOUND.
  const spiByProduct = new Map<string, string | null>(); // none for pure_seoul
  const { summary } = scanMissingImages({ storefrontKey: "snoonu:pure_seoul", products, spiByProduct, listingByProduct: new Map(), sessionState: "authenticated" });
  assert.equal(summary.matched, 0);
  assert.equal(summary.notFound, 2);
});
