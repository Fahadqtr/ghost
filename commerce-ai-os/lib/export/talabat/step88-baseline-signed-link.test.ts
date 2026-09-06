// STEP 88 — the uploaded baseline, and images by signed link instead of a
// 332 MB attachment.
//
// The two ideas under test:
//
//   1. EVERY NUMBER IS A CLAIM ABOUT A FILE. 147 and 408 are results, not
//      constants — they must be recomputed from whatever the owner uploaded,
//      and an artifact must be traceable to the exact export it came from. A
//      different baseline invalidates it even when the counts happen to match.
//
//   2. THE IMAGES ARE NOT AN ATTACHMENT. The body says where they are, the
//      attachment list does not claim them, the size gate measures only what is
//      really attached, and the send attaches exactly what the preview showed.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step88-baseline-signed-link.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateBaselineWorkbook, baselineFingerprint, baselineObjectPath, parseActiveBaselineMeta,
  BASELINE_SHEET_NAME, BASELINE_ACCEPT, BASELINE_MAX_BYTES, BASELINE_REJECTION_AR,
  ACTIVE_BASELINE_POINTER, BASELINE_PREFIX,
} from "./baseline-upload.ts";
import { TALABAT_BASELINE_COLUMNS } from "./baseline-delta.ts";
import { verifyArtifactScope, type TalabatArtifactScope } from "./email-artifacts.ts";
import { buildTalabatNewProductsEmail, buildTalabatUpdateEmail } from "./email-templates.ts";
import { attachmentSizeReport } from "./email-workflow.ts";
import { RAFEEQ_LINK_TTL_SECONDS } from "../rafeeq/artifact-object.ts";
import { EMAIL_ATTACHMENT_MAX_BYTES_DEFAULT } from "../../mail/config.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVER = "lib/talabat/email-workflow.server.ts";
const UPLOAD_API = "app/api/export/talabat/email/baseline/route.ts";
const UPLOAD_UI = "app/(v2)/v2/operations/channels/talabat-email/BaselineUpload.tsx";
const PAGE = "app/(v2)/v2/operations/channels/talabat-email/page.tsx";

const HEADERS = TALABAT_BASELINE_COLUMNS.slice();
const row = (sku: string) => [sku, "n", "1", true, null, false, null, null, null, "0123456789012", null, null, "All Face Care"];
const ok = (over: Partial<Parameters<typeof validateBaselineWorkbook>[0]> = {}) => validateBaselineWorkbook({
  filename: "products.xlsx", byteLength: 5000,
  aoa: [HEADERS, row("mk1"), row("mk2")], sheetNames: [BASELINE_SHEET_NAME], ...over,
});

// ── 1. the migration ─────────────────────────────────────────────────────────

test("1: the applied migration is additive and rollback-safe", () => {
  const up = raw("supabase/migrations/20260907000000_talabat_email_delivery_mode.sql");
  assert.match(up, /add column if not exists delivery_mode/);
  assert.match(up, /not null default 'official'/);
  assert.match(up, /check \(delivery_mode in \('official', 'test'\)\)/);
  for (const forbidden of ["drop table", "delete from", "update public.", "alter column", "drop column"]) {
    assert.equal(up.toLowerCase().includes(forbidden), false, `must not ${forbidden}`);
  }
  const down = raw("supabase/migrations/20260907000001_talabat_email_delivery_mode_down.sql");
  assert.match(down, /drop column if exists delivery_mode/);
  assert.equal(down.toLowerCase().includes("drop table"), false, "the down must not take the table with it");
});

// ── 2. baseline validation ───────────────────────────────────────────────────

test("2: a well-formed export is accepted and described", () => {
  const v = ok();
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.sheetName, BASELINE_SHEET_NAME);
  assert.equal(v.rowCount, 2);
  assert.deepEqual(v.matchedColumns, HEADERS);
  assert.deepEqual(v.extraColumns, []);
  assert.deepEqual(v.detectedHeaders, HEADERS);
});

test("3: a corrupt, empty, oversize or non-xlsx file is refused", () => {
  for (const [reason, input] of [
    ["unreadable_workbook", { aoa: null }],
    ["empty_file", { byteLength: 0 }],
    ["too_large", { byteLength: BASELINE_MAX_BYTES + 1 }],
    ["not_xlsx", { filename: "products.csv" }],
    ["sheet_missing", { sheetNames: ["Sheet1"] }],
    ["no_rows", { aoa: [HEADERS] }],
  ] as const) {
    const v = ok(input);
    assert.equal(v.ok, false, `${reason} must be refused`);
    if (!v.ok) assert.equal(v.reason, reason);
  }
  assert.equal(BASELINE_ACCEPT, ".xlsx");
  for (const r of Object.values(BASELINE_REJECTION_AR)) assert.ok(r.length > 0);
});

