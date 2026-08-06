// EAN-13 barcodes for the AI product creator (Phase UI.5). Pure, no imports.
//
// The house barcode type is EAN-13 (the legacy New-product form already
// generates 12 random digits + a computed check digit — genEan13 in
// components/ProductForm.tsx). This module is the same algorithm, made pure
// and collision-aware: the digit source is injected so tests are
// deterministic, and generation retries against the full set of barcodes
// already used by products AND variants.

/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(digits12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(digits12[i]);
  return (10 - (sum % 10)) % 10;
}

/** True for a 13-digit string whose last digit is the valid check digit. */
export function isValidEan13(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!/^\d{13}$/.test(s)) return false;
  return ean13CheckDigit(s.slice(0, 12)) === Number(s[12]);
}

/** One EAN-13 from an injected uniform [0,1) digit source. */
export function generateEan13(random: () => number): string {
  let d = "";
  for (let i = 0; i < 12; i++) d += Math.floor(random() * 10) % 10;
  return d + ean13CheckDigit(d);
}

/**
 * Distinct EAN-13s, none of which appear in `existing` and none of which
 * repeat within the returned batch — one per item (product + each variant),
 * because every sellable entity must carry its own barcode. Throws only if a
 * pathological digit source exhausts the attempt budget.
 */
export function generateUniqueEan13Batch(
  count: number,
  existing: ReadonlySet<string>,
  random: () => number,
  maxAttempts = 1000,
): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  let attempts = 0;
  while (out.length < count) {
    if (++attempts > maxAttempts) {
      throw new Error("ean13_generation_exhausted");
    }
    const code = generateEan13(random);
    if (existing.has(code) || used.has(code)) continue;
    used.add(code);
    out.push(code);
  }
  return out;
}
