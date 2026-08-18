// MEDIA.1A-P — Snoonu merchant session status model (PURE).
//
// Truthful session-state vocabulary + the injectable session-test logic. It never
// touches env, network, DB, or secrets — the live authenticated read is supplied
// as an INJECTED reader (available only once an operator confirms the real portal
// contract). Until such a reader exists, a configured secret can only ever resolve
// to UNKNOWN — never CONNECTED (a session is proven by a real read, never inferred
// from an env variable's mere presence).
//
// PURE: relative type import only; no server-only, no @/, no IO.

import type { SnoonuStorefrontKey } from "./merchant-contract.ts";
export type { SnoonuStorefrontKey } from "./merchant-contract.ts";

export type SnoonuSessionState =
  | "CONNECTED"
  | "SESSION_REQUIRED"
  | "EXPIRED"
  | "STALE"
  | "ERROR"
  | "UNKNOWN";

/** Outcome of one lightweight authenticated read (supplied by an injected reader). */
export type LiveReadOutcome = "ok" | "expired" | "timeout" | "error";

export interface LiveReadResult {
  outcome: LiveReadOutcome;
  /** true when the read succeeded but is considered old (authenticated-but-stale). */
  stale?: boolean;
}

/** An injected, storefront-scoped live reader that proves the session works. */
export type SnoonuLiveSessionReader = () => Promise<LiveReadResult>;

export interface SnoonuSessionStatus {
  storefrontKey: SnoonuStorefrontKey;
  state: SnoonuSessionState;
  /** true only when the secret env is present (presence, NEVER the value). */
  configured: boolean;
  /** true only for a genuine, proven authenticated read. */
  connected: boolean;
}

export const SESSION_STATE_LABEL: Record<SnoonuSessionState, string> = {
  CONNECTED: "متصل",
  SESSION_REQUIRED: "الجلسة مطلوبة",
  EXPIRED: "منتهية",
  STALE: "قديمة",
  ERROR: "خطأ",
  UNKNOWN: "غير معروف",
};

/**
 * Pure state resolution. `configured` = secret env present (presence only).
 * `live` = the result of an actual authenticated read, or null when no read was
 * (or could be) performed. CONNECTED requires a proven `ok` read — env presence
 * alone yields UNKNOWN, never CONNECTED.
 */
export function resolveSnoonuSessionState(input: {
  configured: boolean;
  live: LiveReadResult | null;
}): SnoonuSessionState {
  if (!input.configured) return "SESSION_REQUIRED";
  const live = input.live;
  if (live == null) return "UNKNOWN"; // secret present, but nothing has proven it
  switch (live.outcome) {
    case "ok":
      return live.stale ? "STALE" : "CONNECTED";
    case "expired":
      return "EXPIRED";
    case "timeout":
    case "error":
    default:
      return "ERROR";
  }
}

/**
 * Run a session test for ONE storefront. Never returns secret material. The live
 * reader is INJECTED and storefront-scoped; when it is absent (no confirmed portal
 * contract yet) a configured secret resolves to UNKNOWN, never CONNECTED.
 */
export async function runSnoonuSessionTest(
  storefrontKey: SnoonuStorefrontKey,
  configured: boolean,
  liveReader: SnoonuLiveSessionReader | null,
): Promise<SnoonuSessionStatus> {
  if (!configured) {
    return { storefrontKey, state: "SESSION_REQUIRED", configured: false, connected: false };
  }
  if (!liveReader) {
    return { storefrontKey, state: "UNKNOWN", configured: true, connected: false };
  }
  let state: SnoonuSessionState;
  try {
    const live = await liveReader();
    state = resolveSnoonuSessionState({ configured: true, live });
  } catch {
    state = "ERROR";
  }
  return { storefrontKey, state, configured: true, connected: state === "CONNECTED" };
}
