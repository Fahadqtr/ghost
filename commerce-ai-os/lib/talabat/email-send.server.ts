// TALABAT DIRECT SEND — server orchestration (SERVER-ONLY, OWNER-GATED at the
// route).
//
// The Rafeeq pattern, one channel over. Every safety property is enforced by
// the PURE planner in lib/export/talabat/email-send.ts; this file only supplies
// truth to it and carries out what it authorises:
//
//   • the SMTP layer is the SHARED one (lib/mail/smtp.server) — no second
//     transport exists, and a guard test asserts this file never constructs
//     one;
//   • recipients come from the owner-configured settings row ONLY. No address
//     is hardcoded, and an unset channel blocks the send;
//   • the sender is checked against the transport's own authenticated From.
//     A mismatch blocks and is never substituted;
//   • Email C (barcode corrections) is refused before anything else happens;
//   • the delivery audit row is written ONLY after the provider accepted the
//     message, and never carries a credential;
//   • nothing here regenerates an artifact, and nothing sends without the
//     owner's explicit confirmation flag.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getMailConfig, sendMailViaSmtp } from "@/lib/mail/smtp.server";
import { diagnoseMailEnv, blockingMailEnvNames, type MailEnvDiagnostic } from "@/lib/mail/config";
import {
  RECIPIENT_SETTING_KEYS, parseStoredRecipients, toStoredRecipients, isChannelConfigured,
  validateRecipientEdit, resolveSendRecipients, BCC_SUPPORTED,
  type ChannelRecipients, type MailChannel,
} from "@/lib/mail/recipient-settings";
import {
  DEFAULT_SENDER_IDENTITY, resolveSenderIdentity, resolveSenderIdentities, chooseSender, senderHeaders,
  type ResolvedSenderIdentity,
} from "@/lib/mail/sender-identity";
import {
  planTalabatEmailSend, runTalabatEmailSend, checkSenderTransport, senderMismatchGuidance,
  isTalabatSendableKind, talabatSendErrorMessageAr,
  type TalabatEmailSendBlock, type TalabatPlannedAttachment, type TalabatSendKind,
  type TalabatSendScope, type SenderTransportCheck,
} from "@/lib/export/talabat/email-send";
import { buildTalabatUpdateEmail, buildTalabatNewProductsEmail } from "@/lib/export/talabat/email-templates";
import {
  artifactPath, parseArtifactScope, verifyArtifactScope, SCOPE_SIDECAR_FILENAME,
  ARTIFACT_BLOCK_AR, type TalabatArtifactScope,
} from "@/lib/export/talabat/email-artifacts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ZIP_MIME = "application/zip";
const BUCKET = "talabat-packages";

/**
 * Where a generated Talabat email artifact is expected to live.
 *
 * Deliberately a fixed, non-guessable layout rather than a search: the
 * preflight must be able to say "the artifact for THIS email is missing",
 * not "some file that looked close enough was found".
 */
/** Re-exported so callers have ONE definition of where an artifact lives. */
export { artifactPath as talabatEmailArtifactPath, TALABAT_EMAIL_ARTIFACT_PREFIX }
  from "@/lib/export/talabat/email-artifacts";

export type TalabatSendApiError = TalabatEmailSendBlock | "forbidden" | "artifact_not_found" | "artifact_stale";
export type TalabatSendApiResult<T> = { ok: true; value: T } | { ok: false; error: TalabatSendApiError; status: number };
const sendErr = <T,>(error: TalabatSendApiError, status: number): TalabatSendApiResult<T> => ({ ok: false, error, status });

// ── recipient settings (shared model, Talabat + Rafeeq) ──────────────────────

/** Defensive read. Missing table/row/shape → not configured, never a guess. */
export async function readChannelRecipients(channel: MailChannel): Promise<ChannelRecipients> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("app_settings").select("value").eq("key", RECIPIENT_SETTING_KEYS[channel]).maybeSingle();
    if (error || !data) return { to: [], cc: [] };
    return parseStoredRecipients((data as { value: unknown }).value);
  } catch {
    return { to: [], cc: [] };
  }
}

export type SaveRecipientsResult =
  | { ok: true; value: ChannelRecipients }
  | { ok: false; error: "invalid_recipient"; invalid: string[]; emptyTo: boolean };

