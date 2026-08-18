// MEDIA.1B — Snoonu Media Discovery contracts (PURE).
//
// The discovery pipeline SEARCHES the Snoonu merchant portal for a product's media
// (barcode → SKU → exact name → contains name) and CLASSIFIES the outcome. It
// discovers only — it never recovers/writes images, never touches the catalog, and
// never turns a name match into durable identity. The concrete portal search is an
// INJECTED SnoonuDiscoveryProvider; this module holds NO automation, NO
// credentials, NO DB, NO network — it is types + the provider interface only.
// Storefront is ALWAYS explicit (snoonu:malikas | snoonu:pure_seoul).
//
// PURE: relative type import only; node:test loads it directly.

import type { MerchantSessionState, SnoonuStorefrontKey } from "./merchant-contract.ts";
export type { MerchantSessionState, SnoonuStorefrontKey } from "./merchant-contract.ts";

/** What a search is run against — the internal product's identifying facts. */
export interface DiscoveryQuery {
  storefrontKey: SnoonuStorefrontKey;
  barcode: string | null;
  sku: string | null;
  name: string | null;
}

/**
 * One candidate as seen on the merchant portal. `spi` is the storefront-scoped
 * external id (never reused across storefronts). Image dimensions are optional —
 * only present when the provider supplies them. NEVER persisted here.
 */
export interface DiscoveryCandidate {
  storefrontKey: SnoonuStorefrontKey;
  spi: string | null;
  name: string | null;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

/** The result of ONE provider search method. */
export interface DiscoveryLookup {
  state: MerchantSessionState;
  candidates: DiscoveryCandidate[];
  /** Safe public error (detail logged server-side, never returned). */
  error?: string;
}

/**
 * The INJECTED discovery provider PORT. A future MEDIA.1A-P live adapter
 * implements these four searches against the authenticated Snoonu portal. The
 * default provider (discovery-provider.server.ts) reports `session_required` for
 * all methods and performs NO network request — so nothing runs against an
 * unverified portal contract and no result is ever fabricated.
 *
 * Every method is storefront-scoped by construction (the provider carries
 * `storefrontKey`); callers must never mix a Malikas provider with Pure Seoul.
 */
export interface SnoonuDiscoveryProvider {
  readonly storefrontKey: SnoonuStorefrontKey;
  state(): Promise<MerchantSessionState>;
  findByBarcode(barcode: string): Promise<DiscoveryLookup>;
  findBySku(sku: string): Promise<DiscoveryLookup>;
  searchExactName(name: string): Promise<DiscoveryLookup>;
  searchContainsName(name: string): Promise<DiscoveryLookup>;
}

export type DiscoveryClassification =
  | "SAFE_MATCH"
  | "NEEDS_REVIEW"
  | "NO_MATCH"
  | "SESSION_REQUIRED"
  | "ERROR";

/** Why the classification was reached (fixed, deterministic reason codes). */
export type DiscoveryMatchReason =
  | "exact_barcode"
  | "exact_sku"
  | "multiple_barcode"
  | "multiple_sku"
  | "exact_name"
  | "multiple_name"
  | "contains_name"
  | "no_match"
  | "session_required"
  | "error"
  | "not_searchable"; // the product carries no barcode/sku/name to search by

export type DiscoveryConfidence = "high" | "medium" | "low" | "none";

/** The discovery outcome for ONE storefront. */
export interface DiscoveryResult {
  storefrontKey: SnoonuStorefrontKey;
  sessionState: MerchantSessionState;
  classification: DiscoveryClassification;
  matchReason: DiscoveryMatchReason;
  confidence: DiscoveryConfidence;
  candidates: DiscoveryCandidate[];
  candidateCount: number;
  error: string | null;
}

export const REASON_LABEL: Record<DiscoveryMatchReason, string> = {
  exact_barcode: "تطابق باركود دقيق",
  exact_sku: "تطابق SKU دقيق",
  multiple_barcode: "عدة نتائج بالباركود",
  multiple_sku: "عدة نتائج بالـ SKU",
  exact_name: "تطابق اسم دقيق",
  multiple_name: "عدة نتائج بالاسم",
  contains_name: "احتواء الاسم",
  no_match: "لا نتائج",
  session_required: "الجلسة مطلوبة",
  error: "خطأ",
  not_searchable: "لا يوجد باركود/‏SKU/اسم للبحث",
};

export const CLASSIFICATION_LABEL: Record<DiscoveryClassification, string> = {
  SAFE_MATCH: "تطابق آمن",
  NEEDS_REVIEW: "يحتاج مراجعة",
  NO_MATCH: "لا تطابق",
  SESSION_REQUIRED: "الجلسة مطلوبة",
  ERROR: "خطأ",
};
