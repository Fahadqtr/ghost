// MAIL — generic outbound-email provider configuration (PURE).
//
// Owner rules:
//   • credentials come from DEPLOYMENT ENVIRONMENT VARIABLES ONLY — nothing in
//     this repository ever hardcodes an SMTP host, username, password, API key
//     or OAuth token, and no provider values are assumed (Titan or otherwise);
//   • when the environment is not fully configured the app treats email
//     sending as UNAVAILABLE (readMailConfig → null) — it never guesses;
//   • recipient addresses are validated and NEVER guessed or prefilled from
//     unrelated data.
//
// Expected environment (deployment secrets):
//   MAIL_HOST      — SMTP host (e.g. the Titan SMTP host)
//   MAIL_PORT      — SMTP port (defaults to 465 when MAIL_SECURE, else 587)
//   MAIL_SECURE    — "true" for implicit TLS (default true)
//   MAIL_USERNAME  — SMTP auth user
//   MAIL_PASSWORD  — SMTP auth password
//   MAIL_FROM_NAME     — display name for the From header
//   MAIL_FROM_ADDRESS  — From address (e.g. the gulfmedia.qa mailbox)
//   EMAIL_ATTACHMENT_MAX_BYTES — optional decoded-bytes cap for attachments

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName: string;
  fromAddress: string;
  /** decoded attachment byte cap (provider-safe encoded estimate is derived). */
  attachmentMaxBytes: number;
}

/** Default decoded attachment cap — conservative for common SMTP providers. */
export const EMAIL_ATTACHMENT_MAX_BYTES_DEFAULT = 20 * 1024 * 1024;

/**
 * Read the mail configuration from an environment map. Returns null unless
 * every required variable is present — a partially configured environment is
 * treated as NOT configured (sending disabled), never guessed at.
 */
export function readMailConfig(env: Record<string, string | undefined>): MailConfig | null {
  const host = (env.MAIL_HOST ?? "").trim();
  const username = (env.MAIL_USERNAME ?? "").trim();
  const password = env.MAIL_PASSWORD ?? "";
  const fromAddress = (env.MAIL_FROM_ADDRESS ?? "").trim();
  if (!host || !username || !password || !fromAddress) return null;
  if (!isValidEmailAddress(fromAddress)) return null;
  const secure = (env.MAIL_SECURE ?? "true").trim().toLowerCase() !== "false";
  const portRaw = Number.parseInt((env.MAIL_PORT ?? "").trim(), 10);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : secure ? 465 : 587;
  const maxRaw = Number.parseInt((env.EMAIL_ATTACHMENT_MAX_BYTES ?? "").trim(), 10);
  const attachmentMaxBytes = Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : EMAIL_ATTACHMENT_MAX_BYTES_DEFAULT;
  return {
    host,
    port,
    secure,
    username,
    password,
    fromName: (env.MAIL_FROM_NAME ?? "").trim() || "Malikas Universe",
    fromAddress,
    attachmentMaxBytes,
  };
}

/** Pragmatic RFC-shaped address check (one @, non-empty local, dotted domain). */
export function isValidEmailAddress(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address.trim());
}

// ── owner-only runtime diagnostic (BOOLEANS ONLY — never values) ──────────────

/**
 * Non-secret validation state of the mail environment. Every leaf is a
 * boolean: no value, no length, no fragment of any variable ever appears —
 * safe to show the owner in production to pinpoint WHICH variable is
 * missing/invalid (by NAME only) when mailConfigResolved is false.
 */
export interface MailEnvDiagnostic {
  MAIL_HOST: { present: boolean; nonEmptyAfterTrim: boolean };
  MAIL_PORT: { present: boolean; parsedValidPort: boolean };
  MAIL_SECURE: { present: boolean; parsedSecure: boolean };
  MAIL_USERNAME: { present: boolean; nonEmptyAfterTrim: boolean };
  MAIL_PASSWORD: { present: boolean; lengthGreaterThanZero: boolean };
  MAIL_FROM_NAME: { present: boolean };
  MAIL_FROM_ADDRESS: { present: boolean; nonEmptyAfterTrim: boolean; validEmailSyntax: boolean };
  EMAIL_ATTACHMENT_MAX_BYTES: { present: boolean; parsedPositiveInteger: boolean };
  mailConfigResolved: boolean;
}

