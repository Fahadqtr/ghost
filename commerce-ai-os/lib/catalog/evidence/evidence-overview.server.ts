import "server-only";
// CAT.1B — Evidence overview read API (SERVER-ONLY, READ-ONLY).
//
// loadEvidenceOverview() → counts by domain / severity / source across the
// catalog for Operations. It reuses the SINGLE bounded catalog evidence batch
// (loadCatalogEvidenceBatch) so the overview and the CAT.1C Action Center
// projection never scan the catalog twice. NO writes, no persistence.

import { computeEvidenceOverview, type EvidenceOverview } from "./evidence-engine.ts";
import { loadCatalogEvidenceBatch } from "./evidence-batch.server.ts";

/** Bounded, read-only evidence overview. Null when unauthenticated / on failure. */
export async function loadEvidenceOverview(): Promise<EvidenceOverview | null> {
  const batch = await loadCatalogEvidenceBatch();
  if (!batch) return null;
  return computeEvidenceOverview(batch.results);
}
