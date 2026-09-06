// TALABAT DIRECT SEND — planning + run engine (PURE, port-driven).
//
// The Rafeeq contract, with the gates Talabat additionally needs. What is
// shared is genuinely shared: recipient validation, the encoded-size estimate
// and the SMTP transport all come from lib/mail — there is no second SMTP
// implementation here, and a guard test asserts it.
//
// Owner rules baked in:
//   • no send without a configured provider (mail_not_configured);
//   • no send unless the AUTHENTICATED transport From is the sender identity
//     we intend to send as (sender_not_authenticated). A registry default is
//     not authentication, and a mismatch is never silently substituted;
//   • no send without an explicitly configured recipient
//     (recipient_not_configured) — no address is ever hardcoded or guessed;
//   • Email C (barcode corrections) is refused server-side, whatever a caller
//     asks for (email_kind_not_sendable);
//   • the attachment set must match the workbook's own scope
//     (attachment_scope_mismatch) — a workbook and an image ZIP that disagree
//     are never sent;
//   • the delivery audit row is written ONLY AFTER the provider accepted the
//     message; a provider failure records nothing and changes nothing;
//   • nothing here transmits. planTalabatEmailSend is pure, and
//     runTalabatEmailSend only calls the ports it is handed.

import { validateRecipients, estimateEncodedBytes } from "../../mail/config.ts";
import type { TalabatEmailKind } from "./email-templates.ts";

export type TalabatEmailSendBlock =
  | "mail_not_configured"
  | "sender_not_authenticated"
  | "recipient_not_configured"
  | "invalid_recipient"
  | "email_kind_not_sendable"
  | "no_attachments"
  | "attachment_scope_mismatch"
  | "attachments_too_large"
  | "draft_not_sendable"
  | "not_confirmed"
  | "send_failed";

/**
 * The kinds a Talabat send route may carry. Email C is deliberately absent
 * from the TYPE as well as the runtime check, so a caller cannot even name it
 * without a cast — and if it does, isTalabatSendableKind still refuses.
 */
export type TalabatSendKind = "existing_updates" | "new_products";

export const TALABAT_SENDABLE_KINDS: readonly TalabatSendKind[] = ["existing_updates", "new_products"];

export function isTalabatSendableKind(kind: string): kind is TalabatSendKind {
  return (TALABAT_SENDABLE_KINDS as readonly string[]).includes(kind);
}

// ── sender authentication ────────────────────────────────────────────────────

export interface SenderTransportCheck {
  /** the address we intend to send as (the chosen identity). */
  expected: string;
  /** the address the provider actually authenticated (MailConfig.fromAddress). */
  authenticated: string | null;
  match: boolean;
}

/**
 * Compare the intended sender against the transport's own From.
 *
 * This is the whole point of the gate: a sender identity is "verified" only
 * because the provider authenticated THAT mailbox. Being the registry default
 * proves nothing. Case- and whitespace-insensitive, because that is how mail
 * addresses compare, and nothing else is normalised away.
 */
export function checkSenderTransport(expected: string, authenticatedFrom: string | null): SenderTransportCheck {
  const e = expected.trim().toLowerCase();
  const a = authenticatedFrom === null ? null : authenticatedFrom.trim().toLowerCase();
  return { expected: e, authenticated: a, match: a !== null && a !== "" && a === e };
}

/**
 * Owner-facing explanation of a mismatch, and exactly what to change.
 *
 * Names variables, never values: MAIL_FROM_ADDRESS is named as the variable to
 * set, the two ADDRESSES are shown (they are public From headers, not
 * secrets), and no password, username, host or key is referenced.
 */
export function senderMismatchGuidance(check: SenderTransportCheck): string[] {
  if (check.match) return [];
  if (check.authenticated === null) {
    return [
      "لم يتم إعداد خدمة البريد بعد (متغيرات MAIL_* غير مكتملة).",
      `المرسل المطلوب: ${check.expected}`,
      "المطلوب: ضبط MAIL_HOST و MAIL_USERNAME و MAIL_PASSWORD و MAIL_FROM_ADDRESS في بيئة النشر.",
    ];
  }
  return [
    `المرسل المطلوب: ${check.expected}`,
    `المرسل الموثّق حالياً لدى مزوّد البريد: ${check.authenticated}`,
    `المطلوب: ضبط MAIL_FROM_ADDRESS=${check.expected} في بيئة النشر،`,
    "مع بيانات SMTP لصندوق بريد مُصرّح له بالإرسال باسم هذا العنوان (SPF/DKIM للنطاق).",
    "لن يتم استبدال هوية المرسل تلقائياً — الإرسال متوقف حتى تتطابق الهوية مع النقل الموثّق.",
  ];
}

