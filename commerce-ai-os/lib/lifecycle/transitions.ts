// OPS.8B — product lifecycle transition engine (PURE).
//
// The canonical PRODUCT lifecycle is a small, closed state graph over the three
// STORED states {DRAFT, ACTIVE, STOPPED} (OPS.8A). READY and ARCHIVED are
// DERIVED display states — never stored, never a transition target:
//   • READY   = a DRAFT product that is catalog-complete AND approved
//               (computed by the certified readiness engine, never here).
//   • ARCHIVED= no live products row (a product_archive bundle exists instead).
//
// This module validates the state graph and prerequisites and returns a
// deterministic decision. It performs NO I/O, NO DB writes, NO auth — the
// server boundary (transition.server.ts) does authentication, the current-state
// re-read, the single lifecycle_state write, and the audit append. Framework-
// free (no `@/`, no server-only) so node:test loads it directly.

import type { LifecycleState } from "./state";

/** Derived + stored states shown in the UI. READY/ARCHIVED are never stored. */
export type LifecycleDisplay = "DRAFT" | "READY" | "ACTIVE" | "STOPPED" | "ARCHIVED";

/** Which authorization boundary a transition requires. */
export type TransitionAuthority = "writer" | "owner";

/** A single allowed edge in the lifecycle graph. */
export interface TransitionRule {
  from: LifecycleState;
  to: LifecycleState;
  /** minimum authorization the server boundary must enforce */
  authority: TransitionAuthority;
  /** true ⇒ the product must be derived-READY (complete AND approved) first */
  requiresReady: boolean;
}

/**
 * The certified transition matrix (OPS.8B §2 + §7). Nothing outside this table
 * is a legal transition — no arbitrary string moves.
 *
 *   DRAFT   → ACTIVE   writer, requires READY   (activate a ready product)
 *   ACTIVE  → STOPPED  owner                     (pull from active selling)
 *   ACTIVE  → DRAFT    owner                     (return to editing)
 *   STOPPED → DRAFT    owner                     (reopen for editing)
 *   STOPPED → ACTIVE   owner,  requires READY    (explicit reviewed reactivation)
 */
export const LIFECYCLE_TRANSITION_RULES: readonly TransitionRule[] = [
  { from: "DRAFT", to: "ACTIVE", authority: "writer", requiresReady: true },
  { from: "ACTIVE", to: "STOPPED", authority: "owner", requiresReady: false },
  { from: "ACTIVE", to: "DRAFT", authority: "owner", requiresReady: false },
  { from: "STOPPED", to: "DRAFT", authority: "owner", requiresReady: false },
  { from: "STOPPED", to: "ACTIVE", authority: "owner", requiresReady: true },
] as const;

/** Fixed, safe (non-data) reasons — mirror the house Arabic style. */
export const TRANSITION_MESSAGES = {
  archived: "المنتج مؤرشف — استخدم الاسترجاع للعودة إلى الكتالوج.",
  unchanged: "المنتج بالفعل في هذه الحالة.",
  invalid: "انتقال غير مسموح في دورة حياة المنتج.",
  not_ready: "المنتج غير جاهز للتفعيل — يجب أن يكون مكتملاً ومعتمداً.",
} as const;

export type TransitionCode = "OK" | "UNCHANGED" | "INVALID" | "BLOCKED" | "ARCHIVED";

export interface TransitionDecision {
  code: TransitionCode;
  /** true only when the transition may proceed to a write */
  allowed: boolean;
  /** the authority the boundary must enforce for this edge (null when no edge) */
  authority: TransitionAuthority | null;
  /** fixed reason strings explaining a non-OK decision */
  reasons: string[];
}

/** Context the pure engine needs — all already computed by the caller. */
export interface LifecycleContext {
  /** derived READY: catalog-complete AND approved (readiness.readyToPublish) */
  ready: boolean;
  /** true ⇒ product has no live row (archived cold storage) */
  archived: boolean;
}

/** Find the single rule for an edge, if it exists. */
export function findTransitionRule(
  from: LifecycleState,
  to: LifecycleState,
): TransitionRule | null {
  return LIFECYCLE_TRANSITION_RULES.find((r) => r.from === from && r.to === to) ?? null;
}