/** Pure diagnostic over an environment map. Mirrors readMailConfig exactly. */
export function diagnoseMailEnv(env: Record<string, string | undefined>): MailEnvDiagnostic {
  const present = (key: string) => typeof env[key] === "string";
  const nonEmpty = (key: string) => (env[key] ?? "").trim() !== "";
  const portRaw = Number.parseInt((env.MAIL_PORT ?? "").trim(), 10);
  const maxRaw = Number.parseInt((env.EMAIL_ATTACHMENT_MAX_BYTES ?? "").trim(), 10);
  return {
    MAIL_HOST: { present: present("MAIL_HOST"), nonEmptyAfterTrim: nonEmpty("MAIL_HOST") },
    MAIL_PORT: { present: present("MAIL_PORT"), parsedValidPort: Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 },
    MAIL_SECURE: { present: present("MAIL_SECURE"), parsedSecure: (env.MAIL_SECURE ?? "true").trim().toLowerCase() !== "false" },
    MAIL_USERNAME: { present: present("MAIL_USERNAME"), nonEmptyAfterTrim: nonEmpty("MAIL_USERNAME") },
    MAIL_PASSWORD: { present: present("MAIL_PASSWORD"), lengthGreaterThanZero: (env.MAIL_PASSWORD ?? "").length > 0 },
    MAIL_FROM_NAME: { present: present("MAIL_FROM_NAME") },
    MAIL_FROM_ADDRESS: {
      present: present("MAIL_FROM_ADDRESS"),
      nonEmptyAfterTrim: nonEmpty("MAIL_FROM_ADDRESS"),
      validEmailSyntax: isValidEmailAddress(env.MAIL_FROM_ADDRESS ?? ""),
    },
    EMAIL_ATTACHMENT_MAX_BYTES: {
      present: present("EMAIL_ATTACHMENT_MAX_BYTES"),
      parsedPositiveInteger: Number.isInteger(maxRaw) && maxRaw > 0,
    },
    mailConfigResolved: readMailConfig(env) !== null,
  };
}

/**
 * The NAMES (only) of variables that block readMailConfig from resolving.
 * Empty when mailConfigResolved is true. Never contains a value.
 */
export function blockingMailEnvNames(d: MailEnvDiagnostic): string[] {
  if (d.mailConfigResolved) return [];
  const out: string[] = [];
  if (!d.MAIL_HOST.nonEmptyAfterTrim) out.push("MAIL_HOST");
  if (!d.MAIL_USERNAME.nonEmptyAfterTrim) out.push("MAIL_USERNAME");
  if (!d.MAIL_PASSWORD.lengthGreaterThanZero) out.push("MAIL_PASSWORD");
  if (!d.MAIL_FROM_ADDRESS.nonEmptyAfterTrim || !d.MAIL_FROM_ADDRESS.validEmailSyntax) out.push("MAIL_FROM_ADDRESS");
  return out;
}

/** Split a user-entered recipients string on commas/semicolons/whitespace. */
export function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export type RecipientsCheck =
  | { ok: true; to: string[]; cc: string[] }
  | { ok: false; invalid: string[]; emptyTo: boolean };

/** Validate To (required, ≥1) + optional CC. Never invents an address. */
export function validateRecipients(toRaw: string, ccRaw: string): RecipientsCheck {
  const to = parseRecipients(toRaw);
  const cc = parseRecipients(ccRaw);
  const invalid = [...to, ...cc].filter((a) => !isValidEmailAddress(a) || isPlaceholderEmailAddress(a));
  if (to.length === 0 || invalid.length > 0) return { ok: false, invalid, emptyTo: to.length === 0 };
  return { ok: true, to, cc };
}

/**
 * RFC 2606 / RFC 6761 reserved names, which can never receive mail, plus the
 * UI's own placeholder domain. `rafeeq@example.com` is SYNTACTICALLY valid, so
 * isValidEmailAddress alone would let a placeholder left in the recipient box
 * reach a real send attempt. Matched on the domain (and any subdomain of it),
 * case-insensitively — never on the local part, since "example@" is a
 * perfectly ordinary mailbox name.
 */
const RESERVED_EMAIL_DOMAINS = [
  "example.com",
  "example.net",
  "example.org",
  "example.edu",
  "example",
  "test",
  "invalid",
  "localhost",
  "local",
] as const;

/** True when the address's domain is a reserved/placeholder name (never deliverable). */
export function isPlaceholderEmailAddress(address: string): boolean {
  const domain = address.trim().toLowerCase().split("@").pop() ?? "";
  if (domain === "") return false;
  return RESERVED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Provider-safe estimate of the ENCODED size of a MIME message's attachments:
 * base64 inflates by 4/3 (+ line breaks ≈ 2.7%), plus per-part MIME headers
 * and the body parts themselves. Deliberately slightly pessimistic — refusing
 * a borderline send beats a provider rejection mid-transfer.
 */
export function estimateEncodedBytes(attachmentBytes: readonly number[], bodyBytes = 0): number {
  const encoded = attachmentBytes.reduce((sum, b) => sum + Math.ceil(b / 57) * 78, 0);
  const perPartOverhead = attachmentBytes.length * 1024;
  return encoded + perPartOverhead + bodyBytes + 4096;
}
