import "server-only";
// CAT.1B — Unified Evidence read API (SERVER-ONLY, READ-ONLY).
//
// loadEvidence(productId) → the canonical, ordered, deduped evidence for one
// product, projected from the certified CAT.1A catalog-health. NO writes, no
// persistence. The clock lives here (observedAt); the engine stays pure.

import { loadCatalogHealth } from "../health/health.server.ts";
import { buildEvidenceFromHealth, type EvidenceResult } from "./evidence-engine.ts";

/** Load the canonical evidence for one product. Null when unauthenticated/absent. */
export async function loadEvidence(productId: string): Promise<EvidenceResult | null> {
  const health = await loadCatalogHealth(productId);
  if (!health) return null;
  return buildEvidenceFromHealth(health, { observedAt: new Date().toISOString() });
}