/** Owner edit from the settings screen. Validates strictly, then persists. */
export async function saveChannelRecipients(
  channel: MailChannel, toRaw: string, ccRaw: string,
): Promise<SaveRecipientsResult> {
  const edit = validateRecipientEdit(toRaw, ccRaw);
  if (!edit.ok) return { ok: false, error: "invalid_recipient", invalid: edit.invalid, emptyTo: edit.emptyTo };
  const admin = createAdminClient();
  const { error } = await admin.from("app_settings").upsert({
    key: RECIPIENT_SETTING_KEYS[channel],
    value: toStoredRecipients(edit.value),
    updated_at: new Date().toISOString(),
  });
  if (error) return { ok: false, error: "invalid_recipient", invalid: [], emptyTo: false };
  return { ok: true, value: edit.value };
}

// ── sender resolution against the REAL transport ─────────────────────────────

export interface SenderStatusDTO {
  /** the identity we intend to send as. */
  expected: { displayName: string; address: string };
  /** the address the provider actually authenticated. null ⇒ no transport. */
  authenticatedFrom: string | null;
  match: boolean;
  verification: ResolvedSenderIdentity["verification"];
  selectable: boolean;
  /** owner-facing steps to fix a mismatch. Names variables, never values. */
  guidance: string[];
}

export function readSenderStatus(): { status: SenderStatusDTO; check: SenderTransportCheck; configured: boolean } {
  const config = getMailConfig();
  const identity = DEFAULT_SENDER_IDENTITY;
  const resolved = resolveSenderIdentity(identity, config);
  const check = checkSenderTransport(identity.address, config?.fromAddress ?? null);
  return {
    configured: config !== null,
    check,
    status: {
      expected: { displayName: identity.displayName, address: identity.address },
      authenticatedFrom: config?.fromAddress ?? null,
      match: check.match,
      verification: resolved.verification,
      selectable: resolved.selectable,
      guidance: senderMismatchGuidance(check),
    },
  };
}

// ── artifacts ────────────────────────────────────────────────────────────────

export interface TalabatEmailArtifact {
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

async function readArtifact(kind: TalabatSendKind, filename: string): Promise<TalabatEmailArtifact | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(BUCKET).download(artifactPath(kind, filename));
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.length === 0) return null;
    return { filename, bytes, contentType: filename.endsWith(".zip") ? ZIP_MIME : XLSX_MIME };
  } catch {
    return null;
  }
}

/**
 * The attachment set and the scope facts for one email kind.
 *
 * `scope` is read from the stored scope sidecar the generator writes next to
 * the artifacts. It is NOT recomputed here: the preflight's job is to verify
 * that what was generated is internally consistent, and inventing the numbers
 * at preflight time would make the check vacuous.
 */
export interface TalabatEmailBundle {
  attachments: TalabatEmailArtifact[];
  scope: TalabatSendScope;
  /** the full stored sidecar — carries the run binding and the audit counts. */
  artifactScope: TalabatArtifactScope;
}

async function readArtifactScope(kind: TalabatSendKind): Promise<TalabatArtifactScope | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(BUCKET).download(artifactPath(kind, SCOPE_SIDECAR_FILENAME));
    if (error || !data) return null;
    const parsed = parseArtifactScope(JSON.parse(await data.text()) as unknown, kind);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

export async function loadTalabatEmailBundle(kind: TalabatSendKind): Promise<TalabatEmailBundle | null> {
  const scope = await readArtifactScope(kind);
  if (!scope) return null;
  const loaded = await Promise.all(scope.files.map((f) => readArtifact(kind, f.filename)));
  // Every claimed attachment must actually be readable AND be the size the
  // sidecar recorded. A partial or altered set is a missing bundle, never a
  // different email than the one the owner reviewed.
  if (loaded.some((a, i) => a === null || a.bytes.length !== scope.files[i].bytes)) return null;
  return {
    attachments: loaded as TalabatEmailArtifact[],
    scope: {
      workbookRows: scope.workbookRows,
      imageCount: scope.imageCount,
      rowsMissingImage: scope.rowsMissingImage,
      excludedCategoryRows: scope.excludedCategoryRows,
    },
    artifactScope: scope,
  };
}

// ── preflight ────────────────────────────────────────────────────────────────

