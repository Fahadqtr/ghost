// RAFEEQ SEND RECIPIENT (PURE) — the ONE authoritative recipient for a pending
// Rafeeq send.
//
// The bug this exists to prevent: the email draft and the confirmation modal
// each held their OWN recipient state. The owner typed the real address into
// the draft, the modal seeded itself from app_settings instead (empty in
// production, so its placeholder showed), and the send payload used the
// modal's copy. Three surfaces, three sources.
//
// Now there is exactly one value. The modal SNAPSHOTS the draft's recipient
// when it opens; that snapshot is what it displays and what it sends. If the
// draft's recipient changes afterwards the snapshot goes STALE and the
// confirmation refuses — a stale address can never be sent.
//
// Pure: no I/O, no clock, no React. Validation is delegated to the single
// shared validateRecipients, so the reserved-domain / placeholder gates keep
// applying unchanged.

import { validateRecipients } from "../../mail/config.ts";

export interface PendingRecipient {
  /**
   * The EXACT value the confirmation displays AND sends. Normalized once here
   * so the shown string and the transmitted string cannot differ.
   */
  pendingTo: string;
  /** the draft's recipient changed after the confirmation opened. */
  stale: boolean;
  /** pendingTo (+ cc) passes the shared recipient validation. */
  valid: boolean;
  /** addresses rejected by validation (reserved domains included). */
  invalid: string[];
  /** false ⇒ the confirmation must not send. */
  canConfirm: boolean;
}

/** Trim only — never rewrite, lowercase or "correct" an address. */
export function normalizeRecipient(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/**
 * Resolve the pending send's recipient.
 *
 * @param snapshot the draft recipient captured when the confirmation opened
 * @param current  the draft recipient right now
 * @param ccRaw    the confirmation's CC field (no draft counterpart)
 */
export function resolvePendingRecipient(
  snapshot: string | null | undefined,
  current: string | null | undefined,
  ccRaw: string | null | undefined = "",
): PendingRecipient {
  const pendingTo = normalizeRecipient(snapshot);
  const stale = normalizeRecipient(current) !== pendingTo;
  const check = validateRecipients(pendingTo, normalizeRecipient(ccRaw));
  const valid = check.ok;
  const invalid = check.ok ? [] : check.invalid;
  return { pendingTo, stale, valid, invalid, canConfirm: valid && !stale };
}
