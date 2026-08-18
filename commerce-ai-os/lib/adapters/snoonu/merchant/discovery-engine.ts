// MEDIA.1B — Snoonu Media Discovery engine (PURE).
//
// The single search pipeline. Given an INJECTED provider + a query, it runs the
// fixed search order and classifies the outcome:
//   Barcode → SKU → Exact Name → Contains Name
// stopping as soon as a step yields results. Deterministic identity (a single
// exact barcode or SKU) → SAFE_MATCH; everything else that yields candidates →
// NEEDS_REVIEW (a name/partial/multiple match may NEVER be treated as safe). No
// candidates → NO_MATCH. No authenticated session → SESSION_REQUIRED (no search
// is attempted, nothing is fabricated). It performs NO IO itself — it only calls
// the injected provider, so it is fully unit-testable with a fake provider.
//
// PURE: relative type imports only; no server-only, no DB, no network, no clock.

import type {
  DiscoveryCandidate,
  DiscoveryClassification,
  DiscoveryConfidence,
  DiscoveryLookup,
  DiscoveryMatchReason,
  DiscoveryQuery,
  DiscoveryResult,
  MerchantSessionState,
  SnoonuDiscoveryProvider,
} from "./discovery-contract.ts";

const has = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "";

function result(
  q: DiscoveryQuery,
  sessionState: MerchantSessionState,
  classification: DiscoveryClassification,
  matchReason: DiscoveryMatchReason,
  confidence: DiscoveryConfidence,
  candidates: DiscoveryCandidate[],
  error: string | null = null,
): DiscoveryResult {
  return {
    storefrontKey: q.storefrontKey,
    sessionState,
    classification,
    matchReason,
    confidence,
    candidates,
    candidateCount: candidates.length,
    error,
  };
}

/** Classify one non-empty step's candidates for a "deterministic identity" step. */
function classifyIdentityStep(
  q: DiscoveryQuery,
  lookup: DiscoveryLookup,
  singleReason: DiscoveryMatchReason,
  multiReason: DiscoveryMatchReason,
): DiscoveryResult {
  const c = lookup.candidates;
  if (c.length === 1) return result(q, "authenticated", "SAFE_MATCH", singleReason, "high", c);
  return result(q, "authenticated", "NEEDS_REVIEW", multiReason, "medium", c);
}

/**
 * Run the discovery pipeline for ONE storefront. The provider MUST be scoped to
 * `query.storefrontKey`; the result and every candidate retain that storefront —
 * identity is never merged across storefronts.
 */
export async function runSnoonuDiscovery(
  provider: SnoonuDiscoveryProvider,
  query: DiscoveryQuery,
): Promise<DiscoveryResult> {
  const q = query;
  try {
    const state = await provider.state();
    if (state === "error") return result(q, "error", "ERROR", "error", "none", [], "Snoonu session error.");
    if (state !== "authenticated") {
      // otp_required / session_required both mean: no live discovery yet.
      return result(q, state, "SESSION_REQUIRED", "session_required", "none", []);
    }

    if (!has(q.barcode) && !has(q.sku) && !has(q.name)) {
      return result(q, state, "NO_MATCH", "not_searchable", "none", []);
    }

    // 1) Barcode (deterministic identity)
    if (has(q.barcode)) {
      const lk = await provider.findByBarcode(q.barcode);
      if (lk.state === "error") return result(q, "authenticated", "ERROR", "error", "none", [], lk.error ?? "error");
      if (lk.state !== "authenticated") return result(q, lk.state, "SESSION_REQUIRED", "session_required", "none", []);
      if (lk.candidates.length > 0) return classifyIdentityStep(q, lk, "exact_barcode", "multiple_barcode");
    }

    // 2) SKU (deterministic identity)
    if (has(q.sku)) {
      const lk = await provider.findBySku(q.sku);
      if (lk.state === "error") return result(q, "authenticated", "ERROR", "error", "none", [], lk.error ?? "error");
      if (lk.state !== "authenticated") return result(q, lk.state, "SESSION_REQUIRED", "session_required", "none", []);
      if (lk.candidates.length > 0) return classifyIdentityStep(q, lk, "exact_sku", "multiple_sku");
    }

    // 3) Exact name (discovery only — never SAFE)
    if (has(q.name)) {
      const lk = await provider.searchExactName(q.name);
      if (lk.state === "error") return result(q, "authenticated", "ERROR", "error", "none", [], lk.error ?? "error");
      if (lk.state !== "authenticated") return result(q, lk.state, "SESSION_REQUIRED", "session_required", "none", []);
      if (lk.candidates.length > 0) {
        const reason: DiscoveryMatchReason = lk.candidates.length === 1 ? "exact_name" : "multiple_name";
        return result(q, "authenticated", "NEEDS_REVIEW", reason, "medium", lk.candidates);
      }

      // 4) Contains name (weakest discovery — never SAFE)
      const lk2 = await provider.searchContainsName(q.name);
      if (lk2.state === "error") return result(q, "authenticated", "ERROR", "error", "none", [], lk2.error ?? "error");
      if (lk2.state !== "authenticated") return result(q, lk2.state, "SESSION_REQUIRED", "session_required", "none", []);
      if (lk2.candidates.length > 0) return result(q, "authenticated", "NEEDS_REVIEW", "contains_name", "low", lk2.candidates);
    }

    return result(q, "authenticated", "NO_MATCH", "no_match", "none", []);
  } catch (e) {
    return result(q, "error", "ERROR", "error", "none", [], e instanceof Error ? e.message : "discovery failed");
  }
}
