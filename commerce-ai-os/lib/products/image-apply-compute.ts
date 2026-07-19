// Pure helpers for the "apply images by SKU" bulk tool. DB-free so they can be
// unit-tested in isolation (see image-apply-compute.test.ts).

// Derive the catalog SKU from an image filename. The catalog convention names
// each product's photo "<sku>.<ext>" (e.g. mk2087.jpg), so the base name IS the
// SKU. We drop any directory prefix (some browsers send "folder/mk2087.jpg" for
// directory picks) and the final extension, then trim surrounding whitespace.
// Case is preserved — the DB match is exact — so callers holding lowercase SKUs
// should keep their files lowercase too.
export function skuFromFilename(name: string): string {
  const base = String(name || "").split(/[\\/]/).pop() ?? "";
  const noExt = base.replace(/\.[^.]+$/, "");
  return noExt.trim();
}

export interface ApplyOutcome {
  applied: number; // image saved onto a catalog product
  noProduct: number; // filename had no matching SKU in the catalog
  failed: number; // matched but the upload/update errored
}

// Roll a list of per-file results into a summary. Each result is one of:
//   "applied"   — stored + linked to a product
//   "noProduct" — no catalog row with that SKU
//   "failed"    — a real error while saving
export function summarizeOutcomes(
  results: Array<"applied" | "noProduct" | "failed">,
): ApplyOutcome {
  const out: ApplyOutcome = { applied: 0, noProduct: 0, failed: 0 };
  for (const r of results) out[r]++;
  return out;
}
