// TALABAT EMAIL WORKFLOW — Generate → Preview → Test Send (PURE).
//
// The V2 workflow's decision layer. Everything that decides whether something
// may be sent lives here, so the screen renders answers rather than computing
// them and the server enforces the same rules the owner was shown.
//
// Three ideas carry the safety:
//
//   1. A CONFIRMATION IS FOR ONE EXACT MESSAGE. It is a fingerprint over the
//      recipient, subject, attachment set and artifact run. Edit any of them
//      and the token changes, so the earlier confirmation no longer matches and
//      the send is refused. "I confirmed already" can never mean "confirmed
//      something else".
//
//   2. A TEST IS VISIBLY A TEST. Same transport, same sender, same renderer,
//      same MIME — only the presentation differs, and it differs in the two
//      places a human actually reads: the subject line and the first line of
//      the body.
//
//   3. SIZE IS CHECKED AGAINST A REAL LIMIT, NOT A HOPE. An oversize message is
//      refused outright. It is never silently split, and its images are never
//      silently dropped — a smaller email than the one the owner reviewed is a
//      worse outcome than no email.

import { estimateEncodedBytes } from "../../mail/config.ts";
import { mailNoticeBanner, mailShellPrepend } from "../../mail/mail-shell.ts";
import type { TalabatSendKind } from "./email-send.ts";

// ── test presentation ────────────────────────────────────────────────────────

export const TEST_SUBJECT_PREFIX = "[TEST] ";
export const TEST_BODY_NOTICE = "INTERNAL TEST — NOT SENT TO TALABAT";

export type SendMode = "test" | "official";

/** `[TEST] …`, applied once however many times a caller re-wraps it. */
export function testSubject(subject: string): string {
  return subject.startsWith(TEST_SUBJECT_PREFIX) ? subject : `${TEST_SUBJECT_PREFIX}${subject}`;
}

/**
 * The notice goes FIRST, before the greeting. A test that reads like the real
 * thing until paragraph three is a test someone forwards by mistake.
 */
export function testBody(bodyText: string): string {
  return bodyText.startsWith(TEST_BODY_NOTICE) ? bodyText : `${TEST_BODY_NOTICE}\n\n${bodyText}`;
}

/**
 * STEP 89 — the HTML counterpart of TEST_BODY_NOTICE.
 *
 * Same warning, same position, but rendered as the house notice banner instead
 * of a bare line of text: the test has to LOOK like the real email so the owner
 * can judge the real email by it, while still being unmistakably a test.
 */
export const TEST_BANNER_TITLE = "INTERNAL TEST";
export const TEST_BANNER_DETAIL = "This email has not been sent to Talabat.";

export function testBodyHtml(bodyHtml: string): string {
  return bodyHtml.includes(TEST_BANNER_DETAIL)
    ? bodyHtml
    : mailShellPrepend(bodyHtml, mailNoticeBanner(TEST_BANNER_TITLE, TEST_BANNER_DETAIL));
}

/**
 * Present ONE draft for a mode. Subject, plain text and HTML are marked as a
 * test together — a body that says "test" under a subject that does not (or the
 * reverse) is how a rehearsal gets mistaken for the real thing.
 */
export function presentForMode(
  mode: SendMode, subject: string, bodyText: string, bodyHtml?: string | null,
): { subject: string; bodyText: string; bodyHtml: string | null } {
  const html = bodyHtml ?? null;
  return mode === "test"
    ? {
        subject: testSubject(subject),
        bodyText: testBody(bodyText),
        bodyHtml: html === null ? null : testBodyHtml(html),
      }
    : { subject, bodyText, bodyHtml: html };
}

// ── attachment size ──────────────────────────────────────────────────────────

export interface AttachmentSizeInput {
  filename: string;
  bytes: number;
}

