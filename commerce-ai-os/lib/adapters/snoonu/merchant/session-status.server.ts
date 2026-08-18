import "server-only";
import { SNOONU_STOREFRONT_KEYS } from "./merchant-contract";
import type { SnoonuStorefrontKey } from "./merchant-contract";
import { runSnoonuSessionTest } from "./session-status";
import type { SnoonuLiveSessionReader, SnoonuSessionStatus } from "./session-status";

// MEDIA.1A-P — server-only Snoonu session-status layer.
//
// Detects whether a per-storefront session SECRET is configured (PRESENCE ONLY —
// never the value, length, or a hash) and runs a read-only session test. The
// authenticated live read is an INJECTED, storefront-scoped reader that only
// exists once an operator confirms the real Snoonu portal contract; there is NO
// default live reader here (no confirmed endpoint = no HTTP call, no fabrication),
// so a configured secret resolves to UNKNOWN, never CONNECTED. Secret material is
// never returned, serialized, or logged. Storefronts are fully isolated — one
// storefront's secret/reader is NEVER used for the other.

/** Reserved per-storefront secret env NAMES (isolated; values live in server env only). */
const SESSION_ENV: Record<SnoonuStorefrontKey, string> = {
  "snoonu:malikas": "SNOONU_MALIKAS_MERCHANT_SESSION",
  "snoonu:pure_seoul": "SNOONU_PURE_SEOUL_MERCHANT_SESSION",
};

/** Presence check only — returns a boolean, never the secret value/length/hash. */
export function isSnoonuSessionConfigured(storefrontKey: SnoonuStorefrontKey): boolean {
  const raw = process.env[SESSION_ENV[storefrontKey]];
  return typeof raw === "string" && raw.trim().length > 0;
}

export interface SessionTestDeps {
  /** Test override for `configured` (unit tests only). */
  configured?: boolean;
  /**
   * The storefront-scoped live reader. A future MEDIA.1A-P live adapter injects
   * this once the real portal contract is confirmed. Omitted → no live read is
   * performed (UNKNOWN when a secret is present).
   */
  liveReader?: SnoonuLiveSessionReader | null;
}

/**
 * Read-only session test for ONE storefront. Uses ONLY that storefront's secret
 * and reader — never falls back to the other storefront. Never returns secrets.
 */
export async function testSnoonuSession(
  storefrontKey: SnoonuStorefrontKey,
  deps: SessionTestDeps = {},
): Promise<SnoonuSessionStatus> {
  const configured = deps.configured ?? isSnoonuSessionConfigured(storefrontKey);
  const liveReader = deps.liveReader ?? null; // no confirmed contract ⇒ no default live reader
  return runSnoonuSessionTest(storefrontKey, configured, liveReader);
}

/** Both storefronts' statuses for the Connection Manager (independent, isolated). */
export async function loadSnoonuConnectionStatuses(
  deps?: Partial<Record<SnoonuStorefrontKey, SessionTestDeps>>,
): Promise<SnoonuSessionStatus[]> {
  return Promise.all(
    SNOONU_STOREFRONT_KEYS.map((key) => testSnoonuSession(key, deps?.[key] ?? {})),
  );
}
