import "server-only";
// CAT.1D — Recommendation overview read API (SERVER-ONLY, READ-ONLY).
//
// loadRecommendationSummary() → catalog-wide recommendation counts by type +
// priority for Operations (§10). It reuses the SINGLE bounded CAT.1B evidence
// batch (no new scan, no product-data read) and derives recommendations purely.
// NO writes, no persistence.

import { loadCatalogEvidenceBatch } from "../evidence/evidence-batch.server.ts";
import { buildRecommendations, computeRecommendationSummary, type RecommendationSummary } from "./recommendation-engine.ts";
import type { Recommendation } from "./recommendation-model.ts";

export interface RecommendationBatch {
  recommendations: Recommendation[];
  labels: Record<string, string>;
}

/** All catalog recommendations from the shared bounded evidence batch. Null on failure. */
export async function loadRecommendationBatch(): Promise<RecommendationBatch | null> {
  const batch = await loadCatalogEvidenceBatch();
  if (!batch) return null;
  const recommendations: Recommendation[] = [];
  for (const res of batch.results) {
    recommendations.push(...buildRecommendations(res.evidence, res.productId));
  }
  return { recommendations, labels: batch.labels };
}

/** Catalog-wide recommendation overview. Null when unauthenticated / on failure. */
export async function loadRecommendationSummary(): Promise<RecommendationSummary | null> {
  const batch = await loadRecommendationBatch();
  if (!batch) return null;
  return computeRecommendationSummary(batch.recommendations);
}
