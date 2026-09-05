// STEP 79 — baseline delta, delta workbooks, sender identities, partner emails.
//
// The fixtures mirror the REAL uploaded baseline (992 rows, sheet "Products"):
// zero-padded 14-char barcodes, an "All " category prefix, string prices, and
// simple SKUs only. Those four shapes are what make a naive comparison report
// "everything changed", so each has a test that would fail if the normalisation
// were dropped — and a paired test proving a GENUINE difference still reports.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step79-baseline-delta.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseTalabatBaseline, compareTalabatBaseline, updateDeltaRows, newDeltaRows, ambiguousDeltaRows,
  normalizeBarcodeForCompare, normalizeBaselineCategory, normalizePriceForCompare,
  TALABAT_BASELINE_COLUMNS, TALABAT_UNOWNED_COLUMNS,
} from "./baseline-delta.ts";
import {
  buildUpdateAuditAoa, buildTalabatUpdateAoa, buildTalabatNewProductsAoa, buildAmbiguousAoa,
  newProductImageScope, deltaWorkbookName, newProductsImagesZipName, hasValidEanCheckDigit, barcodeEvidence,
} from "./delta-workbooks.ts";
import {
  DEFAULT_SENDER_IDENTITY, DEFAULT_SENDER_BY_CHANNEL, resolveSenderIdentities, chooseSender,
  validateSenderIdentity, senderHeaders, type SenderIdentity,
} from "../../mail/sender-identity.ts";
import { buildTalabatEmailPair, TALABAT_EMAIL_SUBJECTS } from "./email-templates.ts";
import type { MailConfig } from "../../mail/config.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
/** Source with comments stripped — these guards are about CODE, not prose. */
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── fixtures ─────────────────────────────────────────────────────────────────

type Row = Parameters<typeof compareTalabatBaseline>[0][number];
function ourRow(over: Partial<Row> & { sku: string }): Row {
  return {
    sku: over.sku,
    title: over.title ?? `Name ${over.sku}`,
    titleAr: over.titleAr ?? "اسم",
    talabatBarcode: over.talabatBarcode ?? "8860504651481",
    talabatCategory: over.talabatCategory ?? "Face Care",
    price: over.price ?? 79,
    isVariant: over.isVariant ?? false,
    internalProductId: over.internalProductId ?? `p-${over.sku}`,
    variantId: over.variantId ?? null,
    primaryImageUrl: over.primaryImageUrl ?? "https://x.test/a.jpg",
  } as Row;
}
/** An aoa shaped exactly like the real sheet. */
function sheet(rows: readonly (readonly unknown[])[]): (readonly unknown[])[] {
  return [TALABAT_BASELINE_COLUMNS.slice(), ...rows];
}
/** A baseline row in the real shape: padded barcode, "All " category, string price. */
function baseRow(sku: string, over: Partial<{ name: string; price: string; active: boolean; b1: string | null; b2: string | null; b3: string | null; cat: string }> = {}) {
  return [
    sku, over.name ?? `Name ${sku}`, over.price ?? "79", over.active ?? true,
    null, false, null, null, null,
    over.b1 === undefined ? "08860504651481" : over.b1, over.b2 ?? null, over.b3 ?? null,
    over.cat ?? "All Face Care",
  ];
}
const parse = (rows: readonly (readonly unknown[])[]) => parseTalabatBaseline(sheet(rows), "Products").rows;

// ── 1: the real workbook shape ───────────────────────────────────────────────

test("1: parses the real baseline shape; unknown/missing headers are surfaced", () => {
  const p = parseTalabatBaseline(sheet([baseRow("mk1"), baseRow("mk2")]), "Products");
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.unexpectedHeaders, []);
  assert.deepEqual(p.missingHeaders, []);
  assert.equal(p.rows[0].sheetRow, 2, "1-based row number for owner traceability");
  // a renamed column is reported, never silently ignored
  const renamed = parseTalabatBaseline([["sku", "name", "price", "active", "barcode A"], ["mk1", "n", "1", true, "1"]], "Products");
  assert.ok(renamed.missingHeaders.includes("barcode 1"));
  assert.ok(renamed.unexpectedHeaders.includes("barcode A"));
  // rows without a SKU are not products
  const noSku = parseTalabatBaseline(sheet([[null, "x", "1", true, null, false, null, null, null, "1", null, null, "All Face Care"]]), "Products");
  assert.equal(noSku.rows.length, 0);
});