// ── planning ─────────────────────────────────────────────────────────────────

export interface TalabatPlannedAttachment {
  filename: string;
  bytes: number;
  contentType: string;
}

/**
 * What the workbook says it covers, and what the image package actually holds.
 * Both are computed upstream from the SAME allowed row set; carrying them here
 * means a divergence blocks the send instead of reaching Talabat.
 */
export interface TalabatSendScope {
  workbookRows: number;
  /** null for Email A, which has no image package. */
  imageCount: number | null;
  /** rows whose primary image is absent from the package. Must be 0. */
  rowsMissingImage: number;
  /** rows in a category Talabat policy excludes. Must be 0. */
  excludedCategoryRows: number;
}

export interface TalabatEmailSendPlanInput {
  kind: string;
  configured: boolean;
  sender: SenderTransportCheck;
  /** the owner-configured recipients, already read from settings. */
  toRaw: string;
  ccRaw: string;
  subject: string;
  text: string;
  attachments: TalabatPlannedAttachment[];
  attachmentMaxBytes: number;
  scope: TalabatSendScope;
  /** fail-closed reasons carried from the built draft. */
  draftBlockers: readonly string[];
  /** the owner's explicit «إرسال الآن». A send is never implied by generation. */
  ownerConfirmed: boolean;
}

export interface TalabatEmailSendPlan {
  kind: TalabatSendKind;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: TalabatPlannedAttachment[];
  totalAttachmentBytes: number;
  encodedEstimateBytes: number;
}

export type TalabatEmailSendPlanResult =
  | { ok: true; plan: TalabatEmailSendPlan }
  | { ok: false; error: TalabatEmailSendBlock; invalid?: string[] };

/**
 * Gate + shape one send. Pure — nothing is transmitted here.
 *
 * Order matters and is deliberate: the kind is refused before anything else is
 * even looked at, so an Email C request never reaches recipient or attachment
 * handling; then transport truth; then the owner's intent; then the payload.
 */
export function planTalabatEmailSend(input: TalabatEmailSendPlanInput): TalabatEmailSendPlanResult {
  if (!isTalabatSendableKind(input.kind)) return { ok: false, error: "email_kind_not_sendable" };
  if (!input.configured) return { ok: false, error: "mail_not_configured" };
  if (!input.sender.match) return { ok: false, error: "sender_not_authenticated" };
  if (input.draftBlockers.length > 0) return { ok: false, error: "draft_not_sendable" };
  if (!input.ownerConfirmed) return { ok: false, error: "not_confirmed" };

  // A blank recipient is a DIFFERENT failure from a malformed one: nothing is
  // configured yet, versus something is configured wrongly. The owner needs to
  // know which, so the two never collapse into one message.
  if (input.toRaw.trim() === "") return { ok: false, error: "recipient_not_configured" };
  const recipients = validateRecipients(input.toRaw, input.ccRaw);
  if (!recipients.ok) return { ok: false, error: "invalid_recipient", invalid: recipients.invalid };

  if (input.attachments.length === 0) return { ok: false, error: "no_attachments" };
  if (!scopeConsistent(input.scope)) return { ok: false, error: "attachment_scope_mismatch" };

  const totalAttachmentBytes = input.attachments.reduce((s, a) => s + a.bytes, 0);
  const encodedEstimateBytes = estimateEncodedBytes(input.attachments.map((a) => a.bytes), input.text.length);
  if (encodedEstimateBytes > estimateEncodedBytes([input.attachmentMaxBytes])) {
    return { ok: false, error: "attachments_too_large" };
  }
  return {
    ok: true,
    plan: {
      kind: input.kind,
      from: input.sender.expected,
      to: recipients.to,
      cc: recipients.cc,
      subject: input.subject,
      text: input.text,
      attachments: input.attachments,
      totalAttachmentBytes,
      encodedEstimateBytes,
    },
  };
}

/** Every scope invariant the owner asked the preflight to verify. */
export function scopeConsistent(scope: TalabatSendScope): boolean {
  if (scope.workbookRows <= 0) return false;
  if (scope.rowsMissingImage !== 0) return false;
  if (scope.excludedCategoryRows !== 0) return false;
  if (scope.imageCount !== null && scope.imageCount <= 0) return false;
  return true;
}