test("4: missing required columns are refused and NAMED", () => {
  const short = HEADERS.filter((h) => h !== "barcode 1" && h !== "category 1");
  const v = ok({ aoa: [short, short.map(() => "x")] });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.reason, "headers_missing");
    assert.deepEqual(v.missingColumns, ["barcode 1", "category 1"]);
  }
});

test("5: an EXTRA column is accepted — Talabat may add fields", () => {
  const wide = [...HEADERS, "someNewTalabatField"];
  const v = ok({ aoa: [wide, [...row("mk1"), "x"]] });
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.extraColumns, ["someNewTalabatField"]);
});

test("6: the row count is REPORTED, never compared to an expected number", () => {
  const many = [HEADERS, ...Array.from({ length: 993 }, (_, i) => row(`mk${i}`))];
  const v = ok({ aoa: many });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.rowCount, 993, "any count is valid — Talabat's catalog changes");
  // no expected count is hard-coded anywhere in the validator
  const src = code("lib/export/talabat/baseline-upload.ts");
  for (const n of ["992", "147", "408", "517", "632"]) {
    assert.equal(src.includes(n), false, `${n} must not appear as a constant`);
  }
});

// ── 3. fingerprint + versioning ──────────────────────────────────────────────

test("7: the fingerprint is content-based, so identical files stay valid", () => {
  const a = baselineFingerprint(new Uint8Array([1, 2, 3]));
  const b = baselineFingerprint(new Uint8Array([1, 2, 3]));
  const c = baselineFingerprint(new Uint8Array([1, 2, 4]));
  assert.equal(a, b, "re-uploading the same export must not invalidate artifacts");
  assert.notEqual(a, c);
  assert.match(a, /^b1\.[0-9a-f]{32}$/);
});

test("8: storage is VERSIONED, not overwritten", () => {
  assert.equal(baselineObjectPath("b1.aaa"), `${BASELINE_PREFIX}/b1.aaa/products.xlsx`);
  assert.notEqual(baselineObjectPath("b1.aaa"), baselineObjectPath("b1.bbb"));
  assert.equal(ACTIVE_BASELINE_POINTER, `${BASELINE_PREFIX}/active.json`);
  // the server writes to the versioned path and points at it separately
  const server = code(SERVER);
  assert.ok(server.includes("baselineObjectPath(fingerprint)"));
  assert.ok(server.includes("ACTIVE_BASELINE_POINTER"));
});

test("9: a corrupt pointer reads as 'no baseline', never as a partial one", () => {
  assert.equal(parseActiveBaselineMeta(null), null);
  assert.equal(parseActiveBaselineMeta({}), null);
  assert.equal(parseActiveBaselineMeta({ filename: "a.xlsx" }), null);
  const good = parseActiveBaselineMeta({
    filename: "products.xlsx", byteLength: 10, rowCount: 992, fingerprint: "b1.x",
    uploadedAtIso: "t", uploadedBy: "o", objectPath: "p", detectedHeaders: ["sku"],
  });
  assert.ok(good);
  assert.equal(good!.fingerprint, "b1.x");
});

test("10: a NEW baseline invalidates artifacts built from the old one", () => {
  const scope: TalabatArtifactScope = {
    kind: "existing_updates", runFingerprint: "r1.x", baselineFingerprint: "b1.old",
    generatedAtIso: "t", files: [{ filename: "a.xlsx", bytes: 1, contentType: "x", crc32: 1 }],
    workbookRows: 147, workbookProducts: 147, imageCount: null,
    rowsMissingImage: 0, excludedCategoryRows: 0,
    barcodeValueRows: 0, activeValueRows: 0, categoryValueRows: 0, extensionAudit: null,
  };
  assert.deepEqual(verifyArtifactScope(scope, "r1.x", "b1.old"), [], "same baseline, still valid");
  assert.deepEqual(verifyArtifactScope(scope, "r1.x", "b1.new"), ["baseline_changed"],
    "a different export invalidates it even though the counts are unchanged");
  // and the run fingerprint still works on its own for older callers
  assert.deepEqual(verifyArtifactScope(scope, "r1.y"), ["artifact_stale"]);
});

// ── 4. counts are recomputed, not stored ─────────────────────────────────────

test("11: Email A and Email B counts are derived from the uploaded baseline", () => {
  const server = code(SERVER);
  assert.ok(server.includes("loadCurrentTalabatDelta"), "generation rebuilds the delta");
  assert.ok(server.includes("compareTalabatBaseline"), "…against the uploaded file");
  // STEP 88C renamed the reader when it was fixed to follow the active pointer
  assert.ok(server.includes("readActiveBaselineBytes"), "…read from storage via the active pointer, not assumed");
  for (const n of ["147", "408", "517", "632"]) {
    assert.equal(server.includes(n), false, `${n} must not be a constant in the generation path`);
  }
});