export interface AttachmentSizeReport {
  files: AttachmentSizeInput[];
  rawAttachmentBytes: number;
  /** provider-safe estimate of the ENCODED message, headers and base64 included. */
  estimatedMessageBytes: number;
  /** the configured cap this is judged against. */
  limitBytes: number;
  withinLimit: boolean;
  /** how far over, 0 when within. Shown so the gap is legible, not just "too big". */
  overBy: number;
}

/**
 * Measure one message against the configured cap.
 *
 * The estimate is deliberately pessimistic (base64 inflation, per-part headers,
 * the body itself): refusing a borderline message beats a provider rejecting it
 * mid-transfer, having already spent the upload.
 */
export function attachmentSizeReport(
  files: readonly AttachmentSizeInput[],
  bodyBytes: number,
  limitBytes: number,
): AttachmentSizeReport {
  const rawAttachmentBytes = files.reduce((s, f) => s + f.bytes, 0);
  const estimatedMessageBytes = estimateEncodedBytes(files.map((f) => f.bytes), bodyBytes);
  const withinLimit = limitBytes > 0 && estimatedMessageBytes <= estimateEncodedBytes([limitBytes]);
  return {
    files: files.map((f) => ({ filename: f.filename, bytes: f.bytes })),
    rawAttachmentBytes,
    estimatedMessageBytes,
    limitBytes,
    withinLimit,
    overBy: withinLimit ? 0 : Math.max(0, rawAttachmentBytes - limitBytes),
  };
}

/**
 * What to tell the owner when a message cannot be emailed at all.
 *
 * Points at the mechanism this codebase ALREADY has — Rafeeq delivers its
 * certified ZIP by a scoped signed link instead of attaching it — rather than
 * inventing a file-sharing scheme. Naming the existing answer is the useful
 * thing to say; building it is a separate, reviewed change.
 */
export function oversizeGuidance(report: AttachmentSizeReport): string[] {
  if (report.withinLimit) return [];
  return [
    `حجم المرفقات ${mb(report.rawAttachmentBytes)} ميغابايت، والحد المسموح ${mb(report.limitBytes)} ميغابايت.`,
    "لن يتم تقسيم الرسالة ولن تُحذف أي صور تلقائياً — الإرسال متوقف.",
    "البديل المتاح في النظام: تسليم الملف الكبير عبر رابط تنزيل موقّع ومحدود الصلاحية (نفس آلية رفيق) بدل إرفاقه.",
  ];
}

const mb = (b: number) => (b / (1024 * 1024)).toFixed(1);

// ── confirmation binding ─────────────────────────────────────────────────────

export interface ConfirmationSubject {
  kind: TalabatSendKind;
  mode: SendMode;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /**
   * STEP 89B — the greeting the owner wrote for THIS message. In the token
   * because it is part of what they are confirming: editing "Dear July," to
   * "Dear Talabat Team," after ticking the box changes who the letter
   * addresses, and a confirmation that survived that would be a confirmation
   * of a different message.
   */
  greeting: string;
  attachmentFilenames: string[];
  runFingerprint: string;
}

/**
 * A stable token for EXACTLY this message.
 *
 * Recipients are normalised and sorted (order is not a difference) but never
 * de-duplicated away from the set itself; everything else is taken verbatim.
 * Any edit the owner makes after confirming produces a different token, so the
 * stale confirmation simply stops matching.
 */
export function confirmationToken(s: ConfirmationSubject): string {
  const norm = (xs: readonly string[]) => [...xs].map((x) => x.trim().toLowerCase()).sort().join(",");
  // "c2": the token gained the greeting, so a token minted by the previous
  // shape can never be mistaken for a match on the new one.
  return [
    "c2", s.kind, s.mode, s.from.trim().toLowerCase(),
    norm(s.to), norm(s.cc), s.subject, s.greeting.trim(),
    norm(s.attachmentFilenames), s.runFingerprint,
  ].join("|");
}

export type ConfirmationCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "stale" };