// ── 2: the four normalisations, each paired with a genuine-difference test ──

test("2a: a zero-padded Talabat barcode is NOT a difference; a different one is", () => {
  const same = compareTalabatBaseline([ourRow({ sku: "mk1" })], parse([baseRow("mk1", { b1: "08860504651481" })]));
  assert.equal(same.counts.barcodeDiffs, 0, "0-padding is padding, not identity");
  const diff = compareTalabatBaseline([ourRow({ sku: "mk1" })], parse([baseRow("mk1", { b1: "04314219405784" })]));
  assert.equal(diff.counts.barcodeDiffs, 1, "genuinely different digits still report");
  assert.equal(normalizeBarcodeForCompare("08860504651481"), "8860504651481");
  assert.equal(normalizeBarcodeForCompare("abc"), null);
  assert.equal(normalizeBarcodeForCompare(""), null);
});

test("2b: the 'All ' category prefix is NOT a difference; a real recategorisation is", () => {
  const same = compareTalabatBaseline([ourRow({ sku: "mk1", talabatCategory: "Face Care" })], parse([baseRow("mk1", { cat: "All Face Care" })]));
  assert.equal(same.counts.categoryDiffs, 0);
  const diff = compareTalabatBaseline([ourRow({ sku: "mk1", talabatCategory: "Makeup" })], parse([baseRow("mk1", { cat: "All Face Care" })]));
  assert.equal(diff.counts.categoryDiffs, 1);
  assert.equal(normalizeBaselineCategory("All Women’s Essentials"), "Women’s Essentials");
  assert.equal(normalizeBaselineCategory("Face Care"), "Face Care", "an unprefixed value is left alone");
});

test("2c: a string price equal in value is NOT a difference; a real change is", () => {
  const same = compareTalabatBaseline([ourRow({ sku: "mk1", price: 79 })], parse([baseRow("mk1", { price: "79" })]));
  assert.equal(same.counts.priceDiffs, 0);
  const diff = compareTalabatBaseline([ourRow({ sku: "mk1", price: 89 })], parse([baseRow("mk1", { price: "78" })]));
  assert.equal(diff.counts.priceDiffs, 1);
  assert.equal(normalizePriceForCompare("79"), 79);
  assert.equal(normalizePriceForCompare("abc"), null);
});

test("2d: dash/case/whitespace in a name is NOT a difference; a real rename is", () => {
  const same = compareTalabatBaseline(
    [ourRow({ sku: "mk1", title: "Serum - 30Ml" })],
    parse([baseRow("mk1", { name: "Serum – 30ml" })]));
  assert.equal(same.counts.nameDiffs, 0, "en-dash vs hyphen is not a rename");
  const diff = compareTalabatBaseline(
    [ourRow({ sku: "mk1", title: "Celimax Retinal Shot (15ml)" })],
    parse([baseRow("mk1", { name: "Celimax Retinal Shot (30ml)" })]));
  assert.equal(diff.counts.nameDiffs, 1);
});

// ── 3: identity ──────────────────────────────────────────────────────────────

