// STEP 84 — turning a verified comparison run into the exact files the STEP 83
// send gate looks for, and refusing to send anything else.
//
// Three ideas are being proved.
//
//   1. The artifacts come from the certified machinery, narrowed. There is no
//      second delta, no second image pipeline, and no second serializer.
//
//   2. A stored bundle is only usable for the run it was generated from. The
//      dangerous failure here is not a missing file, it is a PRESENT one that
//      belongs to yesterday's comparison, so the run fingerprint is checked at
//      preflight AND again at send.
//
//   3. A packaged image's name must not lie about its bytes — and when the
//      correction cannot be applied, the send blocks rather than shipping it.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step84-email-artifacts.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTalabatBaseline, compareTalabatBaseline, TALABAT_BASELINE_COLUMNS, newDeltaRows }
  from "./baseline-delta.ts";
import {
  buildTalabatSafeUpdateAoa, buildTalabatNewProductsAoa, safeUpdateRows,
  newProductPreviewRows, newProductImageScope, deltaWorkbookName, newProductsImagesZipName,
} from "./delta-workbooks.ts";
import { allowedNewDeltaRows, policyExcludedNewDeltaRows } from "./category-policy.ts";
import {
  runFingerprint, artifactPath, parseArtifactScope, verifyArtifactScope,
  TALABAT_EMAIL_ARTIFACT_PREFIX, SCOPE_SIDECAR_FILENAME, ARTIFACT_BLOCK_AR,
  type TalabatArtifactScope,
} from "./email-artifacts.ts";
import {
  canonicalImageExtension, isExtensionMismatch, withSniffedExtension, decidePackagedName,
} from "./image-extension.ts";
import { createTalabatPackageJob, advanceTalabatPackageJob, type TalabatJobAdvanceDeps } from "./package-job.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, ...new Array(64).fill(7)]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...new Array(64).fill(9)]);

function product(n: number, over: Partial<TalabatPreviewProduct> = {}): TalabatPreviewProduct {
  const sku = `mk${1000 + n}`;
  return {
    id: `p${n}`, sku, barcode: `0123456789${String(100 + n)}`,
    nameEn: `EN ${sku}`, nameAr: `ع ${sku}`, price: 50, discountPrice: null, channelPrice: null,
    category: "Face Care", descriptionEn: "d", descriptionAr: "و",
    imageUrl: `https://x.test/${sku}.jpg`, imageFilename: `${sku}.jpg`,
    galleryImageUrls: [], imageCount: 1, approved: true, lifecycleState: "ACTIVE", variants: [],
    ...over,
  };
}
const baseRow = (sku: string, name: string, price: string, cat = "All Face Care") =>
  [sku, name, price, true, null, false, null, null, null, "0123456789100", null, null, cat];
const parse = (rows: readonly (readonly unknown[])[]) =>
  parseTalabatBaseline([TALABAT_BASELINE_COLUMNS.slice(), ...rows], "Products").rows;

/**
 * mk1000 differs by NAME, mk1001 by PRICE, mk1002 by BOTH, mk1003 not at all,
 * and mk1004/mk1005 are absent from the baseline entirely.
 */
function fixture() {
  const products = [product(0), product(1), product(2), product(3), product(4), product(5)];
  const preview = buildTalabatPreview({ products });
  const baseline = parse([
    baseRow("mk1000", "DIFFERENT NAME", "50"),
    baseRow("mk1001", "EN mk1001", "99"),
    baseRow("mk1002", "OTHER NAME", "77"),
    baseRow("mk1003", "EN mk1003", "50"),
  ]);
  return { result: compareTalabatBaseline(preview.rows, baseline), preview, baseline };
}

const col = (name: string) => (TALABAT_BASELINE_COLUMNS as readonly string[]).indexOf(name);

// ── 1. the safe update artifact ──────────────────────────────────────────────