export interface TalabatSendPreflightDTO {
  kind: TalabatSendKind;
  configured: boolean;
  sender: SenderStatusDTO;
  /** display-only From ("Name <address>"). Never a credential. */
  from: string | null;
  recipients: { to: string[]; cc: string[]; configured: boolean };
  /**
   * STEP 86 — the saved value is a PREFILL, not a commitment. The confirm
   * screen shows it in an editable field and may send a different address.
   */
  recipientOverrideAllowed: true;
  bccSupported: boolean;
  subject: string;
  bodyText: string;
  attachments: { filename: string; bytes: number; contentType: string }[];
  scope: TalabatSendScope | null;
  /** the run the stored artifacts were generated from. null ⇒ none stored. */
  artifactRunFingerprint: string | null;
  /** the run the caller is acting on. null ⇒ the binding could not be checked. */
  currentRunFingerprint: string | null;
  runBindingVerified: boolean;
  extensionAudit: { mismatches: number; renamed: number; collisions: number } | null;
  attachmentMaxBytes: number;
  /** every reason this email cannot be sent right now, in owner language. */
  blockers: string[];
  sendable: boolean;
  /** BOOLEANS ONLY + blocking variable NAMES. No value ever appears. */
  diagnostic: MailEnvDiagnostic;
  blockingEnvNames: string[];
}

function draftFor(kind: TalabatSendKind, files: string[], categoryRequests: string[]) {
  return kind === "existing_updates"
    ? buildTalabatUpdateEmail(files[0] ?? "")
    : buildTalabatNewProductsEmail(files[0] ?? "", files[1] ?? "", { sendable: false, categoryRequests });
}

/**
 * Everything the confirmation screen shows BEFORE the owner may send.
 * READ-ONLY: nothing is generated, stored, or transmitted.
 */
export async function getTalabatSendPreflight(
  kind: string,
  categoryRequests: string[] = [],
  /**
   * The fingerprint of the comparison run the caller is acting on. Omitted
   * means the binding CANNOT be checked, which is a blocker rather than a
   * pass: sending Monday's workbook against Tuesday's data is exactly the
   * mistake the fingerprint exists to prevent.
   */
  currentRunFingerprint: string | null = null,
): Promise<TalabatSendApiResult<TalabatSendPreflightDTO>> {
  // Email C is refused here as well as in the planner — the preflight must not
  // even assemble a draft for a kind that can never be sent.
  if (!isTalabatSendableKind(kind)) return sendErr("email_kind_not_sendable", 422);

  const config = getMailConfig();
  const { status: sender, configured } = readSenderStatus();
  const recipients = await readChannelRecipients("talabat");
  const bundle = await loadTalabatEmailBundle(kind);
  const files = bundle?.attachments.map((a) => a.filename) ?? [];
  const draft = draftFor(kind, files, categoryRequests);

  const blockers: string[] = [];
  if (!configured) blockers.push(talabatSendErrorMessageAr("mail_not_configured"));
  else if (!sender.match) blockers.push(talabatSendErrorMessageAr("sender_not_authenticated"));
  if (!isChannelConfigured(recipients)) blockers.push(talabatSendErrorMessageAr("recipient_not_configured"));
  if (!bundle) {
    blockers.push(ARTIFACT_BLOCK_AR.artifact_missing);
  } else {
    if (currentRunFingerprint === null) {
      blockers.push("تعذّر التحقق من ارتباط الملفات بالمقارنة الحالية — أعد التوليد من نفس التشغيل.");
    }
    for (const b of verifyArtifactScope(bundle.artifactScope, currentRunFingerprint ?? "")) {
      // artifact_stale is already covered by the message above when the caller
      // supplied nothing; do not say the same thing twice.
      if (b === "artifact_stale" && currentRunFingerprint === null) continue;
      blockers.push(ARTIFACT_BLOCK_AR[b]);
    }
    if (!scopeOk(bundle.scope)) blockers.push(talabatSendErrorMessageAr("attachment_scope_mismatch"));
  }

  const diagnostic = diagnoseMailEnv(process.env as Record<string, string | undefined>);
  return {
    ok: true,
    value: {
      kind,
      configured,
      sender,
      from: config ? `${config.fromName} <${config.fromAddress}>` : null,
      recipients: { to: recipients.to, cc: recipients.cc, configured: isChannelConfigured(recipients) },
      recipientOverrideAllowed: true,
      bccSupported: BCC_SUPPORTED,
      subject: draft.subject,
      bodyText: draft.bodyText,
      attachments: (bundle?.attachments ?? []).map((a) => ({
        filename: a.filename, bytes: a.bytes.length, contentType: a.contentType,
      })),
      scope: bundle?.scope ?? null,
      artifactRunFingerprint: bundle?.artifactScope.runFingerprint ?? null,
      currentRunFingerprint,
      runBindingVerified: bundle !== null && currentRunFingerprint !== null
        && bundle.artifactScope.runFingerprint === currentRunFingerprint,
      extensionAudit: bundle?.artifactScope.extensionAudit ?? null,
      attachmentMaxBytes: config?.attachmentMaxBytes ?? 0,
      blockers,
      sendable: blockers.length === 0,
      diagnostic,
      blockingEnvNames: blockingMailEnvNames(diagnostic),
    },
  };
}

