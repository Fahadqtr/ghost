// CAT.1C — Evidence Action Center source (SERVER-ONLY, read-only).
//
// Bridges the canonical CAT.1B evidence batch into the Action Center. It performs
// NO scan of its own and NO compute: it calls the shared, bounded evidence batch
// (loadCatalogEvidenceBatch) and flattens the ACTIVE per-product evidence for the
// pure projection adapter. Best-effort: a null read contributes zero actions and
// is reported ok:false, never a fabricated item.

import "server-only";

import { loadCatalogEvidenceBatch } from "@/lib/catalog/evidence/evidence-batch.server";
import type { Evidence } from "@/lib/catalog/evidence/evidence-model";

export interface EvidenceActionData {
  evidence: Evidence[];
  labels: Record<string, string>;
}

/** Flatten the canonical evidence batch for projection. Null on any read failure. */
export async function loadEvidenceActions(): Promise<EvidenceActionData | null> {
  const batch = await loadCatalogEvidenceBatch();
  if (!batch) return null;
  const evidence: Evidence[] = [];
  for (const r of batch.results) {
    for (const e of r.evidence) evidence.push(e);
  }
  return { evidence, labels: batch.labels };
}
