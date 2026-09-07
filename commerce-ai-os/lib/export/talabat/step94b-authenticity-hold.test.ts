// STEP 94B — withholding thirteen products from ONE channel.
//
// Three of these were first excluded by setting lifecycle_state = STOPPED, and
// that was the wrong tool: STOPPED is read by every channel, so an exclusion
// wanted only for Talabat removed the products from Shopify and Rafeeq and
// marked them outside the active catalog for Snoonu. The other candidate — the
// platform_status approval overlay — has not gated the export since STEP 62
// ("approval is NO LONGER an export gate … it never blocks"), so writing to it
// would have changed nothing while looking like it had.
//
// So the hold is a reviewed constant beside the category exclusion that has
// worked since STEP 81: same file, same shape, same one-way reach. It costs a
// deploy to change, and in exchange it cannot leak to another channel and
// cannot be altered without a diff someone reads.
//
// The proofs are in four groups: SCOPE (the hold names SKUs and catches their
// variants), REACH (one decision point, so workbook/images/preview all obey),
// ISOLATION (no other channel can even see it), and UNTOUCHED.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step94b-authenticity-hold.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TALABAT_AUTHENTICITY_HOLD, TALABAT_AUTHENTICITY_HOLD_REASON, isTalabatAuthenticityHeld,
  TALABAT_EXCLUDED_CATEGORIES, classifyTalabatNewRow, allowedNewDeltaRows,
  policyExcludedNewDeltaRows, authenticityHeldNewDeltaRows,
} from "./category-policy.ts";
import { parseTalabatBaseline, compareTalabatBaseline, newDeltaRows, TALABAT_BASELINE_COLUMNS } from "./baseline-delta.ts";
import { newProductImageScope, newProductPreviewRows, buildTalabatNewProductsAoa, safeUpdateRows } from "./delta-workbooks.ts";
import { deltaImageSelectionKeys, deltaImagePlannedCount } from "./delta-image-package.ts";
import { buildTalabatPreview, type TalabatPreviewProduct } from "./preview.ts";
import { previewRowKey } from "./package.ts";
import { OFFICIAL_SEND_ENABLED } from "./email-workflow.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const POLICY = "lib/export/talabat/category-policy.ts";

const HELD = "mk1999";          // a held product, restored to DRAFT
const HELD2 = "mk922";          // a held product, ACTIVE
const FREE = "mk1112";          // REVIEW_ONLY — deliberately not held
const FREE2 = "mk2251";

function product(sku: string, category: string, over: Partial<TalabatPreviewProduct> = {}): TalabatPreviewProduct {
  return {
    id: `id-${sku}`, sku, barcode: `29${sku.replace(/\D/g, "").padStart(11, "0")}`,
    nameEn: `EN ${sku}`, nameAr: `ع ${sku}`, price: 350, discountPrice: null, channelPrice: null,
    category, descriptionEn: "d", descriptionAr: "و",
    imageUrl: `https://x.test/${sku}.jpg`, imageFilename: `${sku}.jpg`,
    galleryImageUrls: [], imageCount: 1, approved: true, lifecycleState: "ACTIVE", variants: [],
    ...over,
  };
}

/** A delta whose NEW rows span: held, held-with-variants, free, and excluded-category. */
function fixture() {
  const products = [
    product(HELD, "Women’s Essentials"),
    product(HELD2, "Women’s Essentials"),
    product(FREE, "Women’s Essentials"),
    product(FREE2, "Women’s Essentials"),
    product("mk2000", "Women’s Essentials", {
      variants: [
        { id: "v1", sku: "mk2000-1-gold", barcode: "8416686640498-1", nameEn: null, nameAr: "Gold", price: 350 },
        { id: "v2", sku: "mk2000-2-silver", barcode: "8416686640498-2", nameEn: null, nameAr: "Silver", price: 350 },
      ] as TalabatPreviewProduct["variants"],
    }),
    product("mk5000", "Electronics"),
    product("mk5001", "Face Care", { galleryImageUrls: ["https://x.test/g1.jpg"], imageCount: 2 }),
  ];
  const preview = buildTalabatPreview({ products });
  // an empty baseline ⇒ every certified row is NEW
  const baseline = parseTalabatBaseline([TALABAT_BASELINE_COLUMNS.slice()], "Products").rows;
  return { preview, result: compareTalabatBaseline(preview.rows, baseline) };
}

// ── 1. the hold is SKU-specific ─────────────────────────────────────────────

test("1. the hold names exactly the thirteen approved SKUs", () => {
  assert.equal(TALABAT_AUTHENTICITY_HOLD.length, 13);
  for (const sku of ["mk1127", "mk1128", "mk1111", "mk1129", "mk922", "mk923", "mk2321", "mk924",
    "mk2088", "mk2086", "mk1999", "mk2000", "mk2001"]) {
    assert.ok(TALABAT_AUTHENTICITY_HOLD.includes(sku), `${sku} is held`);
  }
  assert.equal(new Set(TALABAT_AUTHENTICITY_HOLD).size, 13, "no duplicates");
  assert.equal(TALABAT_AUTHENTICITY_HOLD_REASON, "authenticity_review");
});

