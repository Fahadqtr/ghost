// Central, pure routing helpers that make Malikas V2 the only active interface.
// DB-free, framework-free, no side effects — safe to unit-test and to import from
// the proxy/middleware. This round only BLOCKS access to the legacy admin entry
// points (it deletes no legacy code); requests to them are redirected to V2.

/** The Executive Home built by HOME.1/HOME.2. */
export const V2_HOME = "/v2";

/** The V2 catalog remains the precise replacement for legacy product routes. */
export const V2_CATALOG = "/v2/catalog";

// Legacy admin entry points that V2 replaces. A path matches when it equals one
// of these or is a sub-path (prefix + "/"). Root "/" is handled explicitly.
// NOTE: deliberately scoped to these entries (not a blanket block of every old
// route) so still-used public/back-office paths — /login, /api/**, /auth/**,
// /staff, /rewards, webhooks, /v2/** — keep working.
const LEGACY_PREFIXES: readonly string[] = ["/products"];

/**
 * Legacy tools that have no equivalent V2 workflow yet. They stay reachable
 * until their own migration phase; in particular, inventory must never be
 * guessed to be a catalog concern merely because both pages list products.
 */
export const NEEDS_MIGRATION_PREFIXES: readonly string[] = ["/inventory"];

export function legacyMigrationStatus(pathname: unknown): "NEEDS_MIGRATION" | null {
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  return NEEDS_MIGRATION_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
    ? "NEEDS_MIGRATION"
    : null;
}

export interface CanonicalRedirectTarget {
  pathname: string;
  /** Context inferred from a legacy path; existing query values win. */
  query?: Readonly<Record<string, string>>;
}

const PLATFORM_CONTEXT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  shopify: { channel: "shopify" },
  talabat: { channel: "talabat" },
  rafeeq: { channel: "rafeeq" },
  pure_seoul: { storefront: "snoonu:pure_seoul" },
};

/** Canonical replacements for critical legacy entry points (UX.CONVERGE.1). */
export function canonicalRedirectTarget(pathname: unknown): CanonicalRedirectTarget | null {
  if (typeof pathname !== "string" || pathname.length === 0 || pathname.startsWith("/v2")) return null;

  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return { pathname: V2_HOME };

  if (pathname === "/platforms") return { pathname: "/v2/operations/channels" };
  const platform = /^\/platforms\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (platform) {
    return {
      pathname: "/v2/operations/channels",
      ...(PLATFORM_CONTEXT[platform] ? { query: PLATFORM_CONTEXT[platform] } : {}),
    };
  }

  if (pathname === "/channels" || pathname.startsWith("/channels/")) {
    return { pathname: "/v2/operations/channels" };
  }
  if (pathname === "/catalog/health") return { pathname: "/v2/operations/health" };
  if (pathname === "/catalog/enrich") return { pathname: "/v2/operations/ai" };
  if (pathname === "/import-export/export") return { pathname: "/v2/export" };

  return null;
}

/** Paths that must NEVER be redirected by the legacy block. */
function isExcludedFromLegacyBlock(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/v2") ||
    pathname.startsWith("/api/") ||
    pathname === "/api" ||
    pathname.startsWith("/auth/") ||
    pathname === "/auth"
  );
}

// ── Precise product-editing targets (UX.4E-9A) ──────────────────────────────
//
// The V2 Create/Edit flow is the ONLY active product-editing runtime. Unlike
// the generic funnel below — which sends a legacy entry point to the V2 HOME —
// these preserve intent: an old create/edit URL lands on the V2 page that
// replaces it, not on the catalog home. Deliberately scoped to create/edit
// only; every other /products path keeps the existing funnel-to-home behavior.
// The id segment is charset-checked (uuid-safe, no separators/encoding); an id
// that fails the check falls through to the generic funnel, exactly as before.
const PRODUCT_ID_SEGMENT_RE = /^[A-Za-z0-9-]+$/;

function productEditingRedirect(pathname: string): string | null {
  if (pathname === "/products/new") return `${V2_CATALOG}/new`;
  const m = /^\/products\/([^/]+)\/edit$/.exec(pathname);
  if (m && PRODUCT_ID_SEGMENT_RE.test(m[1])) return `${V2_CATALOG}/${m[1]}/edit`;
  return null;
}

/**
 * Resolve where a request to the legacy interface should be sent. Product
 * create/edit URLs map to their precise V2 replacements (UX.4E-9A); the root
 * and the other legacy admin entry points return the V2 home; null means the
 * path must be left untouched (V2 routes, auth, APIs, webhooks, other public
 * pages). Never returns a target that would loop (V2 paths are always
 * excluded).
 */
export function legacyRedirectPath(pathname: unknown): string | null {
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  if (isExcludedFromLegacyBlock(pathname)) return null;
  if (pathname === "/") return V2_HOME;
  const productTarget = productEditingRedirect(pathname);
  if (productTarget) return productTarget;
  for (const p of LEGACY_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + "/")) return V2_CATALOG;
  }
  return null;
}

// ── Moved routes (Phase: Beauty Rewards port) ───────────────────────────────
//
// Pages that were RELOCATED into the V2 route group rather than blocked. Unlike
// the legacy block above — which funnels everything to one destination — these
// keep their sub-path, so /loyalty/customers lands on /v2/loyalty/customers and
// an old bookmark still reaches the page it named.
//
// `/rewards` is deliberately NOT here: it is the public customer card opened
// from the printed QR (listed in the middleware PUBLIC_PATHS), and moving it
// behind the V2 auth gate would break it for people with no account.
const MOVED_PREFIXES: readonly { from: string; to: string }[] = [{ from: "/loyalty", to: "/v2/loyalty" }];

/**
 * Resolve a relocated path, preserving the rest of the sub-path. Returns null
 * when nothing moved. The caller must keep the query string — these pages use
 * it for search and filters, unlike the legacy block.
 *
 * The static card artwork lives at /loyalty/beauty-card.png and is served from
 * public/; the proxy matcher excludes image extensions, so it never reaches
 * this function.
 */
export function movedRoutePath(pathname: unknown): string | null {
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  if (pathname.startsWith("/v2")) return null; // already moved — never loop
  for (const { from, to } of MOVED_PREFIXES) {
    if (pathname === from) return to;
    if (pathname.startsWith(from + "/")) return to + pathname.slice(from.length);
  }
  return null;
}

/** True if the string contains any ASCII control character (0x00–0x1F). */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * Open-redirect-safe post-login destination. Accepts ONLY a same-origin absolute
 * path (starts with a single "/", no "//"/"/\" scheme-relative form, no
 * backslashes or control chars); anything else (external URL, non-string,
 * garbage) falls back to the V2 home.
 */
export function safeInternalPath(next: unknown, fallback: string = V2_HOME): string {
  if (typeof next !== "string" || next.length === 0) return fallback;
  if (!next.startsWith("/")) return fallback; // rejects "https://…", "evil.com", etc.
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback; // scheme-relative
  if (next.includes("\\")) return fallback;
  if (hasControlChar(next)) return fallback;
  return next;
}