test("12: the policy exclusions still apply to whatever the baseline says", () => {
  const server = code(SERVER);
  assert.ok(server.includes("allowedNewDeltaRows"), "Electronics/Toys exclusion is applied to the new rows");
  const policy = code("lib/export/talabat/category-policy.ts");
  assert.match(policy, /TALABAT_EXCLUDED_CATEGORIES: readonly string\[\] = \["Electronics", "✨Toys"\]/);
  // barcode rows never enter a sendable artifact
  const wb = code("lib/export/talabat/delta-workbooks.ts");
  assert.match(wb, /SAFE_UPDATE_FIELDS = \["NAME_DIFF", "PRICE_DIFF"\]/);
});

// ── 5. signed-link delivery ──────────────────────────────────────────────────

test("13: Email B lists the workbook as its ONLY attachment when a link exists", () => {
  const linked = buildTalabatNewProductsEmail("nw.xlsx", "images.zip", {
    sendable: false, imagesLink: { url: "https://private.test/signed", expiresAtIso: "2026-09-13T00:00:00.000Z" },
  });
  assert.deepEqual(linked.attachments, ["nw.xlsx"], "the 332 MB ZIP is NOT attached");
  assert.equal(linked.attachments.includes("images.zip"), false);
  // without a link the old behaviour stands, so nothing silently loses the images
  const unlinked = buildTalabatNewProductsEmail("nw.xlsx", "images.zip", { sendable: false });
  assert.deepEqual(unlinked.attachments, ["nw.xlsx", "images.zip"]);
});

test("14: the body says where the images are, and when the link dies", () => {
  const email = buildTalabatNewProductsEmail("nw.xlsx", "images.zip", {
    sendable: false, imagesLink: { url: "https://private.test/signed-abc", expiresAtIso: "2026-09-13T00:00:00.000Z" },
  });
  assert.ok(email.bodyText.includes("https://private.test/signed-abc"), "the link is in the body");
  assert.ok(email.bodyText.includes("secure download link"));
  assert.ok(email.bodyText.includes("2026-09-13T00:00:00.000Z"), "the expiry is stated");
  assert.ok(email.bodyText.includes("The product images are linked below."));
  // and it no longer claims the images are attached
  assert.equal(email.bodyText.includes("together with the required product images"), false);
});

test("15: the link reuses the Rafeeq policy — private, time-limited, on demand", () => {
  assert.equal(RAFEEQ_LINK_TTL_SECONDS, 7 * 24 * 3600);
  const server = code(SERVER);
  assert.ok(server.includes("TALABAT_LINK_TTL_SECONDS = RAFEEQ_LINK_TTL_SECONDS"), "one expiry policy, not two");
  assert.ok(server.includes("createSignedUrl("), "a signed URL, not a public object");
  // nothing makes a bucket public, and no URL is persisted
  for (const forbidden of ["getPublicUrl", "public: true", "updateBucket", "createBucket"]) {
    assert.equal(server.includes(forbidden), false, `must not ${forbidden}`);
  }
  // the URL is MINTED on demand and returned — it must never reach a stored row
  const insert = server.slice(server.indexOf(".insert({"), server.indexOf("auditRecorded = !error"));
  for (const leak of ["signedUrl", "imagesLink", "url:", ".url"]) {
    assert.equal(insert.includes(leak), false, `the delivery row must not persist ${leak}`);
  }
  assert.ok(server.includes("expiresAtIso: new Date(Date.now() + TALABAT_LINK_TTL_SECONDS"),
    "expiry is computed from the TTL at mint time, not stored and reused");
});

test("16: the link is minted for the CURRENT run's object", () => {
  const server = code(SERVER);
  assert.ok(server.includes('artifactPath("new_products", zipFilename)'),
    "the path comes from the artifact this run produced");
  // a run whose artifacts are stale is refused before any link is used
  assert.ok(server.includes("verifyArtifactScope"));
  assert.ok(server.includes("activeBaseline?.fingerprint"), "…including the baseline binding");
});

test("17: the size gate measures only what is really attached", () => {
  // with the ZIP linked, Email B's payload is just the workbook — and fits
  const withLink = attachmentSizeReport([{ filename: "nw.xlsx", bytes: 301_871 }], 1200, EMAIL_ATTACHMENT_MAX_BYTES_DEFAULT);
  assert.equal(withLink.withinLimit, true, "the workbook alone is well inside the cap");
  // attaching the ZIP would not fit, which is why it is linked
  const withZip = attachmentSizeReport(
    [{ filename: "nw.xlsx", bytes: 301_871 }, { filename: "images.zip", bytes: 347_537_469 }], 1200,
    EMAIL_ATTACHMENT_MAX_BYTES_DEFAULT);
  assert.equal(withZip.withinLimit, false);
  // the preview measures the DRAFT's attachment list, so the two agree
  const server = code(SERVER);
  assert.ok(server.includes("draft.attachments.includes(a.filename)"));
});