test("3: exact SKU matches; a barcode/SKU conflict is AMBIGUOUS, never auto-updated", () => {
  const r = compareTalabatBaseline([ourRow({ sku: "mk1" })], parse([baseRow("mk1")]));
  assert.equal(r.counts.matchedBySku, 1);
  assert.equal(r.counts.ambiguous, 0);

  // our barcode sits on a DIFFERENT Talabat SKU — a real identity conflict
  const conflict = compareTalabatBaseline([ourRow({ sku: "mk900" })], parse([baseRow("mk898")]));
  assert.equal(conflict.counts.ambiguous, 1);
  assert.equal(conflict.counts.matched, 0);
  assert.match(ambiguousDeltaRows(conflict)[0].ambiguityReason ?? "", /mk898/);
  assert.equal(updateDeltaRows(conflict).length, 0, "never auto-updated");
  assert.equal(newDeltaRows(conflict).length, 0, "never auto-added either");
  // it IS surfaced for the owner to adjudicate, rather than silently dropped
  const sheetRows = buildAmbiguousAoa(conflict);
  assert.equal(sheetRows.length, 2, "header + the one ambiguous row");
  assert.equal(sheetRows[1][0], "mk900");
  assert.equal(sheetRows[1][2], "mk898");

  // a duplicated SKU in the baseline is ambiguous too
  const dup = compareTalabatBaseline([ourRow({ sku: "mk1" })], parse([baseRow("mk1"), baseRow("mk1", { b1: "07777777777770" })]));
  assert.equal(dup.counts.ambiguous, 1);
});

test("3b: a name alone NEVER establishes identity", () => {
  // identical names, different SKUs and barcodes → new product, not a match
  const r = compareTalabatBaseline(
    [ourRow({ sku: "mk999", title: "Same Name", talabatBarcode: "1111111111116" })],
    parse([baseRow("mk1", { name: "Same Name" })]));
  assert.equal(r.counts.matched, 0);
  assert.equal(r.counts.newRows, 1);
});

// ── 4: classification and the workbooks ─────────────────────────────────────

test("4: unchanged excluded from updates; absent excluded from updates and included in new", () => {
  const our = [
    ourRow({ sku: "same" }),
    ourRow({ sku: "changed", price: 99 }),
    ourRow({ sku: "brandnew", talabatBarcode: "1111111111116" }),
  ];
  const r = compareTalabatBaseline(our, parse([baseRow("same"), baseRow("changed", { price: "79" })]));
  assert.equal(r.counts.noChange, 1);
  assert.equal(r.counts.needsUpdate, 1);
  assert.equal(r.counts.newRows, 1);

  const upd = updateDeltaRows(r).map((x) => x.our.sku);
  assert.deepEqual(upd, ["changed"], "UPDATE workbook holds only changed EXISTING products");
  assert.equal(upd.includes("same"), false, "no unchanged product");
  assert.equal(upd.includes("brandnew"), false, "no new product");

  const nw = newDeltaRows(r).map((x) => x.our.sku);
  assert.deepEqual(nw, ["brandnew"], "NEW workbook holds only absent products");
  assert.equal(nw.includes("same"), false);
  assert.equal(nw.includes("changed"), false);
});

test("5: new products include every certified variant/option row", () => {
  const our = [
    ourRow({ sku: "mkV", internalProductId: "pv" }),
    ourRow({ sku: "mkV-1-pink", isVariant: true, internalProductId: "pv", variantId: "v1", talabatBarcode: "12345678901231" }),
    ourRow({ sku: "mkV-2-blue", isVariant: true, internalProductId: "pv", variantId: "v2", talabatBarcode: "12345678901232" }),
  ];
  const r = compareTalabatBaseline(our, parse([]));
  const scope = newProductImageScope(r);
  assert.equal(scope.newRowCount, 3);
  assert.equal(scope.newSimpleRows, 1);
  assert.equal(scope.newVariantRows, 2);
  assert.equal(scope.newDistinctProducts, 1, "parent + its options are ONE product");
  assert.deepEqual(scope.productIds, ["pv"]);
  // the Talabat-schema new workbook carries all three rows
  assert.equal(buildTalabatNewProductsAoa(r).length, 4, "header + 3 rows");
});

test("6: the audit workbook is one row per changed FIELD, with barcode evidence", () => {
  const r = compareTalabatBaseline(
    [ourRow({ sku: "mk1", price: 99, talabatBarcode: "4006381333931" })],
    parse([baseRow("mk1", { price: "79", b1: "05901234123457" })]));
  const aoa = buildUpdateAuditAoa(r);
  assert.equal(aoa[0][0], "SKU");
  assert.equal(aoa.length, 3, "header + PRICE row + BARCODE row");
  const fields = aoa.slice(1).map((row) => row[5]);
  assert.deepEqual([...fields].sort(), ["BARCODE_DIFF", "PRICE_DIFF"]);
  const bc = aoa.slice(1).find((row) => row[5] === "BARCODE_DIFF")!;
  assert.equal(bc[9], "4006381333931", "OUR_AUTHORITATIVE_BARCODE is ours");
  assert.equal(bc[6], "05901234123457", "TALABAT_BARCODE_1 shown as-is");
  assert.match(String(bc[10]), /BOTH_VALID/, "evidence column populated for barcode rows");
});

