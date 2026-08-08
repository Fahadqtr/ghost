// Malikas V2 — TickTick error normalization (Phase UI.7.5). PURE. Every failure
// surfaces as ONE of a fixed set of Arabic messages — a raw API body, URL,
// token, or stack is NEVER included, so nothing sensitive can leak to a user or
// a log line built from these.

export const TICKTICK_ERRORS = {
  not_configured: "TickTick غير مربوط.",
  auth: "فشل المصادقة مع TickTick — تحقق من الربط.",
  rate_limited: "TickTick مشغول حاليًا — أعد المحاولة بعد قليل.",
  timeout: "انتهت مهلة الاتصال بـ TickTick.",
  unavailable: "تعذّر الوصول إلى TickTick حاليًا.",
  bad_response: "استجابة غير متوقعة من TickTick.",
  unknown: "تعذّرت مزامنة TickTick.",
} as const;

export type TickTickErrorCode = keyof typeof TICKTICK_ERRORS;

/** Fixed Arabic message for a code (prototype-safe lookup). */
export function ticktickErrorMessage(code: TickTickErrorCode): string {
  return Object.hasOwn(TICKTICK_ERRORS, code) ? TICKTICK_ERRORS[code] : TICKTICK_ERRORS.unknown;
}

/** Map an HTTP status → error code WITHOUT surfacing the raw response. */
export function classifyHttpStatus(status: number): TickTickErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "bad_response";
  return "unknown";
}

/** A typed integration error carrying ONLY a safe code (message is derived). */
export class TickTickError extends Error {
  readonly code: TickTickErrorCode;
  constructor(code: TickTickErrorCode) {
    super(ticktickErrorMessage(code));
    this.name = "TickTickError";
    this.code = code;
  }
}

/** Normalize any thrown value into a safe fixed Arabic message. An AbortError
 *  (timeout) and a network TypeError map to their fixed codes; a TickTickError
 *  keeps its code; anything else → unknown. Never returns raw text. */
export function toSafeMessage(err: unknown): string {
  if (err instanceof TickTickError) return err.message;
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return TICKTICK_ERRORS.timeout;
  if (name === "TypeError") return TICKTICK_ERRORS.unavailable;
  return TICKTICK_ERRORS.unknown;
}
