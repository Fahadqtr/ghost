// Malikas V2 — PureSoul error normalization (Phase UI.9.1). PURE. Every failure
// surfaces as ONE fixed Arabic message — a raw DB error, query, or stack is
// NEVER included, so nothing sensitive can leak to a user or a log built from
// these. The dashboard treats any failure as "degraded" (unknown), never
// "missing".

export const PURESOUL_ERRORS = {
  read_failed: "تعذر قراءة PureSoul حاليًا.",
  not_connected: "PureSoul غير مربوط.",
  unknown: "تعذر قراءة PureSoul حاليًا.",
} as const;

export type PureSoulErrorCode = keyof typeof PURESOUL_ERRORS;

/** Fixed Arabic message for a code (prototype-safe lookup). */
export function pureSoulErrorMessage(code: PureSoulErrorCode): string {
  return Object.hasOwn(PURESOUL_ERRORS, code) ? PURESOUL_ERRORS[code] : PURESOUL_ERRORS.unknown;
}

/** Normalize any thrown value into a safe fixed Arabic message. Never returns
 *  raw text (DB error messages / stacks are dropped). */
export function toSafeMessage(_err: unknown): string {
  return PURESOUL_ERRORS.read_failed;
}
