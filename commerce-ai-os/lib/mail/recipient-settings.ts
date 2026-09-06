// MAIL — the owner-configured recipient book (PURE).
//
// One structured model for every channel's recipients, so a new channel does
// not invent its own storage shape. Two rules make it safe:
//
//   • NO ADDRESS IS EVER HARDCODED. Every default is the empty string, and an
//     unset channel reads back as "not configured" rather than as some
//     plausible address. A test asserts no @ literal exists in this file.
//   • Reading is total and defensive. A missing table, a missing row, a legacy
//     shape or outright garbage all resolve to "not configured" — never to a
//     partially-parsed address that might reach a real send.
//
// Storage is the existing app_settings key/value table; the keys below are the
// only ones this module knows.

import { isValidEmailAddress, isPlaceholderEmailAddress, parseRecipients } from "./config.ts";

export type MailChannel = "talabat" | "rafeeq";

/**
 * The app_settings key per channel. Rafeeq's key is the one it already uses —
 * this module reads what Rafeeq wrote, so adopting the shared model does not
 * strand the recipient the owner saved through the Rafeeq modal.
 */
export const RECIPIENT_SETTING_KEYS: Record<MailChannel, string> = {
  talabat: "talabat_email_recipient",
  rafeeq: "rafeeq_email_recipient",
};

export interface ChannelRecipients {
  /** primary recipients. Empty ⇒ NOT CONFIGURED ⇒ no send may proceed. */
  to: string[];
  cc: string[];
}

export const EMPTY_RECIPIENTS: ChannelRecipients = { to: [], cc: [] };

/**
 * Parse whatever app_settings holds for a channel.
 *
 * Accepts the stored object shape `{ to, cc }` (either field a string or an
 * array) and the legacy bare string, because Rafeeq's existing row is
 * `{ to: "a@b.com" }`. Anything unrecognised → EMPTY, which blocks sending.
 */
export function parseStoredRecipients(raw: unknown): ChannelRecipients {
  if (typeof raw === "string") return { to: cleanList(raw), cc: [] };
  if (raw === null || typeof raw !== "object") return EMPTY_RECIPIENTS;
  const o = raw as Record<string, unknown>;
  return { to: cleanList(o.to), cc: cleanList(o.cc) };
}

function cleanList(v: unknown): string[] {
  const parts = typeof v === "string"
    ? parseRecipients(v)
    : Array.isArray(v)
      ? v.flatMap((x) => (typeof x === "string" ? parseRecipients(x) : []))
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const a = p.trim().toLowerCase();
    // A stored address that is malformed or a reserved placeholder is dropped
    // here rather than surfaced: it cannot receive mail, and keeping it would
    // let a stale "example.com" left in settings look like a configured value.
    if (a === "" || !isValidEmailAddress(a) || isPlaceholderEmailAddress(a)) continue;
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/** The value written back to app_settings. Never contains anything but addresses. */
export function toStoredRecipients(r: ChannelRecipients): { to: string; cc: string } {
  return { to: r.to.join(", "), cc: r.cc.join(", ") };
}

export function isChannelConfigured(r: ChannelRecipients): boolean {
  return r.to.length > 0;
}

export type RecipientEditResult =
  | { ok: true; value: ChannelRecipients }
  | { ok: false; invalid: string[]; emptyTo: boolean };

/**
 * Validate an owner edit from the settings UI.
 *
 * Deliberately stricter than parseStoredRecipients: a typo the owner just
 * typed must be REPORTED, not silently dropped, so the field can be corrected.
 * The lenient reader above exists for data already at rest.
 */
export function validateRecipientEdit(toRaw: string, ccRaw: string): RecipientEditResult {
  const to = parseRecipients(toRaw).map((s) => s.trim().toLowerCase());
  const cc = parseRecipients(ccRaw).map((s) => s.trim().toLowerCase());
  const invalid = [...to, ...cc].filter((a) => !isValidEmailAddress(a) || isPlaceholderEmailAddress(a));
  if (to.length === 0 || invalid.length > 0) return { ok: false, invalid, emptyTo: to.length === 0 };
  return { ok: true, value: { to: dedupe(to), cc: dedupe(cc).filter((a) => !to.includes(a)) } };
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** Display form for the settings screen. "—" when nothing is configured. */
export function describeRecipients(r: ChannelRecipients): string {
  return r.to.length === 0 ? "—" : r.to.join(", ");
}

/**
 * BCC is NOT supported.
 *
 * The shared transport (lib/mail/smtp.server.ts) builds a message with To and
 * CC only, and the delivery audit records those two. Accepting a BCC field
 * that the transport would silently drop is worse than not offering one — the
 * owner would believe a copy went somewhere it did not. Adding it means
 * extending OutboundMail, the transport call, and the audit row together.
 */
export const BCC_SUPPORTED = false;

// ── per-send recipients ──────────────────────────────────────────────────────

/**
 * STEP 86 — the owner picks the recipient for EVERY send.
 *
 * The saved row is a convenience default, never a destination the system
 * commits to on its own. An operator who has to retype an address each time
 * makes typos; an operator who cannot change it at all sends to the wrong
 * place when the contact changes. So: prefill from the saved value, allow an
 * override on any send, and validate the override strictly.
 *
 * A BLANK override means "use the saved value" — not "send to nobody" — because
 * an untouched field in the confirm dialog must behave as the prefill it shows.
 * Only a non-blank, invalid override is an error.
 */
export type ResolvedSendRecipients =
  | { ok: true; value: ChannelRecipients; source: "override" | "saved" }
  | { ok: false; error: "not_configured" }
  | { ok: false; error: "invalid_override"; invalid: string[] };

export function resolveSendRecipients(
  saved: ChannelRecipients,
  override: { toRaw: string; ccRaw: string } | null,
): ResolvedSendRecipients {
  const toTyped = (override?.toRaw ?? "").trim() !== "";
  const ccTyped = (override?.ccRaw ?? "").trim() !== "";
  if (override !== null && (toTyped || ccTyped)) {
    // A CC-only override still has to name a To — fall back to the saved To so
    // adding a CC never silently drops the primary recipient.
    const toRaw = toTyped ? override.toRaw : saved.to.join(", ");
    const edit = validateRecipientEdit(toRaw, override.ccRaw);
    if (!edit.ok) return { ok: false, error: "invalid_override", invalid: edit.invalid };
    return { ok: true, value: edit.value, source: "override" };
  }
  if (!isChannelConfigured(saved)) return { ok: false, error: "not_configured" };
  return { ok: true, value: saved, source: "saved" };
}
