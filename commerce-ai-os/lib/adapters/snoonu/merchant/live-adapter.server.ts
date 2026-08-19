import "server-only";
import type { SnoonuStorefrontKey } from "./merchant-contract";
import type { DiscoveryLookup, SnoonuDiscoveryProvider } from "./discovery-contract";
import type { LiveReadResult, SnoonuLiveSessionReader } from "./session-status";
import {
  SNOONU_PORTAL_ORIGIN,
  SNOONU_PRODUCTS_SEARCH_PATH,
  buildNameSearchBody,
  filterExactName,
  parseSnoonuProductsResponse,
  parseSnoonuSessionConfig,
  type SnoonuSessionConfig,
} from "./live-contract";
import { createDefaultSnoonuDiscoveryProvider } from "./discovery-provider.server";

// MEDIA.1A-P2 — LIVE Snoonu portal adapter (SERVER-ONLY), built strictly from the
// VERIFIED contract in live-contract.ts (operator capture). It performs
// authenticated READS only against the single pinned portal origin:
//
//   POST https://api-portal.snoonu.com/api/marketplace/CatalogManagement/Products
//
// Scope and honesty rules:
//   • NAME search only — the sole verified searchTermType (=2). The barcode and
//     SKU search modes are NOT wired (their searchTermType values are unverified);
//     they return zero candidates WITHOUT any request, so the engine falls
//     through to the verified name search and can never fabricate a SAFE_MATCH.
//   • No Snoonu write of any kind; no image recovery; classification (MEDIA.1B
//     engine) is untouched.
//   • The per-storefront secret env holds a JSON config (businessUnitId + the
//     operator's captured auth headers). It is read here only to authenticate
//     requests — never logged, never serialized, never returned to any caller.
//   • Storefront isolation: each provider/reader is built from ITS storefront's
//     env only; there is no cross-store fallback.

/** Reserved per-storefront secret env NAMES (values live in server env only). */
const SESSION_ENV: Record<SnoonuStorefrontKey, string> = {
  "snoonu:malikas": "SNOONU_MALIKAS_MERCHANT_SESSION",
  "snoonu:pure_seoul": "SNOONU_PURE_SEOUL_MERCHANT_SESSION",
};

const REQUEST_TIMEOUT_MS = 10_000;

type ConfigState =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "ok"; config: SnoonuSessionConfig };

/** Read + parse this storefront's session config. Never logs/echoes the value. */
function readSessionConfig(storefrontKey: SnoonuStorefrontKey): ConfigState {
  const raw = process.env[SESSION_ENV[storefrontKey]];
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "absent" };
  const config = parseSnoonuSessionConfig(raw);
  return config ? { kind: "ok", config } : { kind: "invalid" };
}

type PortalRead =
  | { kind: "ok"; json: unknown }
  | { kind: "unauthorized" }
  | { kind: "timeout" }
  | { kind: "error" };

/** One authenticated POST to the verified Products search endpoint. */
async function postProductsSearch(config: SnoonuSessionConfig, searchTerm: string): Promise<PortalRead> {
  try {
    const res = await fetch(SNOONU_PORTAL_ORIGIN + SNOONU_PRODUCTS_SEARCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.headers },
      body: JSON.stringify(buildNameSearchBody(config.businessUnitId, searchTerm)),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };
    if (!res.ok) return { kind: "error" };
    try {
      return { kind: "ok", json: await res.json() };
    } catch {
      return { kind: "error" };
    }
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") return { kind: "timeout" };
    return { kind: "error" };
  }
}

/** Honest lookup for a search mode whose portal contract is not verified yet. */
const modeNotWired = (): Promise<DiscoveryLookup> =>
  Promise.resolve({ state: "authenticated", candidates: [] });

/**
 * The LIVE discovery provider for ONE storefront. Requires a parsed config.
 * One portal request per distinct name (memoized within this provider instance,
 * i.e. per request scope) — exact-name and contains-name reuse the same read.
 */
export function createLiveSnoonuDiscoveryProvider(
  storefrontKey: SnoonuStorefrontKey,
  config: SnoonuSessionConfig,
): SnoonuDiscoveryProvider {
  const memo = new Map<string, Promise<PortalRead>>();
  const search = (term: string): Promise<PortalRead> => {
    let p = memo.get(term);
    if (!p) { p = postProductsSearch(config, term); memo.set(term, p); }
    return p;
  };

  const nameLookup = async (name: string): Promise<DiscoveryLookup> => {
    const read = await search(name);
    if (read.kind === "unauthorized") return { state: "session_required", candidates: [] };
    if (read.kind !== "ok") return { state: "error", candidates: [], error: "Snoonu portal read failed." };
    return { state: "authenticated", candidates: parseSnoonuProductsResponse(read.json, storefrontKey) };
  };

  return {
    storefrontKey,
    // Configured ⇒ eligible to search; the truthful auth proof is each read's
    // own outcome (a dead session surfaces as SESSION_REQUIRED per lookup).
    state: async () => "authenticated",
    // NOT WIRED: barcode/SKU searchTermType values are unverified. No request
    // is made and no candidate is returned — the engine falls through to the
    // verified name search (which can only ever yield NEEDS_REVIEW).
    findByBarcode: () => modeNotWired(),
    findBySku: () => modeNotWired(),
    searchExactName: async (name) => {
      const lk = await nameLookup(name);
      if (lk.state !== "authenticated") return lk;
      return { state: "authenticated", candidates: filterExactName(lk.candidates, name) };
    },
    searchContainsName: (name) => nameLookup(name),
  };
}

/**
 * Provider factory used as the pipeline default: live when this storefront's
 * config is provisioned + parseable, otherwise the inert SESSION_REQUIRED
 * default (absent) or an error-reporting provider (present but malformed).
 */
export function createConfiguredSnoonuDiscoveryProvider(storefrontKey: SnoonuStorefrontKey): SnoonuDiscoveryProvider {
  const cfg = readSessionConfig(storefrontKey);
  if (cfg.kind === "ok") return createLiveSnoonuDiscoveryProvider(storefrontKey, cfg.config);
  if (cfg.kind === "absent") return createDefaultSnoonuDiscoveryProvider(storefrontKey);
  // Secret present but not the documented JSON shape: surface a truthful error
  // (never treated as authenticated, never fabricates results).
  const invalid = (): Promise<DiscoveryLookup> =>
    Promise.resolve({ state: "error", candidates: [], error: "Snoonu session config is invalid." });
  return {
    storefrontKey,
    state: async () => "error",
    findByBarcode: invalid,
    findBySku: invalid,
    searchExactName: invalid,
    searchContainsName: invalid,
  };
}

/**
 * The live session reader for the Connection Manager: proves the session by a
 * real authenticated read (bounded, read-only). Returns null when no secret is
 * provisioned — CONNECTED stays unreachable without proof.
 */
export function createConfiguredLiveSessionReader(storefrontKey: SnoonuStorefrontKey): SnoonuLiveSessionReader | null {
  const cfg = readSessionConfig(storefrontKey);
  if (cfg.kind === "absent") return null;
  if (cfg.kind === "invalid") return async (): Promise<LiveReadResult> => ({ outcome: "error" });
  return async (): Promise<LiveReadResult> => {
    const read = await postProductsSearch(cfg.config, "a");
    if (read.kind === "ok") return { outcome: "ok" };
    if (read.kind === "unauthorized") return { outcome: "expired" };
    if (read.kind === "timeout") return { outcome: "timeout" };
    return { outcome: "error" };
  };
}
