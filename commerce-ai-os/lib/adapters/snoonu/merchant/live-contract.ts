// MEDIA.1A-P2/P3 — VERIFIED Snoonu merchant-portal contract (PURE).
//
// Every constant and shape in this file comes from sanitized operator captures
// of the authenticated Snoonu merchant portal — nothing is guessed. The captures
// verified: the API host, the Products search endpoint, the request body fields,
// the response envelope (status/data.products with id, businessUnitId, barcode,
// sku, price, locales[].name, images[].imageUri), the image CDN host
// (images.snoonu.com), and the searchTermType values: `2` performs a NAME
// search; `1` performs the identity search used for both SKU and BARCODE terms
// (MEDIA.1A-P3 captures). No other searchTermType value exists here.
//
// PURE: relative type imports only; no env, no network, no server-only, no IO.

import type { DiscoveryCandidate, SnoonuStorefrontKey } from "./discovery-contract.ts";

/** VERIFIED portal API origin (from capture). The ONLY host the live adapter calls. */
export const SNOONU_PORTAL_ORIGIN = "https://api-portal.snoonu.com";

/** VERIFIED product-search endpoint (from capture). POST only. */
export const SNOONU_PRODUCTS_SEARCH_PATH = "/api/marketplace/CatalogManagement/Products";

/** VERIFIED: the portal sent searchTermType=2 when searching by product NAME. */
export const SEARCH_TERM_TYPE_NAME = 2;

/** VERIFIED: the portal sent searchTermType=1 when searching by SKU and when searching by BARCODE. */
export const SEARCH_TERM_TYPE_SKU_OR_BARCODE = 1;

/** Bounded page size for discovery reads (productTake). */
export const SNOONU_DISCOVERY_PAGE_SIZE = 20;

/** The VERIFIED request body shape for the Products search endpoint. */
export interface SnoonuProductsSearchBody {
  businessUnitId: string;
  searchTerm: string;
  searchTermType: number;
  productSkip: number;
  productTake: number;
}

/** Build the verified request body for a NAME search (searchTermType = 2). */
export function buildNameSearchBody(businessUnitId: string, searchTerm: string): SnoonuProductsSearchBody {
  return {
    businessUnitId,
    searchTerm,
    searchTermType: SEARCH_TERM_TYPE_NAME,
    productSkip: 0,
    productTake: SNOONU_DISCOVERY_PAGE_SIZE,
  };
}

/** Build the verified request body for an identity search — SKU or barcode (searchTermType = 1). */
export function buildIdentitySearchBody(businessUnitId: string, searchTerm: string): SnoonuProductsSearchBody {
  return {
    businessUnitId,
    searchTerm,
    searchTermType: SEARCH_TERM_TYPE_SKU_OR_BARCODE,
    productSkip: 0,
    productTake: SNOONU_DISCOVERY_PAGE_SIZE,
  };
}

/**
 * Per-storefront session configuration, provisioned OUT-OF-BAND into the
 * reserved server env var as a JSON string:
 *   { "businessUnitId": "...", "headers": { "<header-name>": "<value>", ... } }
 * `headers` are the authenticated request headers exactly as captured by the
 * operator (e.g. a cookie or authorization header) — this code never assumes
 * WHICH header carries the session; it attaches the operator's verbatim
 * material. Values are never logged, serialized back out, or returned.
 */
export interface SnoonuSessionConfig {
  businessUnitId: string;
  headers: Record<string, string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/**
 * Parse the env JSON into a config. Returns null when the value is not the
 * documented shape (absent/blank input is the caller's presence check). Never
 * throws; never echoes any part of the input in an error.
 */
export function parseSnoonuSessionConfig(raw: unknown): SnoonuSessionConfig | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!isRecord(obj)) return null;
  const businessUnitId = str(obj.businessUnitId);
  if (!businessUnitId) return null;
  if (!isRecord(obj.headers)) return null;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj.headers)) {
    if (typeof k === "string" && k.trim() !== "" && typeof v === "string") headers[k.trim()] = v;
  }
  if (Object.keys(headers).length === 0) return null;
  return { businessUnitId, headers };
}

/**
 * Parse the VERIFIED response envelope into discovery candidates. Defensive:
 * anything off-shape yields [] (or skips the row) — never a throw, never an
 * invented field. Mapping (verified): id → spi, sku → sku, barcode → barcode,
 * first non-empty locales[].name → name, first non-empty images[].imageUri →
 * imageUrl. Image dimensions are not in the verified response → null.
 */
export function parseSnoonuProductsResponse(
  json: unknown,
  storefrontKey: SnoonuStorefrontKey,
): DiscoveryCandidate[] {
  if (!isRecord(json)) return [];
  const data = json.data;
  if (!isRecord(data) || !Array.isArray(data.products)) return [];
  const out: DiscoveryCandidate[] = [];
  for (const p of data.products) {
    if (!isRecord(p)) continue;
    const spi = str(p.id);
    if (!spi) continue; // a candidate without a portal id is not addressable
    let name: string | null = null;
    if (Array.isArray(p.locales)) {
      for (const loc of p.locales) {
        if (isRecord(loc)) { name = str(loc.name); if (name) break; }
      }
    }
    let imageUrl: string | null = null;
    if (Array.isArray(p.images)) {
      for (const img of p.images) {
        if (isRecord(img)) { imageUrl = str(img.imageUri); if (imageUrl) break; }
      }
    }
    out.push({
      storefrontKey,
      spi,
      name,
      sku: str(p.sku),
      barcode: str(p.barcode),
      imageUrl,
      imageWidth: null,
      imageHeight: null,
    });
  }
  return out;
}

/** Case-insensitive, trimmed exact-name filter over already-parsed candidates. */
export function filterExactName(candidates: DiscoveryCandidate[], name: string): DiscoveryCandidate[] {
  const target = name.trim().toLowerCase();
  if (target === "") return [];
  return candidates.filter((c) => (c.name ?? "").trim().toLowerCase() === target);
}

/**
 * Trimmed exact-equality barcode filter. The portal's identity search may match
 * loosely; a barcode lookup returns ONLY rows whose own barcode equals the
 * searched term, so a loose portal match can never become a SAFE_MATCH.
 */
export function filterExactBarcode(candidates: DiscoveryCandidate[], barcode: string): DiscoveryCandidate[] {
  const target = barcode.trim();
  if (target === "") return [];
  return candidates.filter((c) => (c.barcode ?? "").trim() === target);
}

/** Trimmed, case-insensitive exact-equality SKU filter (same rationale as barcode). */
export function filterExactSku(candidates: DiscoveryCandidate[], sku: string): DiscoveryCandidate[] {
  const target = sku.trim().toLowerCase();
  if (target === "") return [];
  return candidates.filter((c) => (c.sku ?? "").trim().toLowerCase() === target);
}
