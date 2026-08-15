// CH.6A — Snoonu export file-contract tests (format compatibility with the real headers).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/snoonu-file-contract.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { canonicalFieldForHeader, canonicalizeSnoonuExportRow, availabilityFromExport } from "./snoonu-file-contract.ts";

test("real Snoonu 'AllExportData' headers map to canonical fields", () => {
  assert.equal(canonicalFieldForHeader("SPI(UniqueIdentifier)"), "spi");
  assert.equal(canonicalFieldForHeader("Product Name (En)(ReadOnly)"), "name_en");
  assert.equal(canonicalFieldForHeader("Product Name (Ar)(ReadOnly)"), "name_ar");
  assert.equal(canonicalFieldForHeader("Price Global(Update)"), "price");
  // Availability/Stock columns are store-name-suffixed → matched by prefix
  assert.equal(canonicalFieldForHeader("Availability Malika's Universe"), "availability");
  assert.equal(canonicalFieldForHeader("Stock for Pure Seoul"), "stock");
  assert.equal(canonicalFieldForHeader("Unrelated Column"), null);
});

test("canonicalize a real export row (both stores share this format)", () => {
  const row = canonicalizeSnoonuExportRow({
    "SPI(UniqueIdentifier)": "69bc5e8a52169cc4e5ddc41b",
    "Product Name (En)(ReadOnly)": "Snail Cream",
    "Price Global(Update)": "55",
    "Availability Malika's Universe": "True",
    "Stock for Malika's Universe": "12",
  });
  assert.equal(row.spi, "69bc5e8a52169cc4e5ddc41b");
  assert.equal(row.name_en, "Snail Cream");
  assert.equal(row.price, "55");
  assert.equal(row.availability, "True");
  assert.equal(row.stock, "12"); // captured but NEVER used as an inventory source
});

test("availability text → explicit SnoonuAvailability", () => {
  assert.equal(availabilityFromExport("True"), "in_stock");
  assert.equal(availabilityFromExport("False"), "out_of_stock");
  assert.equal(availabilityFromExport(""), "unknown");
  assert.equal(availabilityFromExport(null), "unknown");
});

test("SPI is storefront-scoped: the same header in two files yields two independent ids", () => {
  const mal = canonicalizeSnoonuExportRow({ "SPI(UniqueIdentifier)": "SPI-A" });
  const ps = canonicalizeSnoonuExportRow({ "SPI(UniqueIdentifier)": "SPI-B" });
  assert.notEqual(mal.spi, ps.spi); // interpreted per the storefront the file came from
});