function scopeOk(scope: TalabatSendScope): boolean {
  return scope.workbookRows > 0 && scope.rowsMissingImage === 0 && scope.excludedCategoryRows === 0
    && (scope.imageCount === null || scope.imageCount > 0);
}

// ── send ─────────────────────────────────────────────────────────────────────

export interface TalabatSendRequest {
  kind: string;
  /** the owner's explicit «إرسال الآن». Absent ⇒ nothing is sent. */
  confirm: boolean;
  categoryRequests: string[];
  createdBy: string;
  /** must equal the stored artifacts' fingerprint, or nothing is sent. */
  currentRunFingerprint: string | null;
  /**
   * STEP 86 — the recipient the owner chose for THIS send. Blank means "use the
   * saved default"; a non-blank value must validate or the send is refused,
   * never silently replaced by the saved one.
   */
  recipientOverride: { toRaw: string; ccRaw: string } | null;
}

export interface TalabatSendResultDTO {
  sent: true;
  kind: TalabatSendKind;
  messageId: string | null;
  auditRecorded: boolean;
  attachmentFilenames: string[];
}

/**
 * Send ONE Talabat email after the owner's explicit confirmation.
 * Provider first; audit only on provider success; no artifact is regenerated.
 */
export async function sendTalabatEmail(req: TalabatSendRequest): Promise<TalabatSendApiResult<TalabatSendResultDTO>> {
  if (!isTalabatSendableKind(req.kind)) return sendErr("email_kind_not_sendable", 422);
  const config = getMailConfig();
  const { check } = readSenderStatus();

  // The chosen identity must be selectable in its own right, not merely equal
  // to the transport From — chooseSender refuses an inactive identity too, and
  // refusing is never the same as swapping in another one.
  const choice = chooseSender(resolveSenderIdentities([DEFAULT_SENDER_IDENTITY], config), null);
  if (!choice.ok) return sendErr("sender_not_authenticated", 409);
  // Plan against the address the CHOOSER returned, not a re-derived one, so
  // there is a single answer to "who are we sending as" and the transport
  // comparison below is made against that same answer.
  const chosen = checkSenderTransport(senderHeaders(choice.identity).fromAddress, config?.fromAddress ?? null);
  if (!chosen.match || chosen.expected !== check.expected) return sendErr("sender_not_authenticated", 409);

  const saved = await readChannelRecipients("talabat");
  const resolved = resolveSendRecipients(saved, req.recipientOverride);
  if (!resolved.ok) {
    return sendErr(resolved.error === "not_configured" ? "recipient_not_configured" : "invalid_recipient", 422);
  }
  const recipients = resolved.value;
  const bundle = await loadTalabatEmailBundle(req.kind);
  if (!bundle) return sendErr("artifact_not_found", 409);
  // The send re-runs the SAME verification the preflight showed — a preflight
  // the owner read minutes ago is not authority for the state right now.
  if (req.currentRunFingerprint === null) return sendErr("artifact_stale", 409);
  if (verifyArtifactScope(bundle.artifactScope, req.currentRunFingerprint).length > 0) {
    return sendErr("artifact_stale", 409);
  }
  const files = bundle.attachments.map((a) => a.filename);
  const draft = draftFor(req.kind, files, req.categoryRequests);

  const planned: TalabatPlannedAttachment[] = bundle.attachments.map((a) => ({
    filename: a.filename, bytes: a.bytes.length, contentType: a.contentType,
  }));
  const plan = planTalabatEmailSend({
    kind: req.kind,
    configured: config !== null,
    sender: chosen,
    toRaw: recipients.to.join(", "),
    ccRaw: recipients.cc.join(", "),
    subject: draft.subject,
    text: draft.bodyText,
    attachments: planned,
    attachmentMaxBytes: config?.attachmentMaxBytes ?? 0,
    scope: bundle.scope,
    draftBlockers: [],
    ownerConfirmed: req.confirm,
  });
  if (!plan.ok) {
    return sendErr(plan.error, plan.error === "attachments_too_large" ? 413
      : plan.error === "mail_not_configured" ? 503
      : plan.error === "not_confirmed" ? 428 : 422);
  }
  if (!config) return sendErr("mail_not_configured", 503);

  const bytesByName = new Map(bundle.attachments.map((a) => [a.filename, a.bytes]));
  const sentAtIso = new Date().toISOString();
  const result = await runTalabatEmailSend(plan.plan, { sentAtIso, createdBy: req.createdBy }, {
    send: (p) => sendMailViaSmtp(config, {
      to: p.to,
      cc: p.cc,
      subject: p.subject,
      html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(p.text)}</pre>`,
      text: p.text,
      attachments: p.attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(bytesByName.get(a.filename) ?? new Uint8Array()),
        contentType: a.contentType,
      })),
    }),
    recordAudit: async (record) => {
      try {
        const admin = createAdminClient();
        const { error } = await admin.from("talabat_email_deliveries").insert({
          email_kind: record.emailKind,
          sender: record.sender,
          recipients: record.recipients,
          cc: record.cc,
          subject: record.subject,
          sent_at: record.sentAtIso,
          provider_message_id: record.providerMessageId,
          attachment_filenames: record.attachmentFilenames,
          status: record.status,
          created_by: record.createdBy,
          error_reference: null,
        });
        return !error;
      } catch {
        return false;
      }
    },
  });
  if (!result.ok) return sendErr("send_failed", 502);

  return {
    ok: true,
    value: {
      sent: true,
      kind: plan.plan.kind,
      messageId: result.messageId,
      auditRecorded: result.auditRecorded,
      attachmentFilenames: plan.plan.attachments.map((a) => a.filename),
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── settings screen data ─────────────────────────────────────────────────────

export interface EmailSettingsDTO {
  senders: {
    address: string; displayName: string; active: boolean; isDefault: boolean;
    verification: ResolvedSenderIdentity["verification"]; selectable: boolean; blockedReason: string | null;
  }[];
  authenticatedFrom: string | null;
  talabat: { to: string[]; cc: string[]; configured: boolean };
  rafeeq: { to: string[]; cc: string[]; configured: boolean };
  bccSupported: boolean;
  guidance: string[];
  diagnostic: MailEnvDiagnostic;
  blockingEnvNames: string[];
}

/** Everything Settings → Email renders. No credential is included. */
export async function getEmailSettings(): Promise<EmailSettingsDTO> {
  const config = getMailConfig();
  const { status } = readSenderStatus();
  const resolved = resolveSenderIdentities([DEFAULT_SENDER_IDENTITY], config);
  const [talabat, rafeeq] = await Promise.all([
    readChannelRecipients("talabat"),
    readChannelRecipients("rafeeq"),
  ]);
  const diagnostic = diagnoseMailEnv(process.env as Record<string, string | undefined>);
  return {
    senders: resolved.map((s) => ({
      address: s.address, displayName: s.displayName, active: s.active, isDefault: s.isDefault,
      verification: s.verification, selectable: s.selectable, blockedReason: s.blockedReason,
    })),
    authenticatedFrom: config?.fromAddress ?? null,
    talabat: { to: talabat.to, cc: talabat.cc, configured: isChannelConfigured(talabat) },
    rafeeq: { to: rafeeq.to, cc: rafeeq.cc, configured: isChannelConfigured(rafeeq) },
    bccSupported: BCC_SUPPORTED,
    guidance: status.guidance,
    diagnostic,
    blockingEnvNames: blockingMailEnvNames(diagnostic),
  };
}