test("2. it holds by SKU, not by category or brand", () => {
  assert.equal(isTalabatAuthenticityHeld(HELD), true);
  assert.equal(isTalabatAuthenticityHeld(FREE), false, "a review-only SKU is not held");
  assert.equal(isTalabatAuthenticityHeld("mk9999"), false);
  assert.equal(isTalabatAuthenticityHeld(null), false);
  assert.equal(isTalabatAuthenticityHeld(""), false);
  assert.equal(isTalabatAuthenticityHeld("  "), false);
  // case and padding must not decide a hold
  assert.equal(isTalabatAuthenticityHeld(" MK1999 "), true);
  // Women's Essentials as a whole is NOT excluded — only these SKUs
  assert.equal(TALABAT_EXCLUDED_CATEGORIES.includes("Women’s Essentials"), false);
});

test("3. a held product's VARIANT rows are held too", () => {
  const { result } = fixture();
  const rows = newDeltaRows(result).filter((r) => r.our.sku.startsWith("mk2000"));
  assert.equal(rows.length, 2, "the fixture's held product has two variant rows");
  for (const r of rows) {
    assert.equal(classifyTalabatNewRow(r), "EXCLUDED_BY_TALABAT_AUTHENTICITY_HOLD",
      `${r.our.sku} is held through its parent`);
  }
});

// ── 2. one decision point, so every layer obeys ─────────────────────────────

test("4. a held SKU cannot enter the Email B workbook", () => {
  const { result } = fixture();
  const allowed = allowedNewDeltaRows(result).map((r) => r.our.sku);
  for (const sku of [HELD, HELD2, "mk2000-1-gold", "mk2000-2-silver"]) {
    assert.equal(allowed.includes(sku), false, `${sku} must not be an allowed row`);
  }
  // and it is absent from the emitted sheet body, not merely from the row list
  const body = buildTalabatNewProductsAoa(result).slice(1).map((r) => String(r[0]));
  for (const sku of [HELD, HELD2, "mk2000-1-gold"]) {
    assert.equal(body.includes(sku), false, `${sku} must not reach the workbook`);
  }
  assert.ok(body.includes(FREE), "a free SKU still ships");
});

test("5. a held SKU's images cannot enter the image package", () => {
  const { result } = fixture();
  const keys = new Set(deltaImageSelectionKeys(result));
  const heldRows = newDeltaRows(result).filter(
    (r) => classifyTalabatNewRow(r) === "EXCLUDED_BY_TALABAT_AUTHENTICITY_HOLD");
  assert.ok(heldRows.length > 0);
  for (const r of heldRows) {
    assert.equal(keys.has(previewRowKey(r.our)), false, `${r.our.sku} contributes no image`);
  }
  // the planned image count counts only allowed rows
  assert.equal(deltaImagePlannedCount(result),
    allowedNewDeltaRows(result).reduce((n, r) => n + 1 + (r.our.galleryImageUrls?.length ?? 0), 0));
});

test("6. a held SKU cannot enter the preview/send scope", () => {
  const { result } = fixture();
  const previewSkus = newProductPreviewRows(result).map((r) => r.sku);
  for (const sku of [HELD, HELD2, "mk2000-1-gold"]) {
    assert.equal(previewSkus.includes(sku), false, `${sku} is out of the preview scope`);
  }
  // …and out of the image scope the preview reports
  const scope = newProductImageScope(result);
  for (const sku of [HELD, HELD2]) assert.equal(scope.skus.includes(sku), false);
});

