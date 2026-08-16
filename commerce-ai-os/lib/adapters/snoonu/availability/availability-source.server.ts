import "server-only";
// CH.6C — Snoonu availability SOURCE port (SERVER-ONLY, READ-ONLY).
//
// The genuine source of Snoonu LISTING availability is the Snoonu merchant portal
// (the CH.6B connector), keyed by the storefront's own SPI. It is deliberately NOT
// the `platform_status` overlay: that overlay is the OUTBOUND projection of our
// master availability (lib/availability-sync + /api/cron/availability-sync writes
// every overlay platform identically from products.stock_status), so reading it
// back would be a feedback loop — always "unchanged" — and would misrepresent
// provenance. CH.6C reads the platform's OWN state, never our projection of it.
//
// Like CH.6B, a live portal session is provisioned separately (operator creds,
// OTP). Until then the default source reports `session_required` and yields NO
// availability, so the whole sync is a safe no-op (everything UNKNOWN → skipped).
// A concrete/live or a test source is injected via the orchestrator's `source`
// option — this file holds no automation and no credentials.

import {
  type SnoonuStorefrontKey,
  type MerchantSessionState,
} from "../merchant/merchant-contract.ts";

/** Read-only availability source PORT (keyed by the storefront's SPI). */
export interface SnoonuAvailabilitySource {
  readonly storefront: SnoonuStorefrontKey;
  /** Session lifecycle. Only `authenticated` yields availability. */
  state(): Promise<MerchantSessionState>;
  /**
   * All listings the session can currently see: SPI → raw availability token.
   * Raw tokens are normalized downstream (never guessed). An empty map means
   * "no signal" → every product resolves to UNKNOWN and is skipped.
   */
  listAvailability(): Promise<Map<string, unknown>>;
}

/**
 * Default source: no live Snoonu portal session is provisioned (mirrors CH.6B's
 * default session_required). Reports `session_required` and an EMPTY availability
 * map, so the sync performs no change until a real session is injected at
 * live-activation time.
 */
export function createSnoonuAvailabilitySource(
  storefront: SnoonuStorefrontKey,
): SnoonuAvailabilitySource {
  return {
    storefront,
    async state() {
      return "session_required" as MerchantSessionState;
    },
    async listAvailability() {
      return new Map<string, unknown>();
    },
  };
}