test("18: the send attaches exactly what the preview listed", () => {
  const server = code(SERVER);
  const send = server.slice(server.indexOf("export async function sendTalabatTestEmail"));
  assert.ok(send.includes("p.attachments.some((x) => x.filename === a.filename)"),
    "the transport gets the preview's list, not the whole bundle");
  assert.ok(send.includes("attachment_filenames: p.attachments.map"),
    "and the log records what was actually attached");
});

// ── 6. upload surface ────────────────────────────────────────────────────────

test("19: the upload route is owner-only and validates BEFORE storing", () => {
  const route = code(UPLOAD_API);
  const methods = (route.match(/export async function (GET|POST)/g) ?? []).length;
  assert.equal((route.match(/await requireOwner\(\)/g) ?? []).length, methods);
  const server = code(SERVER);
  const upload = server.slice(server.indexOf("export async function uploadTalabatBaseline"));
  assert.ok(upload.indexOf("validateBaselineWorkbook") < upload.indexOf("putObject("),
    "an invalid workbook must never reach storage");
  assert.ok(route.includes("BASELINE_MAX_BYTES"), "an oversize body is refused before it is read");
});

test("20: the upload UI is V2-only and shows what was accepted", () => {
  const ui = raw(UPLOAD_UI);
  assert.ok(ui.includes('"use client"'));
  assert.ok(ui.includes('accept=".xlsx"'));
  for (const shown of ["رفع آخر ملف طلبات", "بصمة الملف", "الأعمدة المكتشفة", "الصفوف", "تاريخ الرفع"]) {
    assert.ok(ui.includes(shown), `the card must show ${shown}`);
  }
  assert.ok(ui.includes("لم تعد صالحة للإرسال"), "a changed baseline warns that artifacts are stale");
  // legacy gained nothing
  const legacy = code("app/(app)/settings/email/page.tsx");
  for (const f of ["baseline", "signImagesLink", "talabat-email"]) {
    assert.equal(legacy.includes(f), false, `legacy must not gain ${f}`);
  }
});

test("21: the page surfaces the active baseline and the link-delivery policy", () => {
  const page = raw(PAGE);
  assert.ok(page.includes("ملف طلبات المرجعي"));
  assert.ok(page.includes("غير مرفوع — التوليد متوقف"));
  assert.ok(page.includes("برابط تنزيل موقّع"), "the images policy is stated up front");
  assert.ok(code(PAGE).includes("readActiveBaseline"));
});

// ── 7. unchanged guarantees ──────────────────────────────────────────────────

test("22: official send is still off and the recipient is still manual", () => {
  const pure = code("lib/export/talabat/email-workflow.ts");
  assert.match(pure, /export const OFFICIAL_SEND_ENABLED = false/);
  const server = code(SERVER);
  assert.ok(server.includes("resolveSendRecipients"), "the recipient is still resolved per send");
  for (const rel of [SERVER, UPLOAD_API, UPLOAD_UI, PAGE, "lib/export/talabat/baseline-upload.ts"]) {
    assert.equal(raw(rel).includes("july.real"), false, `${rel} must not hard-code the recipient`);
  }
});

test("23: a test delivery is recorded as a test, and Email A is unchanged", () => {
  const server = code(SERVER);
  assert.ok(server.includes('delivery_mode: "test"'));
  const a = buildTalabatUpdateEmail("talabat-safe-product-updates-2026-09-07.xlsx");
  assert.equal(a.subject, "Malika's Universe — Talabat Product Data Update");
  assert.deepEqual(a.attachments, ["talabat-safe-product-updates-2026-09-07.xlsx"]);
  assert.equal(a.bodyText.includes("download link"), false, "Email A gains no link language");
});

test("24: nothing added here can write to the catalog or a marketplace", () => {
  const server = code(SERVER);
  assert.equal((server.match(/\.insert\(/g) ?? []).length, 1, "one insert, the delivery log");
  assert.ok(server.includes('from("talabat_email_deliveries")'));
  for (const forbidden of ['from("products")', 'from("product_variants")', "snoonu", "shopify"]) {
    assert.equal(server.includes(forbidden), false, `must not touch ${forbidden}`);
  }
  const pure = code("lib/export/talabat/baseline-upload.ts");
  for (const forbidden of ["supabase", "fetch(", "createAdminClient", "nodemailer"]) {
    assert.equal(pure.includes(forbidden), false, `the validator must stay pure (${forbidden})`);
  }
});
