import "server-only";
// CH.5 Phase D — the DEFAULT external identity resolver (SERVER).
//
// Switches the runtime default to read from external_channel_listings (the
// durable CH.5 identity table) as the PRIMARY, authoritative source. The legacy
// products.*_id columns are retained only as a read-only dual-read FALLBACK for
// drift diagnostics (mismatches are logged, never auto-healed). Legacy columns
// are NOT written and NOT retired here (Phase E).
//
// Adapters call this through the unchanged ExternalIdentityResolver interface —
// they are unaware storage changed.

import { createClient } from "@/lib/supabase/server";
import { type ExternalIdentityResolver } from "@/lib/adapters/types";
import { createDurableIdentityResolver } from "./durable-identity-resolver";
import { createExternalListingReader, type ExternalListingReadClient } from "./external-listing-reader";
import { createLegacyStorefrontResolver } from "./legacy-storefront-resolver";
import { createDualReadResolver } from "./dual-read-identity-resolver";

/**
 * The default resolver: ECL primary (authoritative) + legacy fallback (diagnostic
 * only). Read-only; never mutates any source.
 */
export function getExternalIdentityResolver(): ExternalIdentityResolver {
  // PRIMARY — durable external_channel_listings (RLS select for authenticated).
  const primary = createDurableIdentityResolver(
    createExternalListingReader(createClient() as unknown as ExternalListingReadClient),
  );

  // FALLBACK — legacy products.*_id columns, storefront-mapped, read-only.
  const legacy = createLegacyStorefrontResolver(async (productId) => {
    const { data } = await createClient()
      .from("products")
      .select("snoonu_id, pure_seoul_id, rafeeq_product_id")
      .eq("id", productId)
      .limit(1);
    const row = (Array.isArray(data) ? data[0] : null) as
      | { snoonu_id: string | null; pure_seoul_id: string | null; rafeeq_product_id: string | null }
      | null;
    return row
      ? { snoonu_id: row.snoonu_id ?? null, pure_seoul_id: row.pure_seoul_id ?? null, rafeeq_product_id: row.rafeeq_product_id ?? null }
      : null;
  });

  return createDualReadResolver(primary, legacy, {
    onMismatch: (m) => {
      // Diagnostic only — surfaces drift between ECL and legacy; never heals.
      // eslint-disable-next-line no-console
      console.warn(`[ch5.dual-read] mismatch storefront=${m.storeKey} product=${m.productId} ecl=${m.primaryExternalId} legacy=${m.fallbackExternalId}`);
    },
  });
}