test("7: ONE authoritative barcode — theirs is never adopted, extras never invented", () => {
  const r = compareTalabatBaseline(
    [ourRow({ sku: "mk1", talabatBarcode: "4006381333931" })],
    parse([baseRow("mk1", { b1: "05901234123457", b2: "07777777777770", b3: "08888888888884" })]));
  const row = buildTalabatUpdateAoa(r)[1];
  assert.equal(row[9], "4006381333931", "barcode 1 = OUR value");
  assert.equal(row[10], "", "barcode 2 left empty — we do not invent extras");
  assert.equal(row[11], "", "barcode 3 left empty — their extra values are not preserved");
});

test("8: Talabat-owned columns we do not own are emitted EMPTY, never guessed", () => {
  const r = compareTalabatBaseline([ourRow({ sku: "mk1", price: 99 })], parse([baseRow("mk1", { price: "79" })]));
  const header = buildTalabatUpdateAoa(r)[0].map(String);
  const row = buildTalabatUpdateAoa(r)[1];
  for (const col of TALABAT_UNOWNED_COLUMNS) {
    assert.equal(row[header.indexOf(col)], "", `${col} must stay blank`);
  }
  assert.equal(row[header.indexOf("active")], "", "active is Talabat's flag, never overwritten");
  assert.deepEqual(header, [...TALABAT_BASELINE_COLUMNS], "exactly Talabat's own schema");
});

test("9: ACTIVE is not compared without an authoritative equivalent, and is when given one", () => {
  const off = compareTalabatBaseline([ourRow({ sku: "mk1" })], parse([baseRow("mk1", { active: false })]));
  assert.equal(off.counts.activeStatusDiffs, 0, "no resolver → never raised");
  const on = compareTalabatBaseline([ourRow({ sku: "mk1" })], parse([baseRow("mk1", { active: false })]), { ourActiveFor: () => true });
  assert.equal(on.counts.activeStatusDiffs, 1, "with a resolver it is compared");
  assert.equal(on.rows[0].diffs[0].field, "ACTIVE_STATUS_DIFF", "classified as status, never as OOS");
});

test("10: baseline rows our master no longer has are reported, never deleted", () => {
  const r = compareTalabatBaseline([ourRow({ sku: "mk1" })], parse([baseRow("mk1"), baseRow("gone", { b1: "01111111111116" })]));
  assert.equal(r.counts.unmatchedBaseline, 1);
  assert.equal(r.unmatchedBaseline[0].sku, "gone");
  const all = [...updateDeltaRows(r), ...newDeltaRows(r)].map((x) => x.our.sku);
  assert.equal(all.includes("gone"), false, "an unmatched Talabat row never enters either workbook");
});

test("11: workbook and zip names carry the date", () => {
  assert.equal(deltaWorkbookName("new-products", "2026-09-05T10:00:00Z"), "talabat-new-products-2026-09-05.xlsx");
  assert.equal(deltaWorkbookName("products-needing-update", "2026-09-05T10:00:00Z"), "talabat-products-needing-update-2026-09-05.xlsx");
  assert.equal(newProductsImagesZipName("2026-09-05T10:00:00Z"), "talabat-new-products-images-2026-09-05.zip");
});

test("12: EAN check digit helper is correct (evidence only, never a gate)", () => {
  assert.equal(hasValidEanCheckDigit("4006381333931"), true);
  assert.equal(hasValidEanCheckDigit("4006381333930"), false);
  assert.equal(hasValidEanCheckDigit("abc"), false);
  assert.match(barcodeEvidence("4006381333931", "04006381333930"), /OURS_VALID_THEIRS_INVALID/);
  assert.match(barcodeEvidence("4006381333930", "04006381333931"), /THEIRS_VALID_OURS_INVALID/);
});

