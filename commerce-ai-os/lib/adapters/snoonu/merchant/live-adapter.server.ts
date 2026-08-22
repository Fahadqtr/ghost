import "server-only";
import type { SnoonuStorefrontKey } from "./merchant-contract";
import type { DiscoveryCandidate, DiscoveryLookup, SnoonuDiscoveryProvider } from "./discovery-contract";
import type { LiveReadResult, SnoonuLiveSessionReader } from "./session-status";
import {
  SNOONU_PORTAL_ORIGIN,
  SNOONU_PRODUCTS_SEARCH_PATH,
  buildIdentitySearchBody,
  buildNameSearchBody,
  filterExactBarcode,
  filterExactName,
  filterExactSku,
  mapIdentityLookupState,
  mapProbeState,
  parseSnoonuProductsResponse,
  parseSnoonuSessionConfig,
  summarizeSnoonuResponseShape,
  type SnoonuProductsSearchBody,
  type SnoonuResponseShape,
  type SnoonuSessionConfig,
} from "./live-contract";
import { createDefaultSnoonuDiscoveryProvider } from "./discovery-provider.server";

// MEDIA.1A-P2/P3 — LIVE Snoonu portal adapter (SERVER-ONLY), built strictly from
// the VERIFIED contract in live-contract.ts (operator captures). It performs
// authenticated READS only against the single pinned portal origin:
//
//   POST https://api-portal.snoonu.com/api/marketplace/CatalogManagement/Products
//
// Scope and honesty rules:
//   • All three verified search modes are wired: barcode + SKU use the verified
//     identity searchTermType (=1, via buildIdentitySearchBody) and NAME uses the
//     verified searchTermType (=2, via buildNameSearchBody). Barcode/SKU lookups
//     return ONLY exact-equality rows, so a loose portal match can never become
//     a SAFE_MATCH. The MEDIA.1B search order/classification is untouched.
//   • No Snoonu write of any kind; no image recovery.
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

/** Config KIND only ("ok"|"absent"|"invalid") for dev tracing/tests — never the value. */
export function getSnoonuSessionConfigState(storefrontKey: SnoonuStorefrontKey): "ok" | "absent" | "invalid" {
  return readSessionConfig(storefrontKey).kind;
}

type PortalRead =
  | { kind: "ok"; json: unknown }
  | { kind: "unauthorized" }
  | { kind: "timeout" }
  | { kind: "error" };

