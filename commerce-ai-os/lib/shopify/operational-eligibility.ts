// THE single rule for "may this Shopify product be selected as the operational
// target of a write?" — pure, no I/O, no `server-only`, so every consumer and
// every test can import it.
//
// WHY THIS EXISTS
// ---------------
// Retiring a duplicate on Shopify means ARCHIVING it, not deleting it. An
// archived shell keeps its SKU and its title, so after a de-duplication the
// store legitimately holds TWO products answering to the same SKU — one live,
// one retired. Every matcher that resolved a SKU with "take the first result"
// was therefore one Shopify ordering change away from writing inventory to, or
// re-activating, a product that was deliberately retired.
//
// THE SEPARATION THIS FILE ENFORCES
// ---------------------------------
//   A. HISTORICAL / ADMIN reads  — still see every product, archived included.
//      Audit screens, "only on Shopify" listings and gid-keyed lookups must not
//      lose retired records; they carry `status` and can show it.
//   B. OPERATIONAL matching      — the candidate set a write may land on. This
//      file is the only definition of that set.
//
// Never widen A into B by reusing a historical index as a match source. Build
// the operational index with `buildOperationalIndex` (or resolve one identity
// with `selectOperational`) and let ambiguity FAIL CLOSED.

/** Shopify's retired status. An archived product is never an operational target. */
export const SHOPIFY_ARCHIVED_STATUS = "ARCHIVED";

/** Anything carrying a Shopify product status string. */
export interface ShopifyStatusBearing {
  status?: string | null;
}

/** Why a resolution produced no operational target. `OK` ⇒ exactly one. */
export type OperationalReason =
  | "OK"
  /** No candidate carried this identity at all. */
  | "NONE"
  /** Candidates existed but every one of them is ARCHIVED (retired identity). */
  | "ARCHIVED_ONLY"
  /** Two or more DISTINCT eligible products carry this identity — fail closed. */
  | "AMBIGUOUS";

export type OperationalSelection<T> =
  | { ok: true; reason: "OK"; match: T; eligible: number; archived: number }
  | { ok: false; reason: Exclude<OperationalReason, "OK">; match: null; eligible: number; archived: number };

/** Upper-cased, trimmed status. Unknown/missing → "" (treated as eligible). */
export function normalizeShopifyStatus(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * The rule. A product is operational unless Shopify says it is ARCHIVED.
 *
 * DRAFT stays eligible on purpose: a draft is an unfinished live product and
 * several flows legitimately write to one (that is how the publisher creates
 * products). ARCHIVED is the only status that means "retired identity".
 */
export function isOperationalShopifyProduct(product: ShopifyStatusBearing | null | undefined): boolean {
  if (!product) return false;
  return normalizeShopifyStatus(product.status) !== SHOPIFY_ARCHIVED_STATUS;
}

/** Convenience for call sites that only hold the raw status string. */
export function isOperationalShopifyStatus(status: unknown): boolean {
  return normalizeShopifyStatus(status) !== SHOPIFY_ARCHIVED_STATUS;
}

/**
 * Pick THE operational product for one identity (a SKU, a normalized title…).
 *
 * Order-independent by construction — the input order never decides the answer:
 *   1. drop every ARCHIVED candidate;
 *   2. collapse candidates that are the same product (`identityOf`, default:
 *      the `status` object itself is not enough, so callers pass the product id);
 *   3. exactly one distinct eligible product  → select it;
 *   4. more than one, but exactly one of them ACTIVE → select that one (the
 *      documented ACTIVE preference: a live product always outranks a draft);
 *   5. anything else → AMBIGUOUS, and NOTHING is selected.
 *
 * There is deliberately no "first wins" branch.
 */
export function selectOperational<T extends ShopifyStatusBearing>(
  candidates: readonly T[],
  identityOf: (candidate: T) => string,
): OperationalSelection<T> {
  const all = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const eligible: T[] = [];
  const seen = new Set<string>();
  let archived = 0;

  for (const c of all) {
    if (!isOperationalShopifyProduct(c)) { archived++; continue; }
    const key = identityOf(c);
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(c);
  }

  if (eligible.length === 1) {
    return { ok: true, reason: "OK", match: eligible[0]!, eligible: 1, archived };
  }
  if (eligible.length === 0) {
    const reason = archived > 0 ? "ARCHIVED_ONLY" : "NONE";
    return { ok: false, reason, match: null, eligible: 0, archived };
  }

  const active = eligible.filter((c) => normalizeShopifyStatus(c.status) === "ACTIVE");
  if (active.length === 1) {
    return { ok: true, reason: "OK", match: active[0]!, eligible: eligible.length, archived };
  }
  return { ok: false, reason: "AMBIGUOUS", match: null, eligible: eligible.length, archived };
}

/**
 * Group candidates by identity key, then resolve each group with
 * `selectOperational`. Keys whose group failed to resolve are reported in
 * `blocked` with the reason — they are ABSENT from `resolved`, so a caller that
 * only reads `resolved` fails closed automatically.
 */
export function buildOperationalIndex<T extends ShopifyStatusBearing>(
  candidates: readonly T[],
  keysOf: (candidate: T) => readonly string[],
  identityOf: (candidate: T) => string,
): { resolved: Map<string, T>; blocked: Map<string, Exclude<OperationalReason, "OK">> } {
  const groups = new Map<string, T[]>();
  for (const c of Array.isArray(candidates) ? candidates.filter(Boolean) : []) {
    for (const raw of keysOf(c)) {
      const key = String(raw ?? "");
      if (key === "") continue;
      const bucket = groups.get(key);
      if (bucket) bucket.push(c); else groups.set(key, [c]);
    }
  }

  const resolved = new Map<string, T>();
  const blocked = new Map<string, Exclude<OperationalReason, "OK">>();
  for (const [key, bucket] of groups) {
    const sel = selectOperational(bucket, identityOf);
    if (sel.ok) resolved.set(key, sel.match);
    else blocked.set(key, sel.reason);
  }
  return { resolved, blocked };
}
