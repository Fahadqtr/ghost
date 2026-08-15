// CH.6B — apply planning + idempotency tests.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/import-plan.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { planImageImport } from "./import-plan.ts";
import { type ImagePreviewRow, type ImageMatchStatus } from "./merchant-contract.ts";

function row(id: string, status: ImageMatchStatus, imageUrl: string | null = "https://cdn.snoonu.com/a.jpg"): ImagePreviewRow {
  return {
    productId: id, sku: "MK", barcode: "29", storefrontKey: "snoonu:malikas", spi: "SPI",
    currentImage: false, merchantImageUrl: imageUrl, matchStatus: status, reason: "r",
    provenance: { storefrontKey: "snoonu:malikas", spi: "SPI", merchantSku: "MK", merchantBarcode: "29", merchantTitle: "t", internalProductId: id, confidence: "high" },
    selectable: status === "MATCHED",
  };
}

test("only selected + MATCHED rows are imported", () => {
  const rows = [row("p1", "MATCHED"), row("p2", "NEEDS_REVIEW"), row("p3", "MATCHED")];
  const plan = planImageImport({ rows, selected: new Set(["p1", "p2"]), hasImageNow: new Map() });
  assert.deepEqual(plan.map((x) => [x.productId, x.action]), [["p1", "import"], ["p2", "needs_review"]]);
  // p3 not selected → absent from the plan
});

test("stale preview / idempotency: product with an image now is skipped (never overwritten)", () => {
  const rows = [row("p1", "MATCHED")];
  const plan = planImageImport({ rows, selected: new Set(["p1"]), hasImageNow: new Map([["p1", true]]) });
  assert.equal(plan[0].action, "skip");
});

test("MATCHED without a source image → needs_review", () => {
  const rows = [row("p1", "MATCHED", null)];
  const plan = planImageImport({ rows, selected: new Set(["p1"]), hasImageNow: new Map() });
  assert.equal(plan[0].action, "needs_review");
});

test("non-selected rows are never in the plan (no accidental bulk write)", () => {
  const rows = [row("p1", "MATCHED"), row("p2", "MATCHED")];
  const plan = planImageImport({ rows, selected: new Set(["p1"]), hasImageNow: new Map() });
  assert.deepEqual(plan.map((x) => x.productId), ["p1"]);
});
