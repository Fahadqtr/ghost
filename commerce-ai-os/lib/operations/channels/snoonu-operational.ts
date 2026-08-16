// OPS.4 — Snoonu Malika's operational-state mapping (PURE).
//
// Maps the Snoonu MERCHANT SESSION state (the existing CH.6B port) into the
// Command Center's operational-state vocabulary. It NEVER fakes a connected
// state: only a genuine `authenticated` session becomes CONNECTED. Everything
// else stays blocked/unknown with an explicit reason, so snoonu:malikas remains
// OPERATIONALLY_BLOCKED until real merchant evidence is available (§1).
//
// PURE: the only import is the pure CH.6B merchant contract type (relative, not
// `@/`). No server-only, no DB, no secrets — node:test loads it directly.

import type { MerchantSessionState } from "../../adapters/snoonu/merchant/merchant-contract.ts";

export type SnoonuOperationalState =
  | "SESSION_REQUIRED"
  | "CONNECTED"
  | "STALE"
  | "UNKNOWN"
  | "ERROR";

export type SnoonuOperationalReason =
  | "connected"
  | "session_required"
  | "otp_required"
  | "read_error"
  | "stale_read"
  | "unknown";

export const SNOONU_OPERATIONAL_REASON_LABEL: Record<SnoonuOperationalReason, string> = {
  connected: "جلسة التاجر متصلة.",
  session_required: "تتطلب جلسة تاجر — غير متصلة.",
  otp_required: "بانتظار رمز تحقق (OTP) — لم تكتمل الجلسة.",
  read_error: "تعذّرت قراءة حالة جلسة التاجر.",
  stale_read: "آخر قراءة قديمة — يُنصح بالتحديث.",
  unknown: "حالة الجلسة غير معروفة.",
};

export interface SnoonuOperational {
  state: SnoonuOperationalState;
  /** true ONLY for a genuine authenticated session (never faked). */
  connected: boolean;
  reason: SnoonuOperationalReason;
  /** timestamp of the last SUCCESSFUL live read (null when never connected). */
  lastReadAt: string | null;
  /** safe read-error message (detail is logged server-side, never returned). */
  readError: string | null;
}

/**
 * Map a merchant session state (+ optional freshness) into the operational
 * descriptor. `staleFlag` lets a caller mark an authenticated-but-old read as
 * STALE without this module owning any clock. A connected session with no
 * staleness is CONNECTED; OTP-pending and session-required both stay blocked.
 */
export function mapSnoonuOperational(
  sessionState: MerchantSessionState | null | undefined,
  opts: { lastReadAt?: string | null; staleFlag?: boolean; readError?: string | null } = {},
): SnoonuOperational {
  const lastReadAt = opts.lastReadAt ?? null;
  const readError = opts.readError ?? null;
  switch (sessionState) {
    case "authenticated":
      if (opts.staleFlag) {
        return { state: "STALE", connected: true, reason: "stale_read", lastReadAt, readError: null };
      }
      return { state: "CONNECTED", connected: true, reason: "connected", lastReadAt, readError: null };
    case "session_required":
      return { state: "SESSION_REQUIRED", connected: false, reason: "session_required", lastReadAt: null, readError: null };
    case "otp_required":
      return { state: "SESSION_REQUIRED", connected: false, reason: "otp_required", lastReadAt: null, readError: null };
    case "error":
      return { state: "ERROR", connected: false, reason: "read_error", lastReadAt: null, readError };
    default:
      return { state: "UNKNOWN", connected: false, reason: "unknown", lastReadAt: null, readError: null };
  }
}