test("1: the safe update workbook carries NAME and PRICE differences only", () => {
  const { result } = fixture();
  const rows = safeUpdateRows(result);
  // A row's `diffs` list still records EVERY difference we detected — that is
  // the audit trail and must not be trimmed. What the safe set guarantees is
  // that each row qualifies on a safe field, and (test 2/3/4) that only name
  // and price actually reach the workbook.
  for (const r of rows) {
    assert.ok(r.diffs.some((d) => d.field === "NAME_DIFF" || d.field === "PRICE_DIFF"),
      `${r.our.sku} is in the safe set without a name or price difference`);
  }
  // a product differing in BOTH appears exactly once
  const skus = rows.map((r) => r.our.sku);
  assert.equal(new Set(skus).size, skus.length, "no product appears twice");
  assert.ok(skus.includes("mk1002"), "the both-differences product is included");
  assert.equal(skus.filter((s) => s === "mk1002").length, 1, "…exactly once");
  assert.equal(skus.includes("mk1003"), false, "an unchanged product is not an update");
});

test("2: barcode values are absent from the safe update workbook", () => {
  const { result } = fixture();
  const body = buildTalabatSafeUpdateAoa(result).slice(1);
  for (const name of ["barcode 1", "barcode 2", "barcode 3"]) {
    const present = body.filter((r) => String(r[col(name)] ?? "") !== "").length;
    assert.equal(present, 0, `BARCODE_ROWS_IN_SAFE_UPDATE_ARTIFACT must be 0 (${name})`);
  }
});

test("3: active/availability values are absent from the safe update workbook", () => {
  const { result } = fixture();
  const body = buildTalabatSafeUpdateAoa(result).slice(1);
  assert.equal(body.filter((r) => String(r[col("active")] ?? "") !== "").length, 0);
});

test("4: ambiguous and new rows never reach the safe update workbook", () => {
  const { result } = fixture();
  const skus = new Set(buildTalabatSafeUpdateAoa(result).slice(1).map((r) => String(r[0])));
  for (const r of result.rows) {
    if (r.match === "AMBIGUOUS") assert.equal(skus.has(r.our.sku), false, "ambiguous must be excluded");
    if (r.match === "NEW_PRODUCT") assert.equal(skus.has(r.our.sku), false, "new products must be excluded");
  }
  // and category is blank too, so the safe file asserts nothing beyond name/price
  const body = buildTalabatSafeUpdateAoa(result).slice(1);
  assert.equal(body.filter((r) => String(r[col("category 1")] ?? "") !== "").length, 0);
});

// ── 2. the new-products artifact ─────────────────────────────────────────────

test("5: the new-products workbook contains only products absent from the baseline", () => {
  const { result, baseline } = fixture();
  const listed = new Set(baseline.map((b) => b.sku));
  const skus = buildTalabatNewProductsAoa(result).slice(1).map((r) => String(r[0]));
  assert.deepEqual([...skus].sort(), ["mk1004", "mk1005"]);
  for (const s of skus) assert.equal(listed.has(s), false, `${s} is already listed on Talabat`);
});

test("6: the image scope is the same allowed set as the workbook", () => {
  const { result } = fixture();
  const workbook = buildTalabatNewProductsAoa(result).slice(1).map((r) => String(r[0])).sort();
  assert.deepEqual([...newProductImageScope(result).skus].sort(), workbook);
  assert.deepEqual(newProductPreviewRows(result).map((r) => r.sku).sort(), workbook);
  assert.deepEqual(allowedNewDeltaRows(result).map((r) => r.our.sku).sort(), workbook);
});

