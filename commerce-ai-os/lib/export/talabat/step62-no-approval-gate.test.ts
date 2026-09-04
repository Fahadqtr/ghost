// STEP 62 — Talabat export has NO approval gate.
//
// Owner decision: Talabat aligns to the active Snoonu master. Eligibility is
//   1. member of the active snoonu:malikas master   (STEP 60, applied upstream)
//   2. passes lifecycle rules — NOT STOPPED
//   3. passes normal structural/export validation
// and explicitly NOT products.approval, NOT platform_status(talabat).approval.
//
// Before this, platform_status(talabat).approval was NULL for all 1530 products
// while the gate demanded === "Approved", so eligible was 0 — the export could
// not generate at all. Meanwhile the legacy diff/queue and snapshot paths gated
// on the OTHER field, products.approval, so the two Talabat workflows disagreed.
//
// Approval infrastructure is RETAINED globally (the helper, the columns, the
// /platforms UI); it is only removed as an export gate.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step62-no-approval-gate.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { buildTalabatExport, isApprovedForTalabat, type ExportProductInput } from "../../talabat/export.ts";
import { diffTalabat, type TalabatOurRow } from "../../talabat-diff.ts";
import { buildMasterScope } from "../../home/master-scope.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
/** Read a source file with comments stripped — assert on CODE, never prose. */
const code = (rel: string): string =>
  readFileSync(join(APP_ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");

const PREVIEW = "lib/export/talabat/preview.ts";
const PREVIEW_SERVER = "lib/export/talabat/preview.server.ts";
const EXPORT = "lib/talabat/export.ts";
const CATALOG_SYNC = "lib/talabat/mapping-sync/catalog-sync.server.ts";
const DIFF = "lib/talabat-diff.ts";
const CAPTURE = "lib/platforms/talabat/capture-compute.ts";
const SNAP_CAPTURE = "lib/platforms/talabat/snapshot-capture.ts";
const ACTIONS = "app/(app)/import-export/talabat-actions.ts";

function product(over: Partial<TalabatPreviewProduct> & { id: string; sku: string }): TalabatPreviewProduct {
  return {
    barcode: "1234567890123", nameEn: `EN ${over.sku}`, nameAr: `ع ${over.sku}`,
    price: 50, discountPrice: null, category: "Makeup", descriptionEn: "d", descriptionAr: "و",
    imageUrl: `https://example.test/${over.sku}.jpg`, imageFilename: `${over.sku}.jpg`,
    galleryImageUrls: [], imageCount: 1, approved: true, lifecycleState: "ACTIVE",
    variants: [], ...over,
  };
}
function exportProduct(over: Partial<ExportProductInput> = {}): ExportProductInput {
  return {
    id: "p1", sku: "mk1", barcode: "1234567890123", name_en: "EN", name_ar: "ع",
    price: 50, discount_price: null, main_category: "Makeup",
    description_en: "d", description_ar: "و", image_filename: "mk1.jpg",
    image_url: "https://example.test/mk1.jpg", stock_status: "In Stock", ...over,
  };
}

// ── 1. approval never blocks ─────────────────────────────────────────────────

test("1: an UNAPPROVED master product is not blocked by the certified preview", () => {
  for (const approved of [true, false]) {
    const res = buildTalabatPreview({ products: [product({ id: "p", sku: "mk1", approved })] });
    const row = res.rows[0]!;
    assert.equal(row.reasons.some((r) => r.code === "LIFECYCLE_NOT_ELIGIBLE"), false,
      `approved=${approved} must not produce a lifecycle block`);
    assert.notEqual(row.status, "BLOCKED", `approved=${approved} must still export`);
  }
});

test("2: approval changes NOTHING about the produced row", () => {
  const yes = buildTalabatPreview({ products: [product({ id: "p", sku: "mk1", approved: true })] });
  const no = buildTalabatPreview({ products: [product({ id: "p", sku: "mk1", approved: false })] });
  assert.deepEqual(
    { ...no.rows[0]!, approved: true }, yes.rows[0]!,
    "the only difference between an approved and unapproved row is the informational flag",
  );
  assert.equal(yes.summary.blocked, no.summary.blocked);
});

test("3: buildTalabatExport exports on EVERY approval value", () => {
  for (const status of [undefined, null, "", "Not Listed", "Pending", "Rejected", "SentAI", "Approved"]) {
    const approved = isApprovedForTalabat(status as string | null | undefined);
    const r = buildTalabatExport([exportProduct({ approved })], []);
    assert.equal(r.rows.length, 1, `approval "${String(status)}" must still export`);
    assert.equal(r.warnings.some((w) => w.kind === "excluded_not_approved"), false);
  }
  // and with the field entirely absent
  assert.equal(buildTalabatExport([exportProduct()], []).rows.length, 1);
});

test("4: the 51 unreviewed master products (approval NULL) are eligible", () => {
  // production shape: created after the last review pass, approval NULL, ACTIVE
  const unreviewed = ["mk2294", "mk2320", "mk2340", "mk2341", "mk2344"].map((sku, i) =>
    product({ id: sku, sku, approved: false, barcode: `111111111000${i}` }));
  const res = buildTalabatPreview({ products: unreviewed });
  assert.equal(res.rows.length, 5);
  assert.equal(res.rows.every((r) => r.status !== "BLOCKED"), true, "none blocked on approval");
  assert.equal(res.summary.blocked, 0);
});

// ── 2. what MUST still block ─────────────────────────────────────────────────

test("5: STOPPED still blocks — lifecycle is intact", () => {
  const res = buildTalabatPreview({
    products: [product({ id: "s", sku: "mkS", lifecycleState: "STOPPED", platformStatus: "Stopped", approved: true })],
  });
  const row = res.rows[0]!;
  assert.ok(row.reasons.some((r) => r.code === "LIFECYCLE_NOT_ELIGIBLE" && r.blocking), "STOPPED blocks");
  assert.equal(row.status, "BLOCKED");
  // and STOPPED blocks regardless of approval
  const alsoStopped = buildTalabatPreview({
    products: [product({ id: "s2", sku: "mkS2", lifecycleState: "STOPPED", platformStatus: "Stopped", approved: false })],
  });
  assert.equal(alsoStopped.rows[0]!.status, "BLOCKED");
});

test("6: structural validation still blocks (SKU / barcode / image / title / duplicates)", () => {
  const noSku = buildTalabatPreview({ products: [product({ id: "a", sku: "" })] });
  assert.ok(noSku.rows[0]!.reasons.some((r) => r.code === "MISSING_SKU" && r.blocking));
  const noBarcode = buildTalabatPreview({ products: [product({ id: "b", sku: "mkB", barcode: null })] });
  assert.ok(noBarcode.rows[0]!.reasons.some((r) => r.code === "MISSING_BARCODE" && r.blocking));
  const noImage = buildTalabatPreview({
    products: [product({ id: "c", sku: "mkC", imageUrl: null, imageFilename: null, imageCount: 0 })] });
  assert.ok(noImage.rows[0]!.reasons.some((r) => r.code === "MISSING_IMAGE" && r.blocking));
  const dup = buildTalabatPreview({
    products: [product({ id: "d1", sku: "mkD", barcode: "9999999999999" }),
               product({ id: "d2", sku: "mkE", barcode: "9999999999999" })] });
  assert.ok(dup.rows.every((r) => r.reasons.some((x) => x.code === "DUPLICATE_BARCODE" && x.blocking)));
});

// ── 3. STEP 60 survives ──────────────────────────────────────────────────────

test("7: STEP 60 master scope and the barcode-twin fix are intact", () => {
  const s = code(PREVIEW_SERVER);
  assert.match(s, /loadMasterScope\(\)/, "master seam still wired");
  assert.match(s, /const productRows = allProductRows\.filter\(/);
  assert.match(s, /if \(!scope\.ok\) return null;/, "still fails closed");
  // the twin fix is a property of scoping BEFORE the dataset-wide dup check
  const SHARED = "0429766714844";
  const both = [product({ id: "inMaster", sku: "mk2218", barcode: SHARED }),
                product({ id: "outside", sku: "mk1730", barcode: SHARED })];
  const scope = buildMasterScope([{ product_id: "inMaster" }]);
  const scoped = buildTalabatPreview({ products: both.filter((p) => scope.ids.has(p.id)) });
  assert.equal(scoped.rows.length, 1);
  assert.equal(scoped.rows[0]!.reasons.some((r) => r.code === "DUPLICATE_BARCODE"), false);
});

// ── 4. no approval gate remains in ANY Talabat export path ───────────────────

test("8: the certified preview and pure exporter contain no approval gate", () => {
  const pv = code(PREVIEW);
  assert.ok(!/isApprovedForTalabat/.test(pv), "preview no longer calls the approval helper");
  assert.ok(!/block\([^)]*approved/.test(pv), "no approval-driven block");
  assert.match(pv, /state === "STOPPED"/, "lifecycle block retained");

  const ex = code(EXPORT);
  assert.ok(!/p\.approved !== true/.test(ex), "exporter no longer excludes on approval");
  assert.ok(!/kind: "excluded_not_approved"/.test(ex), "and never emits that exclusion");
});

test("9: mapping/catalog sync reads the master, not the approval overlay", () => {
  const s = code(CATALOG_SYNC);
  assert.ok(!/isApprovedForTalabat/.test(s), "no approval helper");
  assert.ok(!/platform_status/.test(s), "no approval overlay read");
  assert.match(s, /loadMasterScope\(\)/);
  assert.match(s, /if \(!scope\.ok\) return EMPTY;/, "fails closed");
});

test("10: the legacy diff / queue and snapshot capture gate on master membership", () => {
  const d = code(DIFF);
  assert.ok(!/\.approval/.test(d), "diff never reads an approval field");
  assert.match(d, /o\.eligible !== true/, "diff gates on caller-supplied eligibility");

  const c = code(CAPTURE);
  assert.ok(!/\.approval/.test(c), "capture never reads an approval field");
  assert.match(c, /o\.eligible !== true/);

  const sc = code(SNAP_CAPTURE);
  assert.ok(!/approval/.test(sc), "the snapshot loader no longer selects approval");
  assert.match(sc, /loadMasterScope/);

  const a = code(ACTIONS);
  assert.ok(!/approval/.test(a), "the legacy action no longer reads approval");
  assert.match(a, /loadMasterScope/);
  assert.match(a, /master\.has\(String\(p\.id\)\)/);
});

test("11: no Talabat export path references either approval source as a gate", () => {
  for (const rel of [PREVIEW, EXPORT, CATALOG_SYNC, DIFF, CAPTURE, SNAP_CAPTURE, ACTIONS]) {
    const s = code(rel);
    assert.ok(!/products\.approval/.test(s), `${rel} must not gate on products.approval`);
    assert.ok(!/platform_status[\s\S]{0,80}approval/.test(s), `${rel} must not gate on the talabat overlay`);
  }
});

// ── 5. approval infrastructure is retained globally ──────────────────────────

test("12: approval infrastructure still exists — only the export gate is gone", () => {
  // the helper is unchanged and still exported
  assert.equal(isApprovedForTalabat("Approved"), true);
  for (const v of [undefined, null, "", "Pending", "Rejected", "SentAI", "approved"]) {
    assert.equal(isApprovedForTalabat(v as string | null | undefined), false);
  }
  // the per-platform approval UI still writes the overlay for non-master platforms
  const hub = raw("app/(app)/platforms/actions.ts");
  assert.match(hub, /from\("platform_status"\)\.upsert/, "the /platforms writer is untouched");
  assert.match(hub, /from\("products"\)\.update\(patch/, "the master approval writer is untouched");
  // and the preview still CARRIES the flag for display
  assert.match(code(PREVIEW_SERVER), /isApprovedForTalabat/, "still read as an informational flag");
});

test("13: diffTalabat honours eligibility, and eligibility alone", () => {
  const rows = (over: Partial<TalabatOurRow> = {}): TalabatOurRow[] => ([{
    id: "p1", sku: "mk1", barcode: "1234567890123", name_en: "EN", name_ar: "ع",
    eligible: true, hasVariants: false, image_url: "u", price: 10, discount_price: null, ...over,
  }]);
  const theirs = [{ SKU: "mk999", "Product Name": "other" }];
  const inMaster = diffTalabat(rows({ eligible: true }), theirs);
  assert.equal(inMaster.counts.eligible, 1);
  assert.equal(inMaster.counts.notEligible, 0);
  assert.equal(inMaster.counts.missing, 1, "an eligible product absent from their sheet is missing");

  const outside = diffTalabat(rows({ eligible: false }), theirs);
  assert.equal(outside.counts.eligible, 0);
  assert.equal(outside.counts.notEligible, 1);
  assert.equal(outside.counts.missing, 0, "an out-of-master product is never reported missing");
});