/** One authenticated POST to the verified Products search endpoint. */
async function postProductsSearch(config: SnoonuSessionConfig, body: SnoonuProductsSearchBody): Promise<PortalRead> {
  try {
    const res = await fetch(SNOONU_PORTAL_ORIGIN + SNOONU_PRODUCTS_SEARCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.headers },
      body: JSON.stringify(body),
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

/**
 * MEDIA.1C-HOTFIX3 — per-lookup evidence emitted by the live provider. The
 * batch scan collects these to expose, per candidate and per mode, whether the
 * mode was attempted, its transport outcome, and raw vs exact-filtered counts.
 * Product terms/counts only — never config or header material.
 */
export type LiveLookupTrace = {
  mode: "barcode" | "sku" | "name";
  term: string;
  read: PortalRead["kind"];
  rawCount: number;
  exactCount: number;
};

/**
 * The LIVE discovery provider for ONE storefront. Requires a parsed config.
 * One portal request per distinct (searchTermType, term) pair (memoized within
 * this provider instance, i.e. per request scope) — exact-name and contains-name
 * reuse the same read. `trace` (optional) is invoked after every lookup, memo
 * hits included, so a batch scan can attribute evidence per candidate term.
 */
export function createLiveSnoonuDiscoveryProvider(
  storefrontKey: SnoonuStorefrontKey,
  config: SnoonuSessionConfig,
  trace?: (t: LiveLookupTrace) => void,
): SnoonuDiscoveryProvider {
  const memo = new Map<string, Promise<PortalRead>>();
  const search = (body: SnoonuProductsSearchBody): Promise<PortalRead> => {
    const key = `${body.searchTermType}:${body.searchTerm}`;
    let p = memo.get(key);
    if (!p) { p = postProductsSearch(config, body); memo.set(key, p); }
    return p;
  };

  // MEDIA.1C-HOTFIX: ONE session probe per provider instance — the SAME
  // name-mode request the Connection Manager's Test Connection performs, so
  // discovery and Test Connection prove the session identically (single
  // resolver, single env source). Memoized: at most one probe per scan.
  let probePromise: Promise<PortalRead> | null = null;
  const probe = (): Promise<PortalRead> => {
    if (!probePromise) probePromise = postProductsSearch(config, buildNameSearchBody(config.businessUnitId, "a"));
    return probePromise;
  };
  const sessionAlive = async (): Promise<boolean> => (await probe()).kind === "ok";

  const lookup = async (body: SnoonuProductsSearchBody): Promise<DiscoveryLookup> => {
    const read = await search(body);
    if (read.kind === "unauthorized") return { state: "session_required", candidates: [] };
    if (read.kind !== "ok") return { state: "error", candidates: [], error: "Snoonu portal read failed." };
    return { state: "authenticated", candidates: parseSnoonuProductsResponse(read.json, storefrontKey) };
  };

  // VERIFIED identity search (searchTermType=1, SKU and barcode alike). Only
  // rows whose OWN field equals the searched term survive — exactness is what
  // lets the engine treat a single row as SAFE_MATCH. MEDIA.1C-HOTFIX: a
  // 401/403 on THIS mode is judged against the probe — while the session is
  // provably alive it means "no candidates via this mode" (the engine falls
  // through to the verified name search), never a fabricated dead session.
  const identityLookup = async (
    mode: "barcode" | "sku",
    term: string,
    exact: (candidates: DiscoveryCandidate[], term: string) => DiscoveryCandidate[],
  ): Promise<DiscoveryLookup> => {
    const read = await search(buildIdentitySearchBody(config.businessUnitId, term));
    const state = mapIdentityLookupState(read.kind, read.kind === "unauthorized" ? await sessionAlive() : true);
    const raw = read.kind === "ok" ? parseSnoonuProductsResponse(read.json, storefrontKey) : [];
    const exactRows = exact(raw, term);
    trace?.({ mode, term, read: read.kind, rawCount: raw.length, exactCount: exactRows.length });
    if (state === "error") return { state: "error", candidates: [], error: "Snoonu portal read failed." };
    if (state !== "authenticated") return { state, candidates: [] };
    return { state: "authenticated", candidates: exactRows };
  };

  const nameLookup = async (name: string): Promise<DiscoveryLookup> => {
    const lk = await lookup(buildNameSearchBody(config.businessUnitId, name));
    trace?.({
      mode: "name",
      term: name,
      read: lk.state === "authenticated" ? "ok" : lk.state === "session_required" ? "unauthorized" : "error",
      rawCount: lk.candidates.length,
      exactCount: filterExactName(lk.candidates, name).length,
    });
    return lk;
  };

  return {
    storefrontKey,
    // MEDIA.1C-HOTFIX: state() is a REAL probe (same request as Test
    // Connection) — never a hardcoded "authenticated".
    state: async () => mapProbeState((await probe()).kind),
    findByBarcode: (barcode) => identityLookup("barcode", barcode, filterExactBarcode),
    findBySku: (sku) => identityLookup("sku", sku, filterExactSku),
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
export function createConfiguredSnoonuDiscoveryProvider(
  storefrontKey: SnoonuStorefrontKey,
  trace?: (t: LiveLookupTrace) => void,
): SnoonuDiscoveryProvider {
  const cfg = readSessionConfig(storefrontKey);
  if (cfg.kind === "ok") return createLiveSnoonuDiscoveryProvider(storefrontKey, cfg.config, trace);
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
    const read = await postProductsSearch(cfg.config, buildNameSearchBody(cfg.config.businessUnitId, "a"));
    if (read.kind === "ok") return { outcome: "ok" };
    if (read.kind === "unauthorized") return { outcome: "expired" };
    if (read.kind === "timeout") return { outcome: "timeout" };
    return { outcome: "error" };
  };
}

// ── MEDIA.1C-HOTFIX3 — identity-search diagnostic (owner tooling, READ-ONLY) ──
// Answers, with RUNTIME evidence from the deployed session, why an identity
// search did not SAFE_MATCH: per mode it reports the transport outcome, how
// many rows the portal returned (raw, BEFORE exact filtering), how many survive
// the exact-equality filter, and the portal's OWN identifier values on the
// first row. Product/listing data only — never a header, config, or secret.

export type DiagnosticReadKind = "ok" | "unauthorized" | "timeout" | "error" | "skipped";

export interface SearchModeDiagnostic {
  mode: "barcode" | "sku" | "name";
  /** False when the mode had no term to search or the session config is unusable. */
  attempted: boolean;
  /** The searched term (internal product data — not secret). Null = nothing to search. */
  term: string | null;
  read: DiagnosticReadKind;
  /** Rows parsed from the portal response BEFORE any exact filter. */
  rawCount: number;
  /** Rows surviving the exact-equality filter (name mode: exact-name matches). */
  exactCount: number;
  /** The FIRST raw row's identifiers as the portal returned them. */
  sample: { spi: string | null; sku: string | null; barcode: string | null; name: string | null } | null;
  /** Structural metadata only: paths, field names and array counts; no values. */
  responseShape: SnoonuResponseShape | null;
}

export interface SnoonuSearchDiagnostic {
  storefrontKey: SnoonuStorefrontKey;
  configState: "ok" | "absent" | "invalid";
  probe: DiagnosticReadKind;
  modes: SearchModeDiagnostic[];
}

export async function diagnoseSnoonuSearchModes(
  storefrontKey: SnoonuStorefrontKey,
  q: { barcode: string | null; sku: string | null; name: string | null },
): Promise<SnoonuSearchDiagnostic> {
  const cfg = readSessionConfig(storefrontKey);
  const skippedAll = (probe: DiagnosticReadKind): SnoonuSearchDiagnostic => ({
    storefrontKey,
    configState: cfg.kind,
    probe,
    modes: (["barcode", "sku", "name"] as const).map((mode) => ({
      mode, attempted: false, term: null, read: "skipped", rawCount: 0, exactCount: 0, sample: null, responseShape: null,
    })),
  });
  if (cfg.kind !== "ok") return skippedAll("skipped");
  const config = cfg.config;

  const probeRead = await postProductsSearch(config, buildNameSearchBody(config.businessUnitId, "a"));

  const runMode = async (
    mode: SearchModeDiagnostic["mode"],
    term: string | null,
    body: (t: string) => SnoonuProductsSearchBody,
    exact: (c: DiscoveryCandidate[], t: string) => DiscoveryCandidate[],
  ): Promise<SearchModeDiagnostic> => {
    if (!term || term.trim() === "") return { mode, attempted: false, term: null, read: "skipped", rawCount: 0, exactCount: 0, sample: null, responseShape: null };
    const read = await postProductsSearch(config, body(term));
    if (read.kind !== "ok") return { mode, attempted: true, term, read: read.kind, rawCount: 0, exactCount: 0, sample: null, responseShape: null };
    const raw = parseSnoonuProductsResponse(read.json, storefrontKey);
    const first = raw[0] ?? null;
    return {
      mode,
      attempted: true,
      term,
      read: "ok",
      rawCount: raw.length,
      exactCount: exact(raw, term).length,
      sample: first ? { spi: first.spi, sku: first.sku, barcode: first.barcode, name: first.name } : null,
      responseShape: summarizeSnoonuResponseShape(read.json),
    };
  };

  const b = (t: string) => buildIdentitySearchBody(config.businessUnitId, t);
  const n = (t: string) => buildNameSearchBody(config.businessUnitId, t);
  return {
    storefrontKey,
    configState: cfg.kind,
    probe: probeRead.kind,
    modes: [
      await runMode("barcode", q.barcode, b, filterExactBarcode),
      await runMode("sku", q.sku, b, filterExactSku),
      await runMode("name", q.name, n, filterExactName),
    ],
  };
}
