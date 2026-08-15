// CH.5 Phase D — dual-read identity resolver (PURE, dependency-injected).
//
// Wraps a PRIMARY resolver (the durable external_channel_listings resolver) and a
// FALLBACK resolver (the legacy products.*_id reader) for the switch-over window.
// The primary is authoritative: its result is ALWAYS returned. The fallback is
// consulted ONLY to detect drift, which is reported via onMismatch. It NEVER
// auto-heals and NEVER overrides the primary — legacy stays read-only diagnostics.
//
// PURE: composes two ExternalIdentityResolvers; no DB/network of its own.

import {
  type ExternalIdentityResolver,
  type ExternalListingRef,
  type InternalProductRef,
  type StoreRef,
} from "../adapters/types.ts";

export interface DualReadMismatch {
  storeKey: string;
  productId: string;
  primaryExternalId: string | null;
  fallbackExternalId: string | null;
}

export interface DualReadOptions {
  /** Called when primary and fallback disagree. Diagnostics only — no healing. */
  onMismatch?: (m: DualReadMismatch) => void;
}

/**
 * Build a dual-read resolver. `primary` (ECL) is authoritative; `fallback`
 * (legacy) is compared for drift only. If the fallback read throws, it is
 * ignored — a diagnostic failure must never affect the authoritative answer.
 */
export function createDualReadResolver(
  primary: ExternalIdentityResolver,
  fallback: ExternalIdentityResolver,
  opts: DualReadOptions = {},
): ExternalIdentityResolver {
  return {
    async resolve(store: StoreRef, product: InternalProductRef): Promise<ExternalListingRef> {
      const primaryRef = await primary.resolve(store, product);
      if (opts.onMismatch) {
        try {
          const fb = await fallback.resolve(store, product);
          if ((fb.externalListingId ?? null) !== (primaryRef.externalListingId ?? null)) {
            opts.onMismatch({
              storeKey: store.storeKey,
              productId: product.productId,
              primaryExternalId: primaryRef.externalListingId ?? null,
              fallbackExternalId: fb.externalListingId ?? null,
            });
          }
        } catch {
          /* fallback is diagnostic-only; never let it affect the result */
        }
      }
      return primaryRef; // ECL is authoritative — always returned
    },
  };
}
