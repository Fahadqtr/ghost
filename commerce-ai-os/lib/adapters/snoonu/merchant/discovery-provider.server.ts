import "server-only";
import type { SnoonuStorefrontKey } from "./merchant-contract";
import type { SnoonuDiscoveryProvider, DiscoveryLookup } from "./discovery-contract";
import { createSnoonuMerchantSession } from "./session.server";

// MEDIA.1B — the DEFAULT Snoonu discovery provider.
//
// It performs NO network request and invents NO Snoonu endpoint. It mirrors the
// merchant session state (which ships `session_required` until a live MEDIA.1A-P
// adapter is injected) and returns zero candidates for every search — so the
// discovery UI honestly shows SESSION_REQUIRED and never fabricates a result.
// A future live adapter implements the same SnoonuDiscoveryProvider interface and
// is injected in place of this default (no change to the engine or the UI).

const sessionRequired = (): DiscoveryLookup => ({ state: "session_required", candidates: [] });

export function createDefaultSnoonuDiscoveryProvider(storefrontKey: SnoonuStorefrontKey): SnoonuDiscoveryProvider {
  const session = createSnoonuMerchantSession(storefrontKey);
  return {
    storefrontKey,
    state: () => session.state(),
    findByBarcode: async () => sessionRequired(),
    findBySku: async () => sessionRequired(),
    searchExactName: async () => sessionRequired(),
    searchContainsName: async () => sessionRequired(),
  };
}
