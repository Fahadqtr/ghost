"use server";

// CH.6E — Bulk AI Product Enrichment SERVER ACTIONS.
//
// Thin wrappers over the orchestrator. Scan is read-only (signed-in). Generate is
// writer-gated inside the orchestrator (paid AI). Apply is writer-gated and routes
// writes through the narrow Catalog metadata boundary. These actions add no AI,
// DB, or write logic of their own; the client never holds a DB/admin client.

import { revalidatePath } from "next/cache";
import {
  scanEnrichmentCandidates,
  generateEnrichment,
  applyEnrichment,
  type ScanResult,
  type ScanFilters,
  type GenerateResult,
  type ApplyResult,
  type ApprovedSuggestion,
} from "@/lib/enrichment/enrichment.server";
import { isEnrichmentField, type EnrichmentField } from "@/lib/enrichment/enrichment-fields";

function parseFilters(raw: unknown): ScanFilters {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const field = typeof f.field === "string" && isEnrichmentField(f.field) ? (f.field as EnrichmentField) : undefined;
  return {
    brand: typeof f.brand === "string" && f.brand ? f.brand : undefined,
    category: typeof f.category === "string" && f.category ? f.category : undefined,
    sku: typeof f.sku === "string" && f.sku ? f.sku : undefined,
    field,
  };
}

export async function scanEnrichmentAction(filters: unknown): Promise<ScanResult | { error: string }> {
  return scanEnrichmentCandidates(parseFilters(filters));
}

export async function generateEnrichmentAction(
  productIds: string[],
  field?: string,
): Promise<GenerateResult | { error: string }> {
  const ids = Array.isArray(productIds) ? productIds.filter((s) => typeof s === "string" && s) : [];
  const f = typeof field === "string" && isEnrichmentField(field) ? (field as EnrichmentField) : undefined;
  if (ids.length === 0) return { error: "لا توجد منتجات محددة." };
  return generateEnrichment({ productIds: ids, field: f });
}

export async function generateAllEligibleAction(filters: unknown): Promise<GenerateResult | { error: string }> {
  const f = parseFilters(filters);
  return generateEnrichment({ field: f.field });
}

export async function applyEnrichmentAction(approved: ApprovedSuggestion[]): Promise<ApplyResult | { error: string }> {
  const list = Array.isArray(approved) ? approved : [];
  const res = await applyEnrichment(list);
  if (!("error" in res)) revalidatePath("/v2/operations/ai-enrichment");
  return res;
}
