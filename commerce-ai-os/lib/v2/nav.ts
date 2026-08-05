// Malikas V2 navigation model (Phase UI.3C review fix).
//
// Pure and framework-free: the sidebar's link list plus the rule that decides
// which link is highlighted. Kept out of the .tsx component so the rule is
// directly unit-testable (node's type stripping cannot load .tsx).

export interface V2NavLink {
  href: string;
  label: string;
  icon: "catalog" | "shopify";
}

/** The V2 sidebar links, in display order. */
export const V2_NAV_LINKS: readonly V2NavLink[] = [
  { href: "/v2/catalog", label: "كتالوج ماليكاس", icon: "catalog" },
  { href: "/v2/catalog/shopify", label: "كتالوج Shopify", icon: "shopify" },
];

/**
 * Pick the highlighted link: the LONGEST link href that the current path either
 * equals or sits underneath (matching on a full path segment, so `/v2/catalogue`
 * never matches `/v2/catalog`).
 *
 * Longest-match-wins is what keeps this extensible. A parent link stays active
 * for its own sub-pages (`/v2/catalog/<product-id>` → كتالوج ماليكاس) but is
 * superseded by any more specific link — including platform links added to
 * V2_NAV_LINKS later, which will claim their own subtree without ever
 * re-lighting the Malikas link above them.
 *
 * Returns the winning href, or null when nothing matches.
 */
export function activeNavHref(
  pathname: string | null | undefined,
  links: readonly V2NavLink[] = V2_NAV_LINKS,
): string | null {
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  let best: string | null = null;
  for (const link of Array.isArray(links) ? links : []) {
    const href = link?.href;
    if (typeof href !== "string" || href.length === 0) continue;
    const isMatch = pathname === href || pathname.startsWith(`${href}/`);
    if (!isMatch) continue;
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}