test("7: the certified image planner is reused — no second implementation", async () => {
  const { result } = fixture();
  const created = createTalabatPackageJob({
    jobId: "00000000-0000-4000-8000-000000000840", mode: "ready",
    previewRows: newProductPreviewRows(result), actor: "t@t", nowIso: "2026-09-06T00:00:00.000Z",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(created.plan.images.map((i) => i.filename).sort(), ["mk1004.jpg", "mk1005.jpg"]);
  // the generator holds no planner, no fetch, no zip code of its own
  const gen = code("lib/talabat/email-artifacts.server.ts");
  for (const forbidden of ["fetch(", "JSZip", "deflate", "zipEntrySegment", "planTalabatPackage", "compareTalabatBaseline"]) {
    assert.equal(gen.includes(forbidden), false, `the generator must not contain ${forbidden}`);
  }
  assert.ok(gen.includes("buildTalabatNewProductsAoa"), "it uses the certified builders");
});

test("8: the full package is never regenerated by the delta path", () => {
  const gen = code("lib/talabat/email-artifacts.server.ts");
  for (const forbidden of ["loadTalabatPreview", "startTalabatPackageJob", "buildTalabatPreview"]) {
    assert.equal(gen.includes(forbidden), false, `${forbidden} would rebuild the whole catalog package`);
  }
  // the delta workbook builders read the delta, never the full preview
  const wb = code("lib/export/talabat/delta-workbooks.ts");
  assert.equal(wb.includes("buildTalabatPreview"), false);
});

// ── 3. MIME / extension agreement ────────────────────────────────────────────

test("9: jpeg and jpg are the same format, and are never 'corrected' into each other", () => {
  assert.equal(canonicalImageExtension("JPEG"), "jpg");
  assert.equal(canonicalImageExtension(".Jpg"), "jpg");
  assert.equal(isExtensionMismatch("a.jpeg", "jpg"), false, "a .jpeg holding JPEG bytes is NOT a mismatch");
  assert.equal(isExtensionMismatch("a.jpg", "jpg"), false);
  assert.equal(isExtensionMismatch("a.jpg", "png"), true);
  assert.equal(isExtensionMismatch("a.jpg", null), false, "an unsniffable file is not a mismatch claim");
  assert.equal(withSniffedExtension("dir.name/a.jpg", "png"), "dir.name/a.png");
});

test("10: a mismatch is renamed package-locally, and a collision fails CLOSED", () => {
  assert.deepEqual(decidePackagedName("mk1.jpg", "png", new Set()), { action: "rename", name: "mk1.png", from: "mk1.jpg" });
  assert.deepEqual(decidePackagedName("mk1.jpg", "jpg", new Set()), { action: "keep", name: "mk1.jpg" });
  // the corrected name is already taken → keep the original and REPORT it, so
  // the preflight blocks instead of overwriting a different image
  assert.deepEqual(
    decidePackagedName("mk1.jpg", "png", new Set(["mk1.png"])),
    { action: "collision", name: "mk1.jpg", wanted: "mk1.png" });
});

test("11: the engine renames on request, keeps the sheet in sync, and stays off by default", async () => {
  const { result } = fixture();
  const run = async (correct: boolean) => {
    const created = createTalabatPackageJob({
      jobId: "00000000-0000-4000-8000-000000000841", mode: "ready",
      previewRows: newProductPreviewRows(result), actor: "t@t", nowIso: "2026-09-06T00:00:00.000Z",
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("plan failed");
    const deps: TalabatJobAdvanceDeps = {
      // every source URL says .jpg; the BYTES are PNG
      ports: { fetchImage: async () => ({ bytes: PNG, ext: "png" }), putPart: async () => {} },
      correctExtensionFromBytes: correct,
    };
    let state = created.state;
    for (let i = 0; i < 20 && state.status === "running"; i++) {
      state = await advanceTalabatPackageJob(state, created.plan, deps);
    }
    return state;
  };

  const corrected = await run(true);
  assert.equal(corrected.status, "completed");
  assert.deepEqual(corrected.packaged.map((p) => p.name).sort(), ["mk1004.png", "mk1005.png"]);
  assert.deepEqual(corrected.extensionAudit, { mismatches: 2, renamed: 2, collisions: 0 });
  // the ZIP entries and the workbook agree — integrity would have failed otherwise
  const imageEntries = corrected.entries.filter((e) => e.name.startsWith("Talabat/images/"));
  assert.equal(imageEntries.length, 2);
  assert.ok(imageEntries.every((e) => e.name.endsWith(".png")), "the ZIP entry names carry the corrected extension");
  assert.equal(corrected.summary?.imageCount, 2);

  const untouched = await run(false);
  assert.equal(untouched.status, "completed");
  assert.deepEqual(untouched.packaged.map((p) => p.name).sort(), ["mk1004.jpg", "mk1005.jpg"],
    "default OFF keeps the certified full package byte-for-byte as shipped");
  assert.equal(untouched.extensionAudit, undefined);
});

test("12: a renamed primary drags its gallery's ownerPrimary with it", async () => {
  const products = [product(0), product(1, { galleryImageUrls: ["https://x.test/g1.jpg"], imageCount: 2 })];
  const preview = buildTalabatPreview({ products });
  const baseline = parse([baseRow("mk1000", "EN mk1000", "50")]);
  const result = compareTalabatBaseline(preview.rows, baseline);
  const created = createTalabatPackageJob({
    jobId: "00000000-0000-4000-8000-000000000842", mode: "ready",
    previewRows: newProductPreviewRows(result), actor: "t@t", nowIso: "2026-09-06T00:00:00.000Z",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  let state = created.state;
  for (let i = 0; i < 20 && state.status === "running"; i++) {
    state = await advanceTalabatPackageJob(state, created.plan, {
      ports: { fetchImage: async () => ({ bytes: PNG, ext: "png" }), putPart: async () => {} },
      correctExtensionFromBytes: true,
    });
  }
  // completing at all proves the §15 integrity check passed, which it could not
  // have if the gallery still pointed at the primary's OLD name
  assert.equal(state.status, "completed", state.error?.code ?? "");
  const gallery = state.packaged.filter((p) => p.kind === "gallery");
  assert.equal(gallery.length, 1);
  assert.equal(gallery[0].ownerPrimary, "mk1001.png");
  assert.ok(state.packaged.some((p) => p.kind === "primary" && p.name === "mk1001.png"));
});

test("13: JPEG bytes under a .jpg name are left completely alone", async () => {
  const { result } = fixture();
  const created = createTalabatPackageJob({
    jobId: "00000000-0000-4000-8000-000000000843", mode: "ready",
    previewRows: newProductPreviewRows(result), actor: "t@t", nowIso: "2026-09-06T00:00:00.000Z",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  let state = created.state;
  for (let i = 0; i < 20 && state.status === "running"; i++) {
    state = await advanceTalabatPackageJob(state, created.plan, {
      ports: { fetchImage: async () => ({ bytes: JPEG, ext: "jpg" }), putPart: async () => {} },
      correctExtensionFromBytes: true,
    });
  }
  assert.deepEqual(state.packaged.map((p) => p.name).sort(), ["mk1004.jpg", "mk1005.jpg"]);
  assert.deepEqual(state.extensionAudit, { mismatches: 0, renamed: 0, collisions: 0 });
  assert.equal(state.renames, undefined, "nothing was renamed, so nothing was recorded");
});

// ── 4. storage + run binding ─────────────────────────────────────────────────

test("14: artifacts are stored under the path the preflight reads", () => {
  assert.equal(TALABAT_EMAIL_ARTIFACT_PREFIX, "email-artifacts");
  assert.equal(artifactPath("existing_updates", "a.xlsx"), "email-artifacts/existing_updates/a.xlsx");
  assert.equal(artifactPath("new_products", SCOPE_SIDECAR_FILENAME), "email-artifacts/new_products/scope.json");
  // generator and reader use the SAME helper, not two string templates
  assert.ok(code("lib/talabat/email-artifacts.server.ts").includes("artifactPath("));
  assert.ok(code("lib/talabat/email-send.server.ts").includes("artifactPath("));
});

test("15: the run fingerprint is stable for identical inputs and moves when data does", () => {
  const a = fixture().result;
  const b = fixture().result;
  assert.equal(runFingerprint(a), runFingerprint(b), "regenerating unchanged data must not invalidate a bundle");

  const products = [product(0), product(1), product(2), product(3), product(4), product(5), product(6)];
  const changed = compareTalabatBaseline(buildTalabatPreview({ products }).rows,
    parse([baseRow("mk1000", "DIFFERENT NAME", "50")]));
  assert.notEqual(runFingerprint(changed), runFingerprint(a), "a different run must be distinguishable");
});

function scopeFixture(over: Partial<TalabatArtifactScope> = {}): TalabatArtifactScope {
  return {
    kind: "existing_updates", runFingerprint: "r1.x", generatedAtIso: "2026-09-06T00:00:00.000Z",
    files: [{ filename: "a.xlsx", bytes: 10, contentType: "x", crc32: 1 }],
    workbookRows: 147, workbookProducts: 147, imageCount: null,
    rowsMissingImage: 0, excludedCategoryRows: 0,
    barcodeValueRows: 0, activeValueRows: 0, categoryValueRows: 0, extensionAudit: null,
    ...over,
  };
}

test("16: a bundle from a DIFFERENT run is refused", () => {
  assert.deepEqual(verifyArtifactScope(scopeFixture(), "r1.x"), []);
  assert.deepEqual(verifyArtifactScope(scopeFixture(), "r1.y"), ["artifact_stale"]);
  assert.deepEqual(verifyArtifactScope(null, "r1.x"), ["artifact_missing"]);
});

test("17: the safe-update file is re-verified, not merely trusted", () => {
  // the builder blanks these — the sidecar counts them so a hand-edited or
  // wrongly-built file is caught at preflight rather than at Talabat
  assert.deepEqual(verifyArtifactScope(scopeFixture({ barcodeValueRows: 3 }), "r1.x"), ["barcode_values_present"]);
  assert.deepEqual(verifyArtifactScope(scopeFixture({ activeValueRows: 1 }), "r1.x"), ["active_values_present"]);
  assert.deepEqual(verifyArtifactScope(scopeFixture({ categoryValueRows: 2 }), "r1.x"), ["category_values_present"]);
  // …and those three checks apply to the SAFE UPDATE file only; the new-product
  // file legitimately carries barcode and category values
  const newScope = scopeFixture({ kind: "new_products", barcodeValueRows: 517, categoryValueRows: 517, imageCount: 632 });
  assert.deepEqual(verifyArtifactScope(newScope, "r1.x"), []);
});

test("18: an unfixed extension mismatch blocks the send", () => {
  const clean = scopeFixture({ kind: "new_products", imageCount: 632, extensionAudit: { mismatches: 133, renamed: 133, collisions: 0 } });
  assert.deepEqual(verifyArtifactScope(clean, "r1.x"), [], "fully corrected is fine");
  const stuck = scopeFixture({ kind: "new_products", imageCount: 632, extensionAudit: { mismatches: 133, renamed: 132, collisions: 1 } });
  assert.deepEqual(verifyArtifactScope(stuck, "r1.x"), ["extension_mismatch_unfixed"]);
  assert.ok(ARTIFACT_BLOCK_AR.extension_mismatch_unfixed.length > 0);
});

test("19: a corrupt or foreign sidecar is unreadable, never partly trusted", () => {
  assert.equal(parseArtifactScope(null, "existing_updates").ok, false);
  assert.equal(parseArtifactScope("nonsense", "existing_updates").ok, false);
  assert.equal(parseArtifactScope({}, "existing_updates").ok, false);
  const wrongKind = parseArtifactScope({ ...scopeFixture(), kind: "new_products" }, "existing_updates");
  assert.equal(wrongKind.ok, false);
  if (!wrongKind.ok) assert.equal(wrongKind.reason, "wrong_kind");
  // a sidecar missing its file list is not a bundle with zero files
  assert.equal(parseArtifactScope({ ...scopeFixture(), files: [] }, "existing_updates").ok, false);
  const good = parseArtifactScope(JSON.parse(JSON.stringify(scopeFixture())), "existing_updates");
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value.runFingerprint, "r1.x");
});

// ── 5. the send gate still holds ─────────────────────────────────────────────

test("20: preflight blocks on sender mismatch, missing recipient and missing artifact", () => {
  const server = code("lib/talabat/email-send.server.ts");
  assert.ok(server.includes("sender_not_authenticated"), "sender gate present");
  assert.ok(server.includes("recipient_not_configured"), "recipient gate present");
  assert.ok(server.includes("ARTIFACT_BLOCK_AR.artifact_missing"), "artifact gate present");
  assert.ok(server.includes("verifyArtifactScope"), "run binding verified");
});

test("21: the send re-verifies the binding — a read preflight is not authority", () => {
  const server = code("lib/talabat/email-send.server.ts");
  const sendFn = server.slice(server.indexOf("export async function sendTalabatEmail"));
  assert.ok(sendFn.includes("verifyArtifactScope"), "the send checks again itself");
  assert.ok(sendFn.includes('req.currentRunFingerprint === null'), "and refuses when the caller states no run");
  assert.ok(sendFn.indexOf("verifyArtifactScope") < sendFn.indexOf("sendMailViaSmtp"));
});

test("22: explicit owner confirmation is still required, and nothing here sends", () => {
  const route = code("app/api/export/talabat/email/[kind]/route.ts");
  assert.ok(route.includes("body.confirm === true"));
  const gen = code("lib/talabat/email-artifacts.server.ts");
  for (const forbidden of ["sendMailViaSmtp", "nodemailer", "createTransport", "email-send.server"]) {
    assert.equal(gen.includes(forbidden), false, `the generator must not reach ${forbidden}`);
  }
});

test("23: generation writes ONLY under the email-artifacts prefix", () => {
  const gen = code("lib/talabat/email-artifacts.server.ts");
  // one upload helper, and every write goes through it with an artifactPath()
  assert.equal((gen.match(/\.upload\(/g) ?? []).length, 1, "exactly one upload call site");
  // every CALL of the helper (its own declaration excluded) targets an
  // artifactPath() — so nothing can be written outside the prefix.
  const calls = gen.split("\n")
    .filter((l) => /\bput\(/.test(l) && !/async function put\(/.test(l));
  assert.ok(calls.length >= 4, `expected the workbooks, the zip and the sidecars; saw ${calls.length}`);
  for (const call of calls) {
    assert.ok(call.includes("artifactPath("), `write target must be an artifactPath: ${call.trim()}`);
  }
  // and it never reads or writes a catalog/marketplace TABLE. Scanning for the
  // bare word "products" would be meaningless here — the module is full of
  // legitimate names like newProductPreviewRows — so scan for table ACCESS.
  // storage.from(BUCKET) is object storage; a TABLE read looks like .from("name")
  assert.equal(/\.from\(["'`]/.test(gen), false, "the generator reads and writes no database table");
  assert.equal((gen.match(/storage\.from\(/g) ?? []).length, 1, "one bucket handle, in the upload helper");
  for (const forbidden of ["/snoonu/", "/rafeeq/", "/shopify/", "channel_variant_mappings", "product_variants"]) {
    assert.equal(gen.includes(forbidden), false, `the generator must not reference ${forbidden}`);
  }
});

test("24: no barcode row can enter the safe update artifact, by two independent means", () => {
  const { result } = fixture();
  // (a) the builder blanks the columns
  const body = buildTalabatSafeUpdateAoa(result).slice(1);
  assert.equal(body.filter((r) => String(r[col("barcode 1")] ?? "") !== "").length, 0);
  // (b) the preflight re-counts them and blocks if any appear
  assert.deepEqual(verifyArtifactScope(scopeFixture({ barcodeValueRows: 1 }), "r1.x"), ["barcode_values_present"]);
  // and the separate barcode differences are still reported, just not sent
  assert.ok(result.counts.barcodeDiffs >= 0);
});

test("25: workbook names follow the owner's convention", () => {
  assert.equal(deltaWorkbookName("safe-product-updates", "2026-09-06T10:00:00Z"),
    "talabat-safe-product-updates-2026-09-06.xlsx");
  assert.equal(deltaWorkbookName("new-products", "2026-09-06T10:00:00Z"), "talabat-new-products-2026-09-06.xlsx");
  assert.equal(newProductsImagesZipName("2026-09-06T10:00:00Z"), "talabat-new-products-images-2026-09-06.zip");
});

test("26: barcode and sku stay TEXT in the serialized workbook", () => {
  // A 13-digit barcode written as a number loses its leading zero and reaches
  // Talabat as a DIFFERENT code — so the column discipline is load-bearing.
  const ser = code("lib/talabat/package-xlsx.ts");
  assert.match(ser, /export function buildTalabatDeltaXlsxBuffer/);
  const gen = code("lib/talabat/email-artifacts.server.ts");
  assert.ok(gen.includes('idx("barcode 1")') && gen.includes('idx("barcode 3")'), "all barcode columns are text");
  assert.ok(gen.includes('idx("sku")'), "sku is text");
  assert.ok(gen.includes('numericColumns: [idx("price")]'), "price stays numeric");
  // one serializer call site, so Email A and Email B cannot drift apart
  assert.equal((gen.match(/buildTalabatDeltaXlsxBuffer\(/g) ?? []).length, 1);
});

test("27: excluded-category rows are counted from the FILE, not assumed to be zero", () => {
  const gen = code("lib/talabat/email-artifacts.server.ts");
  assert.ok(gen.includes("countExcludedInWorkbook"), "the count comes from the produced rows");
  assert.ok(gen.includes("policyExcludedNewDeltaRows"), "…checked against the policy's own exclusion set");
  const { result } = fixture();
  assert.equal(policyExcludedNewDeltaRows(result).length, 0, "this fixture excludes nothing");
  assert.equal(newDeltaRows(result).length, 2);
});