// ── running ──────────────────────────────────────────────────────────────────

export interface TalabatEmailAuditRecord {
  emailKind: TalabatSendKind;
  sender: string;
  recipients: string[];
  cc: string[];
  subject: string;
  sentAtIso: string;
  providerMessageId: string | null;
  attachmentFilenames: string[];
  createdBy: string;
  status: "sent";
}

export interface TalabatEmailSendPorts {
  send(plan: TalabatEmailSendPlan): Promise<{ ok: true; messageId: string | null } | { ok: false; detail: string }>;
  /** persist the delivery audit. Called ONLY after a successful send. */
  recordAudit(record: TalabatEmailAuditRecord): Promise<boolean>;
}

export type TalabatEmailSendRunResult =
  | { ok: true; messageId: string | null; auditRecorded: boolean }
  | { ok: false; error: "send_failed"; detail: string };

/**
 * Execute one planned send: provider FIRST, audit ONLY on provider success.
 * A provider failure records nothing and mutates nothing.
 */
export async function runTalabatEmailSend(
  plan: TalabatEmailSendPlan,
  meta: { sentAtIso: string; createdBy: string },
  ports: TalabatEmailSendPorts,
): Promise<TalabatEmailSendRunResult> {
  const sent = await ports.send(plan);
  if (!sent.ok) return { ok: false, error: "send_failed", detail: sent.detail };
  const auditRecorded = await ports.recordAudit({
    emailKind: plan.kind,
    sender: plan.from,
    recipients: plan.to,
    cc: plan.cc,
    subject: plan.subject,
    sentAtIso: meta.sentAtIso,
    providerMessageId: sent.messageId,
    attachmentFilenames: plan.attachments.map((a) => a.filename),
    createdBy: meta.createdBy,
    status: "sent",
  });
  return { ok: true, messageId: sent.messageId, auditRecorded };
}

/** Fixed Arabic UI messages — raw provider text never renders. */
export const TALABAT_SEND_ERROR_AR: Record<TalabatEmailSendBlock | "forbidden" | "artifact_not_found", string> = {
  mail_not_configured: "لم يتم إعداد مزوّد البريد بعد — أضف إعدادات SMTP (متغيرات البيئة) أولاً.",
  sender_not_authenticated:
    "هوية المرسل غير موثّقة لدى مزوّد البريد — عنوان النقل الموثّق مختلف عن المرسل المطلوب. لن يتم الإرسال ولن يتم استبدال الهوية تلقائياً.",
  recipient_not_configured: "لم يتم ضبط مستلم طلبات في إعدادات البريد — أضف عنوان المستلم أولاً.",
  invalid_recipient: "عنوان البريد غير صالح — تحقق من حقل المستلمين.",
  email_kind_not_sendable:
    "هذا النوع من الرسائل غير مسموح بإرساله (مراجعة الباركود للعرض فقط).",
  no_attachments: "لا توجد مرفقات جاهزة لهذه الرسالة.",
  attachment_scope_mismatch:
    "نطاق الملف والصور غير متطابق — لن يُرسل ملف لا تطابقه الصور المرفقة.",
  attachments_too_large: "المرفقات أكبر من الحد المسموح للإرسال عبر البريد.",
  draft_not_sendable: "المسودة غير مكتملة — لن يُرسل أي إيميل حتى تكتمل.",
  not_confirmed: "الإرسال يتطلب تأكيداً صريحاً من المالك.",
  send_failed: "تعذّر إرسال الإيميل عبر مزوّد البريد — لم يتغيّر أي شيء، حاول مرة أخرى.",
  forbidden: "إرسال بريد طلبات متاح للمالك فقط.",
  artifact_not_found: "لا توجد ملفات جاهزة لهذه الرسالة.",
};

export function talabatSendErrorMessageAr(code: string | null | undefined): string {
  return TALABAT_SEND_ERROR_AR[(code ?? "") as TalabatEmailSendBlock] ?? TALABAT_SEND_ERROR_AR.send_failed;
}

/** Email C never reaches a transport, whatever kind a caller names. */
export function refusesBarcodeCorrections(kind: TalabatEmailKind): boolean {
  return kind === "barcode_corrections" ? !isTalabatSendableKind(kind) : false;
}