test("7. there is exactly ONE place the hold is applied", () => {
  const src = code(POLICY);
  // classifyTalabatNewRow is the only consumer of the predicate
  const uses = (src.match(/isTalabatAuthenticityHeld\(/g) ?? []).length;
  assert.equal(uses, 3, "the definition plus the two calls inside classifyTalabatNewRow");
  // no other module re-implements the list
  for (const f of [
    "lib/export/talabat/delta-workbooks.ts",
    "lib/export/talabat/delta-image-package.ts",
    "lib/talabat/email-workflow.server.ts",
    "lib/talabat/email-artifacts.server.ts",
  ]) {
    assert.equal(code(f).includes("TALABAT_AUTHENTICITY_HOLD"), false,
      `${f} must not carry a second copy of the hold list`);
    assert.equal(code(f).includes("mk1999"), false, `${f} must not name a held SKU`);
  }
});

test("8. the held rows are reported, never silently dropped", () => {
  const { result } = fixture();
  const held = authenticityHeldNewDeltaRows(result).map((r) => r.our.sku);
  assert.ok(held.includes(HELD) && held.includes(HELD2));
  // and they appear in the combined policy-excluded report too
  const excluded = policyExcludedNewDeltaRows(result).map((r) => r.our.sku);
  assert.ok(excluded.includes(HELD), "held rows are part of the withheld report");
  assert.ok(excluded.includes("mk5000"), "…alongside the category exclusions");
});

// ── 3. no other channel can see it ──────────────────────────────────────────

test("9. Snoonu never imports the Talabat hold", () => {
  assertChannelIsolated("lib/snoonu");
});

test("10. Shopify never imports the Talabat hold", () => {
  assertChannelIsolated("lib/export/shopify");
});

test("11. Rafeeq never imports the Talabat hold", () => {
  assertChannelIsolated("lib/export/rafeeq");
  assertChannelIsolated("lib/rafeeq");
});

test("12. the hold module reaches no channel, no database and no transport", () => {
  const src = code(POLICY);
  for (const forbidden of [
    "snoonu", "shopify", "rafeeq", "supabase", "createAdminClient",
    "sendMailViaSmtp", "nodemailer", ".insert(", ".update(", ".upsert(", ".delete(", ".from(",
  ]) {
    assert.equal(src.toLowerCase().includes(forbidden.toLowerCase()), false,
      `the policy module must not reference ${forbidden}`);
  }
  // it is PURE: no server-only import, no I/O
  assert.equal(src.includes("server-only"), false);
});

test("13. the hold replaces a global lifecycle rule, and does not become one", () => {
  const src = code(POLICY);
  // it must not decide anything from lifecycle_state
  assert.equal(src.includes("STOPPED"), false, "no lifecycle state is consulted here");
  assert.equal(src.includes("lifecycleState"), false);
  assert.equal(src.includes("lifecycle_state"), false);
});

// ── 4. untouched ────────────────────────────────────────────────────────────

test("14. DRAFT is not treated as globally stopped", () => {
  // Only STOPPED blocks a row; a DRAFT product remains exportable, which is
  // exactly why the three restored products need the hold to stay out.
  const talabat = code("lib/export/talabat/preview.ts");
  assert.match(talabat, /if \(state === "STOPPED"\) block\("LIFECYCLE_NOT_ELIGIBLE"/);
  assert.equal(/state === "DRAFT"\s*\)\s*block/.test(talabat), false, "DRAFT never blocks");
});

test("15. review-only SKUs are untouched and still ship", () => {
  const { result } = fixture();
  const allowed = allowedNewDeltaRows(result).map((r) => r.our.sku);
  for (const sku of [FREE, FREE2]) {
    assert.ok(allowed.includes(sku), `${sku} stays in scope`);
    assert.equal(isTalabatAuthenticityHeld(sku), false);
  }
  for (const sku of ["mk1112", "mk1126", "mk2251"]) {
    assert.equal(TALABAT_AUTHENTICITY_HOLD.includes(sku), false, `${sku} is REVIEW_ONLY, not held`);
  }
});

test("16. the earlier exclusions still hold", () => {
  const { result } = fixture();
  const allowed = allowedNewDeltaRows(result).map((r) => r.our.sku);
  assert.equal(allowed.includes("mk5000"), false, "Electronics still excluded");
  assert.deepEqual([...TALABAT_EXCLUDED_CATEGORIES], ["Electronics", "✨Toys"]);
  // update rows remain a separate population from new-product rows
  const updateSkus = new Set(safeUpdateRows(result).map((r) => r.our.sku));
  for (const sku of allowed) assert.equal(updateSkus.has(sku), false);
});

test("17. the screen reports the recomputed scope without generating anything", () => {
  // So a channel-policy change can be SEEN before any artifact is built.
  const wf = code("lib/talabat/email-workflow.server.ts");
  assert.match(wf, /const allowedRows = allowedNewDeltaRows\(delta\.result\);/);
  assert.match(wf, /scopeProducts,\n\s*scopeRows,/);
  const status = wf.slice(wf.indexOf("export async function deltaImagePackageStatus"));
  const body = status.slice(0, status.indexOf("\nexport "));
  for (const forbidden of ["generateNewProductsArtifact", "streamPartsToObject", "startTalabatDeltaImageJob"]) {
    assert.equal(body.includes(forbidden), false, `reading the status must not ${forbidden}`);
  }
  assert.match(code("app/(v2)/v2/operations/channels/talabat-email/ImagePackage.tsx"), /status\.scopeProducts/);
});

test("18. nothing here sends mail or enables the official send", () => {
  assert.equal(OFFICIAL_SEND_ENABLED, false);
  assert.equal(code(POLICY).includes("sendMail"), false);
});

/** No file under a channel's tree may import or name the Talabat hold. */
function assertChannelIsolated(dir: string) {
  let out = "";
  try {
    out = execFileSync("grep", ["-rl", "-e", "TALABAT_AUTHENTICITY_HOLD", "-e", "isTalabatAuthenticityHeld",
      join(APP_ROOT, dir)], { encoding: "utf8" });
  } catch {
    out = ""; // grep exits 1 when nothing matches — that is the passing case
  }
  assert.equal(out.trim(), "", `${dir} must not reference the Talabat authenticity hold`);
}
