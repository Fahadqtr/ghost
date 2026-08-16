import "server-only";
// OPS.4 — Snoonu Malika's operational reader (SERVER-ONLY, READ-ONLY).
//
// Reads the operational state of the storefront `snoonu:malikas` through the
// EXISTING CH.6B merchant session PORT — no new scraping system, no persistence,
// no mutation. It calls `state()` on the (injectable) merchant session; the
// default session safely reports `session_required`, so with no live wiring the
// card stays OPERATIONALLY_BLOCKED with an explicit reason (§1). Merchant session
// material stays server-only and is NEVER returned/rendered (§12).
//
// It does NOT capture a snapshot (that would be a write to platform_snapshots,
// for which no approved snoonu boundary exists). Listing COUNT is intentionally
// UNKNOWN here — the session PORT exposes only a per-SPI lookup, not a reliable
// bulk count; the ECL-based gap-count reader supplies the mapping count instead.

import { createSnoonuMerchantSession } from "@/lib/adapters/snoonu/merchant/session.server";
import { type SnoonuMerchantSession } from "@/lib/adapters/snoonu/merchant/merchant-contract";
import { safeError } from "@/lib/security/safe-error";
import { mapSnoonuOperational, type SnoonuOperational } from "./snoonu-operational.ts";

const READ_FAILED = "تعذّرت قراءة حالة جلسة سنونو (مالكاز).";

/**
 * Read snoonu:malikas operational state. Read-only + best-effort: any failure
 * degrades to ERROR (never to a faked "connected"/"missing"). `now` is injected
 * so there is no hidden clock. An injectable `session` supports testing + future
 * live wiring without changing this module.
 */
export async function loadSnoonuMalikasOperational(
  opts: { session?: SnoonuMerchantSession; now?: () => string } = {},
): Promise<SnoonuOperational> {
  const now = opts.now ?? (() => new Date().toISOString());
  try {
    const session = opts.session ?? createSnoonuMerchantSession("snoonu:malikas");
    const state = await session.state();
    // A genuine authenticated session records a fresh successful-read time; every
    // other state carries no lastReadAt (never connected).
    return mapSnoonuOperational(state, { lastReadAt: state === "authenticated" ? now() : null });
  } catch (e) {
    return mapSnoonuOperational("error", { readError: safeError("ops4_snoonu_malikas_state", e, READ_FAILED) });
  }
}
