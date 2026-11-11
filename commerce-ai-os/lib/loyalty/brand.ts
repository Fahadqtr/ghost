// Beauty Rewards — which store a loyalty card belongs to. The same stamp
// system runs for Malika's Universe and for Pure Seoul, but each store has its
// OWN customers, prizes, QR and voucher codes: a Pure Seoul card never shares
// hearts or prizes with a Malika's card, even for the same phone number.
//
// Pure, dependency-free (no `@/` imports) so it runs under node:test and can be
// imported from client components, API routes and lib/loyalty/rewards alike.

export const LOYALTY_BRANDS = ["malikas", "pureseoul"] as const;
export type LoyaltyBrand = (typeof LOYALTY_BRANDS)[number];

/** The pre-existing program. Anything unknown/missing falls back to it. */
export const DEFAULT_BRAND: LoyaltyBrand = "malikas";

export type BrandInfo = {
  /** Store name as shown to customers and in WhatsApp messages. */
  storeName: string;
  /** Spaced wordmark under the logo. */
  wordmark: string;
  /** Prefix of the printable voucher code. */
  voucherPrefix: string;
  /** Public customer page reached from this store's QR. */
  publicPath: string;
  /** Device storage key remembering the customer on that store's page. */
  storageKey: string;
};

export const BRAND_INFO: Record<LoyaltyBrand, BrandInfo> = {
  malikas: {
    storeName: "Malika's Universe",
    wordmark: "MALIKA'S UNIVERSE",
    voucherPrefix: "MU",
    publicPath: "/rewards",
    storageKey: "malika_rewards_id",
  },
  pureseoul: {
    storeName: "Pure Seoul",
    wordmark: "PURE SEOUL",
    voucherPrefix: "PS",
    publicPath: "/rewards/pureseoul",
    storageKey: "pureseoul_rewards_id",
  },
};

/** Strictly parse a brand from untrusted input; unknown → the default. */
export function parseBrand(raw: unknown): LoyaltyBrand {
  return typeof raw === "string" && (LOYALTY_BRANDS as readonly string[]).includes(raw)
    ? (raw as LoyaltyBrand)
    : DEFAULT_BRAND;
}

/** Deterministic, human-readable voucher code for a completed card. */
export function brandVoucherCode(brand: LoyaltyBrand, id: string, cycle: number): string {
  return `${BRAND_INFO[brand].voucherPrefix}-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}-${cycle + 1}`;
}

/** Admin URL helper: keeps `?brand=pureseoul` on links; the default has none. */
export function withBrand(path: string, brand: LoyaltyBrand): string {
  if (brand === DEFAULT_BRAND) return path;
  return `${path}${path.includes("?") ? "&" : "?"}brand=${brand}`;
}
