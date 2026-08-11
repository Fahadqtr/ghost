// Malikas V2 — Identity fill helpers (UX.4B). PURE orchestration ONLY: it composes
// the EXISTING generators (sku-generate.ts, barcode-ean13.ts) into the "generate"
// operations the create + edit forms share. It re-implements NOTHING — no SKU/
// barcode regex, no EAN math, no collision loop, no variant numbering: those all
// live in the two modules it imports. Every operation is a proposal that returns
// new values for the caller's form state; it never reads/writes a DB and never
// mutates its inputs. `random` is injected (the forms pass Math.random) so the
// logic stays deterministic under test.

import { nextMkSku, variantMkSku } from "./sku-generate.ts";
import { generateUniqueEan13Batch } from "./barcode-ean13.ts";

const isBlank = (v: string | null | undefined): boolean => (v ?? "").trim() === "";

/** Next free main SKU (mk<number>) given every existing sku. Thin passthrough. */
export function nextMainSku(existingSkus: Iterable<unknown>): string {
  return nextMkSku(existingSkus);
}

/** One fresh EAN-13 not in `existing`. Caller injects `random` (Math.random). */
export function nextMainBarcode(existing: ReadonlySet<string>, random: () => number): string {
  return generateUniqueEan13Batch(1, existing, random)[0];
}

/** Fill ONLY empty variant SKUs, by 1-based position (mk123-1, …), via the shared
 *  variantMkSku. Existing SKUs are returned verbatim (never rewritten). */
export function fillMissingVariantSkus(mainSku: string, rows: readonly { sku: string }[]): string[] {
  return rows.map((r, i) => (isBlank(r.sku) ? variantMkSku(mainSku, i + 1) : r.sku));
}

/** Fill ONLY empty variant barcodes with fresh EAN-13s, collision-checked (via the
 *  shared batch generator) against `existing` PLUS every non-empty barcode already
 *  in the rows PLUS `extraTaken` (e.g. the product barcode). Existing untouched. */
export function fillMissingVariantBarcodes(
  rows: readonly { barcode: string }[],
  existing: ReadonlySet<string>,
  random: () => number,
  extraTaken: Iterable<string> = [],
): string[] {
  const taken = new Set<string>(existing);
  for (const t of extraTaken) if (!isBlank(t)) taken.add(t.trim());
  for (const r of rows) if (!isBlank(r.barcode)) taken.add(r.barcode.trim());

  const emptyCount = rows.reduce((n, r) => (isBlank(r.barcode) ? n + 1 : n), 0);
  if (emptyCount === 0) return rows.map((r) => r.barcode);

  const fresh = generateUniqueEan13Batch(emptyCount, taken, random);
  let k = 0;
  return rows.map((r) => (isBlank(r.barcode) ? fresh[k++] : r.barcode));
}

/** Copy the product price into ONLY empty variant prices. Existing untouched. */
export function copyProductPriceToEmpty(productPrice: string, rows: readonly { price: string }[]): string[] {
  const p = (productPrice ?? "").trim();
  return rows.map((r) => (isBlank(r.price) ? p : r.price));
}

/** Generate all MISSING identity (empty SKU + empty barcode) in one pass — the
 *  "Generate all" button. Composes the two fill-missing helpers; touches nothing
 *  that already has a value. */
export function generateAllMissingIdentity(
  mainSku: string,
  rows: readonly { sku: string; barcode: string }[],
  existingBarcodes: ReadonlySet<string>,
  random: () => number,
  extraTakenBarcodes: Iterable<string> = [],
): { skus: string[]; barcodes: string[] } {
  return {
    skus: fillMissingVariantSkus(mainSku, rows),
    barcodes: fillMissingVariantBarcodes(rows, existingBarcodes, random, extraTakenBarcodes),
  };
}
