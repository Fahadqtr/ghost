import "server-only";
// CAT.1D — Recommendation read API (SERVER-ONLY, READ-ONLY).
//
// loadRecommendations(productId) → the certified recommendations for one product,
// derived ONLY from canonical CAT.1B evidence (loadEvidence). It reads no product
// data directly and writes nothing.

import { loadEvidence } from "../evidence/evidence.server.ts";
import { buildRecommendations } from "./recommendation-engine.ts";
import type { Recommendation } from "./recommendation-model.ts";
import type { EvidenceResult } from "../evidence/evidence-engine.ts";

export interface ProductRecommendations {
  productId: string;
  recommendations: Recommendation[];
  /** the canonical evidence the recommendations were derived from (for linking). */
  evidence: EvidenceResult;
}

/** Load the certified recommendations for one product. Null when unauthenticated/absent. */
export async function loadRecommendations(productId: string): Promise<ProductRecommendations | null> {
  const evidence = await loadEvidence(productId);
  if (!evidence) return null;
  return {
    productId: evidence.productId,
    recommendations: buildRecommendations(evidence.evidence, evidence.productId),
    evidence,
  };
}
