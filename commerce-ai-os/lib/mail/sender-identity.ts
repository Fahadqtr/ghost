// MAIL — sender identities: which mailbox an outbound email is sent FROM (PURE).
//
// WHAT CHANGED AND WHY IT IS NOT A ONE-LINE EDIT
// The From address was never hardcoded. It comes from the MAIL_FROM_ADDRESS
// deployment secret, and the only string "gulfmedia" anywhere in this
// repository is an EXAMPLE inside a comment in lib/mail/config.ts. So there was
// no default in code to change: the live sender is whatever the deployment
// environment says, and editing source cannot move it.
//
// This registry is the thing that can. It gives the owner a real choice of
// sender per email, with `fahad@malikasuniverse.com` as the built-in default
// for BOTH Talabat and Rafeeq, while the SMTP credentials stay exactly where
// they were — in deployment environment variables, never in the repository and
// never in the database.
//
// AUTHENTICATION IS NOT ASSUMED
// A configured identity is NOT a sendable one. Almost every SMTP provider
// rejects, or silently rewrites, a From address the authenticated account does
// not own — so an identity is sendable only when the resolved MAIL_FROM_ADDRESS
// proves the transport actually owns that mailbox. Everything else is
// `unverified` and cannot be selected for a send. That is the difference
// between offering a choice and pretending one works.

import { isValidEmailAddress, type MailConfig } from "./config.ts";

export type SenderVerification =
  /** the configured transport authenticates AS this mailbox — it can send. */
  | "verified"
  /** configured, but the transport does not prove ownership — cannot send. */
  | "unverified"
  /** no transport configured at all (MAIL_* secrets absent). */
  | "no_transport";

export interface SenderIdentity {
  /** stable key used by the UI and by stored preferences. */
  id: string;
  displayName: string;
  address: string;
  /** optional Reply-To; when absent replies go to `address`. */
  replyTo: string | null;
  /** deactivated identities stay listed for history but cannot be selected. */
  active: boolean;
  /** true for the identity used when the owner does not pick one. */
  isDefault: boolean;
}

export interface ResolvedSenderIdentity extends SenderIdentity {
  verification: SenderVerification;
  /** true only when active AND verification === "verified". */
  selectable: boolean;
  /** owner-facing reason when not selectable (never a credential or a value). */
  blockedReason: string | null;
}

/** The channels that choose a sender. */
export type SenderChannel = "talabat" | "rafeeq";

/**
 * The built-in identity. The owner's own mailbox, default for BOTH channels.
 * No password, token or host is stored here or anywhere else in the repo.
 */
export const DEFAULT_SENDER_IDENTITY: SenderIdentity = {
  id: "fahad-malikasuniverse",
  displayName: "Fahad Abdulaziz Ali",
  address: "fahad@malikasuniverse.com",
  replyTo: null,
  active: true,
  isDefault: true,
};

/** The default sender address for a channel. Same mailbox for both today. */
export const DEFAULT_SENDER_BY_CHANNEL: Record<SenderChannel, string> = {
  talabat: DEFAULT_SENDER_IDENTITY.address,
  rafeeq: DEFAULT_SENDER_IDENTITY.address,
};

/** Validate an identity the owner is adding. Never throws. */
export function validateSenderIdentity(input: {
  id?: string; displayName?: string; address?: string; replyTo?: string | null;
}): { ok: true; value: Omit<SenderIdentity, "active" | "isDefault"> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const address = (input.address ?? "").trim().toLowerCase();
  const displayName = (input.displayName ?? "").trim();
  const replyToRaw = (input.replyTo ?? "").trim();
  if (!isValidEmailAddress(address)) errors.push("address");
  if (displayName === "") errors.push("displayName");
  if (replyToRaw !== "" && !isValidEmailAddress(replyToRaw)) errors.push("replyTo");
  const id = (input.id ?? address.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).trim();
  if (id === "") errors.push("id");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { id, displayName, address, replyTo: replyToRaw === "" ? null : replyToRaw } };
}

/**
 * Resolve an identity's real sending status against the configured transport.
 *
 * `config` is the resolved MailConfig (null when the MAIL_* secrets are absent
 * or incomplete). Ownership is proven by the transport's own From address —
 * the one the provider authenticated — matching this identity's address.
 */
export function resolveSenderIdentity(identity: SenderIdentity, config: MailConfig | null): ResolvedSenderIdentity {
  let verification: SenderVerification = "no_transport";
  if (config !== null) {
    verification = config.fromAddress.trim().toLowerCase() === identity.address.trim().toLowerCase()
      ? "verified"
      : "unverified";
  }
  const selectable = identity.active && verification === "verified";
  const blockedReason = selectable
    ? null
    : !identity.active
      ? "الهوية غير مفعّلة"
      : verification === "no_transport"
        ? "لم يتم إعداد خدمة البريد بعد"
        : "لم يتم توثيق هذا العنوان لدى مزوّد البريد";
  return { ...identity, verification, selectable, blockedReason };
}

/** Resolve a whole registry, default first then by display name. */
export function resolveSenderIdentities(
  identities: readonly SenderIdentity[],
  config: MailConfig | null,
): ResolvedSenderIdentity[] {
  return identities
    .map((i) => resolveSenderIdentity(i, config))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName));
}

/**
 * Pick the sender for a send.
 *
 * An explicit choice is honoured only when it is SELECTABLE — an inactive or
 * unverified identity is refused rather than silently swapped for the default,
 * because sending from a different mailbox than the owner chose is worse than
 * not sending. With no choice, the default identity is used, and it must be
 * selectable too.
 */
export type SenderChoice =
  | { ok: true; identity: ResolvedSenderIdentity }
  | { ok: false; code: "unknown_sender" | "not_selectable" | "no_default"; reason: string };

export function chooseSender(
  identities: readonly ResolvedSenderIdentity[],
  requestedId: string | null,
): SenderChoice {
  if (requestedId !== null && requestedId !== "") {
    const found = identities.find((i) => i.id === requestedId);
    if (!found) return { ok: false, code: "unknown_sender", reason: "هوية المرسل غير معروفة" };
    if (!found.selectable) return { ok: false, code: "not_selectable", reason: found.blockedReason ?? "غير متاحة" };
    return { ok: true, identity: found };
  }
  const def = identities.find((i) => i.isDefault);
  if (!def) return { ok: false, code: "no_default", reason: "لا توجد هوية افتراضية" };
  if (!def.selectable) return { ok: false, code: "not_selectable", reason: def.blockedReason ?? "غير متاحة" };
  return { ok: true, identity: def };
}

/** The From header parts for a chosen identity. */
export function senderHeaders(identity: ResolvedSenderIdentity): {
  fromName: string; fromAddress: string; replyTo: string | null;
} {
  return { fromName: identity.displayName, fromAddress: identity.address, replyTo: identity.replyTo };
}