/**
 * Compare what the owner confirmed against what is about to be sent.
 *
 * A missing token and a stale one are different answers on purpose: one means
 * "you have not confirmed", the other means "what you confirmed is not this".
 */
export function checkConfirmation(presented: string | null, actual: ConfirmationSubject): ConfirmationCheck {
  if (presented === null || presented.trim() === "") return { ok: false, reason: "missing" };
  return presented === confirmationToken(actual) ? { ok: true } : { ok: false, reason: "stale" };
}

// ── the workflow gate ────────────────────────────────────────────────────────

export type WorkflowBlock =
  | "sender_not_verified"
  | "artifact_missing"
  | "artifact_stale"
  | "recipient_missing"
  | "recipient_invalid"
  | "greeting_missing"
  | "attachments_too_large"
  | "not_confirmed"
  | "confirmation_stale"
  | "official_send_disabled"
  | "delivery_log_not_ready";

/**
 * OFFICIAL SEND IS OFF.
 *
 * A constant, not a setting, so nothing at runtime can flip it: enabling the
 * real send is a code change that has to be read and reviewed. The workflow
 * still renders the action so the owner can see where it will be, disabled with
 * the reason.
 */
export const OFFICIAL_SEND_ENABLED = false;

export const OFFICIAL_SEND_DISABLED_AR = "اختبر البريد أولاً قبل الإرسال الرسمي";

export interface WorkflowGateInput {
  mode: SendMode;
  senderVerified: boolean;
  artifactPresent: boolean;
  artifactFresh: boolean;
  recipientPresent: boolean;
  recipientValid: boolean;
  /** the owner wrote a greeting for this send. Never defaulted for them. */
  greetingPresent: boolean;
  sizeWithinLimit: boolean;
  confirmation: ConfirmationCheck;
  deliveryLogReady: boolean;
}

export function evaluateWorkflowGate(input: WorkflowGateInput): WorkflowBlock[] {
  const blocks: WorkflowBlock[] = [];
  // An official send is refused before anything else is examined — there is no
  // combination of correct inputs that turns it on in this build.
  if (input.mode === "official" && !OFFICIAL_SEND_ENABLED) blocks.push("official_send_disabled");
  if (!input.senderVerified) blocks.push("sender_not_verified");
  if (!input.artifactPresent) blocks.push("artifact_missing");
  else if (!input.artifactFresh) blocks.push("artifact_stale");
  if (!input.recipientPresent) blocks.push("recipient_missing");
  else if (!input.recipientValid) blocks.push("recipient_invalid");
  if (!input.greetingPresent) blocks.push("greeting_missing");
  if (!input.sizeWithinLimit) blocks.push("attachments_too_large");
  if (!input.deliveryLogReady) blocks.push("delivery_log_not_ready");
  if (!input.confirmation.ok) {
    blocks.push(input.confirmation.reason === "missing" ? "not_confirmed" : "confirmation_stale");
  }
  return blocks;
}

export const WORKFLOW_BLOCK_AR: Record<WorkflowBlock, string> = {
  sender_not_verified: "هوية المرسل غير موثّقة لدى مزوّد البريد.",
  artifact_missing: "لم يتم توليد ملفات هذه الرسالة بعد.",
  artifact_stale: "الملفات المولّدة تعود لمقارنة سابقة — أعد التوليد.",
  recipient_missing: "أدخل عنوان المستلم.",
  recipient_invalid: "عنوان المستلم غير صالح.",
  greeting_missing: "اكتب التحية قبل الإرسال.",
  attachments_too_large: "حجم المرفقات يتجاوز الحد المسموح لدى مزوّد البريد.",
  not_confirmed: "الإرسال يتطلب تأكيداً صريحاً.",
  confirmation_stale: "تغيّرت بيانات الرسالة بعد التأكيد — أعد التأكيد.",
  official_send_disabled: OFFICIAL_SEND_DISABLED_AR,
  delivery_log_not_ready: "سجل الإرسال غير جاهز لتسجيل رسائل الاختبار.",
};
