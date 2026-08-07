// Malikas V2 navigation model (Phase UI.3C review fix).
//
// Pure and framework-free: the sidebar's link list plus the rule that decides
// which link is highlighted. Kept out of the .tsx component so the rule is
// directly unit-testable (node's type stripping cannot load .tsx).

export interface V2NavLink {
  href: string;
  label: string;
  icon: "catalog" | "shopify" | "rewards" | "operations";
  /** Heading this link sits under in the sidebar. */
  section: string;
  /**
   * True when the link leaves the V2 shell for the legacy interface. Those
   * pages are fully working today and are NOT in the legacy-redirect list, so
   * they are linked rather than reimplemented — but the sidebar marks them so
   * the change of shell is not a surprise.
   */
  external?: true;
}

/** The V2 sidebar links, in display order. */
export const V2_NAV_LINKS: readonly V2NavLink[] = [
  { href: "/v2/catalog", label: "كتالوج ماليكاس", icon: "catalog", section: "الكتالوج" },
  { href: "/v2/catalog/shopify", label: "كتالوج Shopify", icon: "shopify", section: "الكتالوج" },

  // Operations Center (Phase UI.7.2/7.3) — reads lib/operations/* engines.
  { href: "/v2/operations", label: "لوحة العمليات", icon: "operations", section: "العمليات" },
  { href: "/v2/tasks", label: "المهام", icon: "operations", section: "العمليات" },

  // «مكافآت الجمال» (Beauty Rewards) — the customer page calls it
  // «دليل المسابقة». These pages now live INSIDE the V2 route group, so they
  // render in the V2 shell instead of the legacy AppShell.
  { href: "/v2/loyalty", label: "مكافآت الجمال", icon: "rewards", section: "العملاء" },
  { href: "/v2/loyalty/customers", label: "الزبائن", icon: "rewards", section: "العملاء" },
  { href: "/v2/loyalty/prizes", label: "الجوائز", icon: "rewards", section: "العملاء" },
  { href: "/v2/loyalty/cards", label: "بطاقات للطباعة", icon: "rewards", section: "العملاء" },
  { href: "/v2/loyalty/qr", label: "بطاقة QR", icon: "rewards", section: "العملاء" },
  // The customer card stays OUTSIDE V2 on purpose: /rewards is public (listed in
  // the middleware PUBLIC_PATHS) and is reached from the printed QR, so moving
  // it behind the V2 auth gate would break it for customers.
  { href: "/rewards", label: "صفحة العميل", icon: "rewards", section: "العملاء", external: true },
];

export interface V2NavSection {
  title: string;
  links: V2NavLink[];
}

/**
 * Group the links by section, preserving both the section order and the link
 * order in which they were declared. Beauty Rewards is not a catalog entry, so
 * it must not render under the "الكتالوج" heading.
 */
export function groupNavLinks(links: readonly V2NavLink[] = V2_NAV_LINKS): V2NavSection[] {
  const sections: V2NavSection[] = [];
  for (const link of Array.isArray(links) ? links : []) {
    if (link === null || typeof link !== "object") continue;
    const title = typeof link.section === "string" && link.section.length > 0 ? link.section : "";
    const existing = sections.find((s) => s.title === title);
    if (existing) existing.links.push(link);
    else sections.push({ title, links: [link] });
  }
  return sections;
}

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
