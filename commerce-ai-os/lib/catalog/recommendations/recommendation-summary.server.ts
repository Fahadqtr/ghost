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
export async function loadRecommendationBatch(
  memberIds?: ReadonlySet<string> | null,
): Promise<RecommendationBatch | null> {
  const batch = await loadCatalogEvidenceBatch();
  if (!batch) return null;
  const results = memberIds ? batch.results.filter((r) => memberIds.has(r.productId)) : batch.results;
  const recommendations: Recommendation[] = [];
  for (const res of results) {
    recommendations.push(...buildRecommendations(res.evidence, res.productId));
  }
  return { recommendations, labels: batch.labels };
}

/**
 * Recommendation overview. Null when unauthenticated / on failure.
 * `memberIds` optionally restricts it to a product membership (the Malikas
 * operational master); omitted/null = whole catalog, the original behaviour.
 */
export async function loadRecommendationSummary(
  memberIds?: ReadonlySet<string> | null,
): Promise<RecommendationSummary | null> {
  const batch = await loadRecommendationBatch(memberIds);
  if (!batch) return null;
  return computeRecommendationSummary(batch.recommendations);
}