/**
 * Decide whether `from → to` may proceed. Deterministic and pure:
 *   • archived product            → ARCHIVED (restore is the only path back)
 *   • from === to                 → UNCHANGED
 *   • no rule for the edge         → INVALID
 *   • rule requires READY, not ready → BLOCKED
 *   • otherwise                    → OK
 * The caller merges any readiness reason detail into a BLOCKED result.
 */
export function evaluateTransition(
  from: LifecycleState,
  to: LifecycleState,
  ctx: LifecycleContext,
): TransitionDecision {
  if (ctx.archived) {
    return { code: "ARCHIVED", allowed: false, authority: null, reasons: [TRANSITION_MESSAGES.archived] };
  }
  if (from === to) {
    return { code: "UNCHANGED", allowed: false, authority: null, reasons: [TRANSITION_MESSAGES.unchanged] };
  }
  const rule = findTransitionRule(from, to);
  if (!rule) {
    return { code: "INVALID", allowed: false, authority: null, reasons: [TRANSITION_MESSAGES.invalid] };
  }
  if (rule.requiresReady && !ctx.ready) {
    return { code: "BLOCKED", allowed: false, authority: rule.authority, reasons: [TRANSITION_MESSAGES.not_ready] };
  }
  return { code: "OK", allowed: true, authority: rule.authority, reasons: [] };
}

export interface AvailableTransition {
  to: LifecycleState;
  authority: TransitionAuthority;
  requiresReady: boolean;
  /** true when it could be performed right now (prerequisites satisfied) */
  allowedNow: boolean;
  /** fixed reason it is not allowed now (empty when allowedNow) */
  blockedReason: string | null;
}

/**
 * Enumerate every transition leaving `from`, annotated with whether it can run
 * now. Archived products expose none (restore is separate). Pure — the UI uses
 * this to render buttons; the boundary re-validates on submit.
 */
export function availableTransitions(
  from: LifecycleState,
  ctx: LifecycleContext,
): AvailableTransition[] {
  if (ctx.archived) return [];
  return LIFECYCLE_TRANSITION_RULES.filter((r) => r.from === from).map((r) => {
    const blocked = r.requiresReady && !ctx.ready;
    return {
      to: r.to,
      authority: r.authority,
      requiresReady: r.requiresReady,
      allowedNow: !blocked,
      blockedReason: blocked ? TRANSITION_MESSAGES.not_ready : null,
    };
  });
}

/**
 * The DERIVED display state. ARCHIVED wins (no live row); a DRAFT that is
 * catalog-complete AND approved shows as READY; everything else shows its
 * stored state. READY/ARCHIVED are display-only and never written back.
 */
export function displayLifecycle(
  state: LifecycleState,
  ctx: { ready: boolean; archived: boolean },
): LifecycleDisplay {
  if (ctx.archived) return "ARCHIVED";
  if (state === "DRAFT" && ctx.ready) return "READY";
  return state;
}

/** Bilingual display labels for the five display states. */
export const LIFECYCLE_DISPLAY_LABEL: Record<LifecycleDisplay, string> = {
  DRAFT: "مسودة",
  READY: "جاهز",
  ACTIVE: "نشط",
  STOPPED: "موقوف",
  ARCHIVED: "مؤرشف",
};

/** Action verb labels keyed by transition target (for buttons). */
export const TRANSITION_ACTION_LABEL: Record<LifecycleState, string> = {
  ACTIVE: "تفعيل",
  STOPPED: "إيقاف",
  DRAFT: "إرجاع لمسودة",
};

/**
 * Deep-link to a product's lifecycle REVIEW surface (the #lifecycle panel on the
 * V2 product page). The Action Center / Operations deep-link here for per-product
 * lifecycle review — the review + transition always happen on the product page,
 * never inline in a list. Pure string builder; the id is URL-encoded.
 */
export function lifecycleReviewHref(productId: string): string {
  return `/v2/catalog/${encodeURIComponent(productId)}?panel=lifecycle#lifecycle`;
}

/** The stored states, derived from the matrix so this module needs no runtime
 *  dependency on state.ts (keeps it trivially node:test-loadable). */
const KNOWN_STATES: ReadonlySet<string> = new Set(
  LIFECYCLE_TRANSITION_RULES.flatMap((r) => [r.from, r.to]),
);

/** Type guard for a stored lifecycle state, usable without importing state.ts. */
export function isKnownLifecycleState(v: unknown): v is LifecycleState {
  return typeof v === "string" && KNOWN_STATES.has(v);
}
