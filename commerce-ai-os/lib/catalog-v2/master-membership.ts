// Canonical definition of the Malikas operational master — PURE constants.
//
// The operational product universe is every product holding an ACTIVE
// `snoonu:malikas` row in `external_channel_listings`. Both the catalog reader
// (/v2/catalog) and the Home Dashboard membership provider import these, so the
// two surfaces can never drift onto different definitions.
//
// The master's SIZE is never defined here — it is derived from the data on
// every request.

/** The storefront whose ACTIVE listings define catalog membership. */
export const CATALOG_STOREFRONT_KEY = "snoonu:malikas";
/** Only listings in this mapping state count as membership. */
export const CATALOG_MAPPING_STATUS = "active";
