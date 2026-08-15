import "server-only";
// CH.6B — Snoonu merchant session factory (SERVER-ONLY).
//
// AUTH DESIGN (§2): merchant credentials/session material live in SERVER env,
// never in source or client bundles, and are NEVER logged. Malikas and Pure Seoul
// are isolated via distinct env configuration. OTP/MFA is surfaced (otp_required),
// never bypassed.
//
// MECHANISM (§13): the connector is designed API/network-first (authenticated
// merchant requests), with stable-DOM browser automation as a documented
// fallback — NEVER visual-coordinate automation. CH.6B ships the CONTRACT and a
// safe default that reports `session_required`, so nothing ever runs against a
// guessed/unverified portal. Live wiring is added when an operator provisions a
// session from a real network/DOM capture; inject a custom SnoonuMerchantSession
// then (the orchestrator accepts one).

import {
  type ListingLookupResult,
  type MerchantSessionState,
  type SnoonuMerchantSession,
  type SnoonuStorefrontKey,
} from "./merchant-contract.ts";

// Isolation contract: each storefront reads its OWN server-side session config.
// (Names documented; the default does not depend on their contents.)
const SESSION_ENV: Record<SnoonuStorefrontKey, string> = {
  "snoonu:malikas": "SNOONU_MALIKAS_MERCHANT_SESSION",
  "snoonu:pure_seoul": "SNOONU_PURE_SEOUL_MERCHANT_SESSION",
};

/**
 * Default merchant session — safe/no-op until live portal wiring is provisioned.
 * Always reports session_required so no scan/apply ever fetches from an
 * unverified portal contract. Never stores or logs credentials/cookies.
 */
export function createSnoonuMerchantSession(storefrontKey: SnoonuStorefrontKey): SnoonuMerchantSession {
  // Reference the isolated env name so the isolation contract is explicit; the
  // value is intentionally NOT logged and NOT used to fake authentication.
  void SESSION_ENV[storefrontKey];
  return {
    storefrontKey,
    async state(): Promise<MerchantSessionState> {
      return "session_required"; // live wiring flips this to authenticated/otp_required
    },
    async findListingBySpi(_spi: string): Promise<ListingLookupResult> {
      return { state: "session_required", listing: null, error: "Snoonu merchant session not established." };
    },
  };
}