// ── sender identities ────────────────────────────────────────────────────────

const CONFIG = (from: string): MailConfig => ({
  host: "h", port: 465, secure: true, username: "u", password: "p",
  fromName: "n", fromAddress: from, attachmentMaxBytes: 1,
});

test("13: the default sender for BOTH Talabat and Rafeeq is fahad@malikasuniverse.com", () => {
  assert.equal(DEFAULT_SENDER_BY_CHANNEL.talabat, "fahad@malikasuniverse.com");
  assert.equal(DEFAULT_SENDER_BY_CHANNEL.rafeeq, "fahad@malikasuniverse.com");
  assert.equal(DEFAULT_SENDER_IDENTITY.address, "fahad@malikasuniverse.com");
  assert.equal(DEFAULT_SENDER_IDENTITY.displayName, "Fahad Abdulaziz Ali");
  assert.equal(DEFAULT_SENDER_IDENTITY.isDefault, true);
  assert.equal(DEFAULT_SENDER_IDENTITY.active, true);
});

test("14: no gulfmedia address is a default anywhere, and no credential is stored", () => {
  const src = code("lib/mail/sender-identity.ts");
  assert.equal(/gulfmedia/i.test(src), false, "the old sender is not a default in code");
  assert.equal(/password\s*[:=]\s*["'][^"']+["']/.test(src), false, "no plaintext credential");
  for (const k of ["MAIL_PASSWORD", "MAIL_USERNAME", "MAIL_HOST"]) {
    assert.equal(src.includes(k), false, `${k} is a deployment secret, not referenced here`);
  }
  // and the only occurrence in the repo's mail config is an illustrative comment
  const cfg = raw("lib/mail/config.ts");
  const hits = cfg.split("\n").filter((l) => /gulfmedia/i.test(l));
  assert.equal(hits.length, 1);
  assert.match(hits[0].trim(), /^\/\//, "comment only — never a value");
});

test("15: multiple identities are supported; inactive and unverified cannot be selected", () => {
  const second: SenderIdentity = {
    id: "ops", displayName: "Ops", address: "ops@malikasuniverse.com",
    replyTo: "fahad@malikasuniverse.com", active: true, isDefault: false,
  };
  const inactive: SenderIdentity = { ...second, id: "old", address: "old@malikasuniverse.com", active: false };
  const list = [DEFAULT_SENDER_IDENTITY, second, inactive];

  const resolved = resolveSenderIdentities(list, CONFIG("fahad@malikasuniverse.com"));
  assert.equal(resolved.length, 3, "all identities are listed");
  assert.equal(resolved[0].id, DEFAULT_SENDER_IDENTITY.id, "default first");

  const def = resolved.find((i) => i.id === DEFAULT_SENDER_IDENTITY.id)!;
  assert.equal(def.verification, "verified");
  assert.equal(def.selectable, true);

  const other = resolved.find((i) => i.id === "ops")!;
  assert.equal(other.verification, "unverified", "the transport does not own this mailbox");
  assert.equal(other.selectable, false);
  assert.equal(chooseSender(resolved, "ops").ok, false, "unverified cannot be chosen");

  const off = resolved.find((i) => i.id === "old")!;
  assert.equal(off.selectable, false);
  const pick = chooseSender(resolved, "old");
  assert.equal(pick.ok, false);
  assert.equal(pick.ok === false && pick.code, "not_selectable");

  // an explicit choice is never silently swapped for the default
  assert.equal(chooseSender(resolved, "nope").ok, false);
  assert.equal(chooseSender(resolved, null).ok, true, "no choice → the default");
  const chosen = chooseSender(resolved, null);
  assert.equal(chosen.ok && senderHeaders(chosen.identity).fromAddress, "fahad@malikasuniverse.com");
});

test("16: with no transport configured, nothing pretends to be sendable", () => {
  const resolved = resolveSenderIdentities([DEFAULT_SENDER_IDENTITY], null);
  assert.equal(resolved[0].verification, "no_transport");
  assert.equal(resolved[0].selectable, false);
  assert.equal(chooseSender(resolved, null).ok, false);
});

test("17: adding a sender validates address, display name and reply-to", () => {
  assert.equal(validateSenderIdentity({ displayName: "A", address: "a@b.com" }).ok, true);
  assert.equal(validateSenderIdentity({ displayName: "A", address: "nope" }).ok, false);
  assert.equal(validateSenderIdentity({ displayName: "", address: "a@b.com" }).ok, false);
  assert.equal(validateSenderIdentity({ displayName: "A", address: "a@b.com", replyTo: "bad" }).ok, false);
  const ok = validateSenderIdentity({ displayName: "A", address: " A@B.com " });
  assert.equal(ok.ok && ok.value.address, "a@b.com", "normalised");
});

// ── the two emails ───────────────────────────────────────────────────────────

test("18: the two emails stay separate and carry the owner's exact copy", () => {
  const { updates, newProducts } = buildTalabatEmailPair({
    updateWorkbookName: "talabat-products-update-2026-09-05.xlsx",
    newWorkbookName: "talabat-new-products-2026-09-05.xlsx",
    imagesZipName: "talabat-new-products-images-2026-09-05.zip",
  });
  assert.equal(updates.subject, TALABAT_EMAIL_SUBJECTS.existing_updates);
  assert.equal(newProducts.subject, TALABAT_EMAIL_SUBJECTS.new_products);
  assert.notEqual(updates.subject, newProducts.subject);

  assert.match(updates.bodyText, /only products that are already listed on Talabat/);
  assert.match(updates.bodyText, /keeping all other existing\nproducts unchanged/);
  assert.match(newProducts.bodyText, /not currently listed in\nour Talabat catalog/);
  assert.match(newProducts.bodyText, /keeping all\ncurrently listed products unchanged/);

  // no cross-contamination of attachments
  assert.deepEqual(updates.attachments, ["talabat-products-update-2026-09-05.xlsx"]);
  assert.deepEqual(newProducts.attachments, ["talabat-new-products-2026-09-05.xlsx", "talabat-new-products-images-2026-09-05.zip"]);
  assert.equal(updates.attachments.some((a) => a.includes("new-products")), false);
  assert.equal(newProducts.attachments.includes("talabat-products-update-2026-09-05.xlsx"), false);

  for (const d of [updates, newProducts]) {
    assert.match(d.bodyText, /Fahad Abdulaziz Ali/);
    assert.match(d.bodyText, /fahad@malikasuniverse\.com/);
    assert.match(d.bodyText, /\+974 3331 5315/);
  }
});

test("19: nothing in these modules can send an email", () => {
  for (const rel of ["lib/export/talabat/email-templates.ts", "lib/export/talabat/baseline-delta.ts",
                     "lib/export/talabat/delta-workbooks.ts", "lib/mail/sender-identity.ts"]) {
    const src = code(rel);
    for (const bad of ["nodemailer", "createTransport", "sendMail", "fetch(", "smtp"]) {
      assert.equal(src.toLowerCase().includes(bad.toLowerCase()), false, `${rel} must not reference ${bad}`);
    }
  }
});

// ── the certified full package is untouched ─────────────────────────────────

test("20: the full certified package workflow is unchanged by STEP 79", () => {
  // the delta consumes certified values; it never re-derives a rule
  const delta = code("lib/export/talabat/baseline-delta.ts") + code("lib/export/talabat/delta-workbooks.ts");
  for (const rule of ["resolveTalabatSellingPrice", "resolveTalabatCategory", "resolveTalabatBarcode",
                      "loadMasterScope", "TALABAT_NATIVE_CATEGORIES", "positivePrice"]) {
    assert.equal(delta.includes(rule), false, `delta must not re-implement ${rule}`);
  }
  // and the package engine gained no dependency on the delta
  const engine = code("lib/export/talabat/package-job.ts") + code("lib/export/talabat/package.ts");
  assert.equal(/baseline-delta|delta-workbooks/.test(engine), false, "the package engine does not import the delta");
});
