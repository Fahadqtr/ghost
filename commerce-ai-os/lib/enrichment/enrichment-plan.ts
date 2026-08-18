// CH.6E — suggestion assembly + apply planning (PURE).
//
// Turns a validated model output into per-field SUGGESTIONS with a status, and
// plans the writer-gated apply with stale-preview protection (§12) and
// existing-content protection (§13). MISSING fields are auto-eligible; WEAK fields
// are generated but require explicit selection; GOOD fields are never replaced.
//
// PURE: imports only pure siblings. node:test loads it.

import { type EnrichmentField } from "./enrichment-fields.ts";
import { type Quality } from "./enrichment-classify.ts";
import { type EnrichmentOutput, suggestionFor } from "./enrichment-prompt.ts";
import { type FailureCode } from "./enrichment-diagnostics.ts";

export type SuggestionStatus = "READY" | "UNCHANGED" | "NEEDS_REVIEW" | "INSUFFICIENT_DATA" | "FAILED";

export interface Suggestion {
  productId: string;
  sku: string | null;
  productName: string | null;
  field: EnrichmentField;
  currentValue: string | null;
  currentQuality: Quality;
  suggestedValue: string;
  reason: string;
  status: SuggestionStatus;
  /** true only for MISSING fields — WEAK requires explicit operator selection. */
  autoEligible: boolean;
  notes: string;
  /** AI.FIX.1 — the precise failure code when status is FAILED (safe to surface). */
  failureCode?: FailureCode;
}

const norm = (v: string | null | undefined): string => String(v ?? "").replace(/\s+/g, " ").trim();

export function suggestionKey(s: { productId: string; field: EnrichmentField }): string {
  return `${s.productId}::${s.field}`;
}

export interface BuildSuggestionInput {
  productId: string;
  sku: string | null;
  productName: string | null;
  field: EnrichmentField;
  currentValue: string | null;
  currentQuality: Quality;
  /** parsed+validated output, or null when the generation call failed. */
  output: EnrichmentOutput | null;
  /** AI.FIX.1 — the precise failure code when output is null (optional). */
  failureCode?: FailureCode;
}

/** Assemble one suggestion + its status from a validated output. */
export function buildSuggestion(input: BuildSuggestionInput): Suggestion {
  const base = {
    productId: input.productId, sku: input.sku, productName: input.productName,
    field: input.field, currentValue: input.currentValue, currentQuality: input.currentQuality,
    autoEligible: input.currentQuality === "MISSING",
  };
  if (!input.output) {
    const code = input.failureCode;
    return {
      ...base, suggestedValue: "",
      reason: code ? `generation failed (${code})` : "generation failed or returned malformed output",
      status: "FAILED", notes: "", ...(code ? { failureCode: code } : {}),
    };
  }
  const suggested = norm(suggestionFor(input.output, input.field));
  const notes = input.output.notes ?? "";
  if (input.currentQuality === "GOOD") {
    return { ...base, suggestedValue: suggested, reason: "existing content is already good", status: "UNCHANGED", notes };
  }
  if (input.output.insufficient_data || suggested === "") {
    return { ...base, suggestedValue: "", reason: "insufficient catalog evidence to generate safely", status: "INSUFFICIENT_DATA", notes };
  }
  if (norm(input.currentValue) === suggested) {
    return { ...base, suggestedValue: suggested, reason: "suggestion equals current value", status: "UNCHANGED", notes };
  }
  return {
    ...base, suggestedValue: suggested,
    reason: input.currentQuality === "MISSING" ? "fills a missing field" : "improves weak content",
    status: "READY", notes,
  };
}

export type PlanAction = "apply" | "skip" | "stale";

export interface EnrichmentPlanItem {
  productId: string;
  field: EnrichmentField;
  suggestedValue: string;
  action: PlanAction;
  reason: string;
}

export interface EnrichmentPlanInput {
  suggestions: Suggestion[];
  /** operator-selected suggestion keys. */
  selected: Set<string>;
  /** FRESH current value at apply time: suggestionKey → current value. */
  freshValues: Map<string, string | null>;
}

/**
 * Plan the apply. Only selected READY suggestions proceed, and only when the
 * field's value is UNCHANGED since generation (stale-preview protection) — if it
 * changed (someone edited it, or good content appeared) it is left alone.
 */
export function planEnrichmentApply(input: EnrichmentPlanInput): EnrichmentPlanItem[] {
  const out: EnrichmentPlanItem[] = [];
  for (const s of input.suggestions) {
    const key = suggestionKey(s);
    if (!input.selected.has(key)) continue;
    if (s.status !== "READY" || s.suggestedValue === "") {
      out.push({ productId: s.productId, field: s.field, suggestedValue: "", action: "skip", reason: `not applicable (${s.status})` });
      continue;
    }
    // Stale-preview protection: the field must be unchanged from generation time.
    const fresh = norm(input.freshValues.get(key) ?? null);
    if (fresh !== norm(s.currentValue)) {
      out.push({ productId: s.productId, field: s.field, suggestedValue: "", action: "stale", reason: "field changed since preview — not overwritten" });
      continue;
    }
    out.push({ productId: s.productId, field: s.field, suggestedValue: s.suggestedValue, action: "apply", reason: s.reason });
  }
  return out;
}
