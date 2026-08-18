// Malikas V2 navigation model (Phase NAV.1 — Unified Navigation Refresh).
//
// Pure and framework-free: the sidebar's link list plus the rules that decide
// which link (and which group heading) is highlighted. Kept out of the .tsx
// component so the rules are directly unit-testable (node's type stripping
// cannot load .tsx).
//
// NAV.1 makes every completed platform discoverable: the Operations group now
// surfaces the OPS sub-centers (Media, Channels, AI, Health) and a new
// «التحليلات» group surfaces the BI.2 Executive Dashboard. This is a
// navigation-only change — no new routes are minted (every href points at a
// page that already ships) and no route is ever renamed.

export type V2NavIcon =
  | "home"
  | "catalog"
  | "shopify"
  | "rewards"
  | "operations"
  | "media"
  | "channels"
  | "ai"
  | "health"
  | "analytics"
  | "export";

export interface V2NavLink {
  href: string;
  label: string;
  icon: V2NavIcon;
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
  // HOME.1 — the Executive Home Dashboard is the V2 entry point (/v2). Read-only;
  // composes the certified read models. First link so it heads the sidebar.
  { href: "/v2", label: "الرئيسية", icon: "home", section: "الرئيسية" },

  { href: "/v2/catalog", label: "كتالوج ماليكاس", icon: "catalog", section: "الكتالوج" },
  { href: "/v2/catalog/shopify", label: "كتالوج Shopify", icon: "shopify", section: "الكتالوج" },
  // WAVE.1A — Launch Campaign Workspace (read-only operational screen).
  { href: "/v2/catalog/launch", label: "حملة الإطلاق", icon: "operations", section: "الكتالوج" },

  // Operations Center (Phase UI.7.2/7.3) — reads lib/operations/* engines.
  // Label matches the page's own H1 «مركز العمليات» (UX.1 discoverability).
  { href: "/v2/operations", label: "مركز العمليات", icon: "operations", section: "العمليات" },
  // NAV.1 — surface the OPS sub-centers so every completed operations platform
  // is discoverable from the shell (they previously had no top-level entry and
  // were reachable only via deep-links from the Operations Center). All four are
  // existing V2 pages; nothing is renamed.
  { href: "/v2/operations/media", label: "مركز الصور", icon: "media", section: "العمليات" },
  { href: "/v2/operations/channels", label: "مركز القنوات", icon: "channels", section: "العمليات" },
  { href: "/v2/operations/ai", label: "مركز الذكاء الاصطناعي", icon: "ai", section: "العمليات" },
  { href: "/v2/operations/health", label: "صحة المنصة", icon: "health", section: "العمليات" },
  // Export Center (Phase INT.2A) — the unified outbound export/publish entry
  // point. Read-only foundation; a new V2 page (legacy /import-export stays).
  { href: "/v2/export", label: "مركز التصدير", icon: "export", section: "العمليات" },
  { href: "/v2/tasks", label: "المهام", icon: "operations", section: "العمليات" },

  // Analytics (Phase NAV.1) — the BI.2 Executive Dashboard. New group; the page
  // ships already (merged in BI.2) and simply had no menu entry.
  { href: "/v2/analytics", label: "لوحة الإدارة", icon: "analytics", section: "التحليلات" },
  // Action Center (Phase AI.1) — the owner-first hub that aggregates actionable
  // items from the certified OPS + BI read models. In-shell, read-only.
  { href: "/v2/actions", label: "مركز الإجراءات", icon: "analytics", section: "التحليلات" },

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

  // Settings (UX.1) — the TickTick integration browser is a real V2 page that
  // had no menu entry; surface it so it is discoverable. In-shell (not external).
  { href: "/v2/settings/integrations/ticktick", label: "تكاملات TickTick", icon: "operations", section: "الإعدادات" },

  // Extra tools (UX.1) — still-used pages that live in the PREVIOUS interface and
  // are NOT in the legacy-redirect list. Linked (not reimplemented) and marked
  // `external` so the shell change is not a surprise; the ↗ badge is rendered by
  // the sidebar exactly like «صفحة العميل». Only Import/Export this PR.
  { href: "/import-export", label: "الاستيراد والتصدير", icon: "catalog", section: "أدوات إضافية ↗", external: true },
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
    // The shell root ("/v2", the Home dashboard) is EXACT-match only: it must not
    // become a subtree catch-all that lights up on every /v2/* page (or on a
    // foreign path like /v2/catalogue). Every other link keeps segment-prefix
    // matching so a parent stays active on its own sub-pages.
    const isMatch = href === "/v2" ? pathname === "/v2" : pathname === href || pathname.startsWith(`${href}/`);
    if (!isMatch) continue;
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}

/**
 * The section (group heading) that owns the currently-active link, or null when
 * nothing matches. Derived from {@link activeNavHref} so the group highlight can
 * never disagree with the link highlight. Used by the sidebar to mark the active
 * group — including on deep links, where the active link's own section wins.
 */
export function activeNavSection(
  pathname: string | null | undefined,
  links: readonly V2NavLink[] = V2_NAV_LINKS,
): string | null {
  const href = activeNavHref(pathname, links);
  if (href === null) return null;
  const active = (Array.isArray(links) ? links : []).find((l) => l?.href === href);
  return active && typeof active.section === "string" && active.section.length > 0
    ? active.section
    : null;
}
