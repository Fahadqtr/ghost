import "server-only";
// CH.6D — Snoonu barcode evidence SOURCE port (SERVER-ONLY, READ-ONLY).
//
// The deterministic barcode evidence for a Snoonu listing comes from (in the
// spec's priority order): (1) a live Snoonu merchant session, (2) the official
// export files, (3) the persisted ECL mapping (external_channel_listings
// .exported_barcode). The export files carry NO barcode column, and the ECL
// exported_barcode is the persisted evidence read directly by the orchestrator.
// This port models source (1): the live merchant session, keyed by SPI.
//
// Like CH.6B/6C, no live portal session is provisioned by default — the default
// source reports `session_required` and yields NO barcodes, so barcode completion
// is a safe no-op until a real session is injected at live-activation time. This
// file holds no automation and no credentials.

import {
  type SnoonuStorefrontKey,
  type MerchantSessionState,
} from "../merchant/merchant-contract.ts";

/** Read-only live barcode source PORT (keyed by the storefront's SPI). */
export interface SnoonuBarcodeSource {
  readonly storefront: SnoonuStorefrontKey;
  /** Session lifecycle. Only `authenticated` yields live barcodes. */
  state(): Promise<MerchantSessionState>;
  /** SPI → raw barcode as seen on the live storefront listing. */
  barcodeBySpi(): Promise<Map<string, string>>;
}

/**
 * Default source: no live Snoonu portal session (mirrors CH.6B/6C). Reports
 * `session_required` and an EMPTY map, so only persisted ECL evidence (if any)
 * is used and completion stays a safe no-op until a real session is injected.
 */
export function createSnoonuBarcodeSource(
  storefront: SnoonuStorefrontKey,
): SnoonuBarcodeSource {
  return {
    storefront,
    async state() {
      return "session_required" as MerchantSessionState;
    },
    async barcodeBySpi() {
      return new Map<string, string>();
    },
  };
}
