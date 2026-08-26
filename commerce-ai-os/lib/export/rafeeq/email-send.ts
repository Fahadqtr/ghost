// RAFEEQ DIRECT SEND — planning + run engine (PURE, port-driven).
//
// Owner rules baked in:
//   • sending operates ONLY on an existing COMPLETED package's stored artifact
//     — nothing here can regenerate anything (no generation import exists);
//   • no send without a configured provider (mail_not_configured);
//   • invalid/missing recipients block the send (invalid_recipient);
//   • an attachment set whose provider-safe ENCODED estimate exceeds the cap
//     blocks the send (attachments_too_large) — never a silent partial set;
//   • the delivery audit record is written ONLY AFTER a successful provider
//     response; a provider failure writes nothing and leaves all state
//     unchanged;
//   • direct email send NEVER marks the package as the Rafeeq SENT baseline —
//     «تم الإرسال إلى رفيق» remains a separate explicit owner action.

import { validateRecipients, estimateEncodedBytes } from "../../mail/config.ts";

export type RafeeqEmailSendBlock =
  | "mail_not_configured"
  | "invalid_recipient"
  | "no_attachments"
  | "attachments_too_large"
  | "send_failed";

export interface RafeeqPlannedAttachment {
  filename: string;
  bytes: number;
  contentType: string;
}

export interface RafeeqEmailSendPlanInput {
  configured: boolean;
  toRaw: string;
  ccRaw: string;
  subject: string;
  html: string;
  /** mobile-safe plain-text alternative (same facts as html). */
  text: string;
  attachments: RafeeqPlannedAttachment[];
  attachmentMaxBytes: number;
}

export interface RafeeqEmailSendPlan {
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  text: string;
  attachments: RafeeqPlannedAttachment[];
  totalAttachmentBytes: number;
  encodedEstimateBytes: number;
}

export type RafeeqEmailSendPlanResult =
  | { ok: true; plan: RafeeqEmailSendPlan }
  | { ok: false; error: RafeeqEmailSendBlock; invalid?: string[] };

/** Gate + shape one send. Pure — nothing is transmitted here. */
export function planRafeeqEmailSend(input: RafeeqEmailSendPlanInput): RafeeqEmailSendPlanResult {
  if (!input.configured) return { ok: false, error: "mail_not_configured" };
  const recipients = validateRecipients(input.toRaw, input.ccRaw);
  if (!recipients.ok) return { ok: false, error: "invalid_recipient", invalid: recipients.invalid };
  if (input.attachments.length === 0) return { ok: false, error: "no_attachments" };
  const totalAttachmentBytes = input.attachments.reduce((s, a) => s + a.bytes, 0);
  const encodedEstimateBytes = estimateEncodedBytes(
    input.attachments.map((a) => a.bytes),
    input.html.length + input.text.length,
  );
  const encodedCap = estimateEncodedBytes([input.attachmentMaxBytes]);
  if (encodedEstimateBytes > encodedCap) return { ok: false, error: "attachments_too_large" };
  return {
    ok: true,
    plan: {
      to: recipients.to,
      cc: recipients.cc,
      subject: input.subject,
      html: input.html,
      text: input.text,
      attachments: input.attachments,
      totalAttachmentBytes,
      encodedEstimateBytes,
    },
  };
}

export interface RafeeqEmailAuditRecord {
  jobId: string;
  packageId: string | null;
  sender: string;
  recipients: string[];
  cc: string[];
  subject: string;
  sentAtIso: string;
  providerMessageId: string | null;
  attachmentFilenames: string[];
  status: "sent";
}

export interface RafeeqEmailSendPorts {
  /** transmit via the configured provider. Never called before planning passed. */
  send(plan: RafeeqEmailSendPlan): Promise<{ ok: true; messageId: string | null } | { ok: false; detail: string }>;
  /** persist the delivery audit. Called ONLY after a successful send. */
  recordAudit(record: RafeeqEmailAuditRecord): Promise<boolean>;
}

export type RafeeqEmailSendRunResult =
  | { ok: true; messageId: string | null; auditRecorded: boolean }
  | { ok: false; error: "send_failed"; detail: string };

/**
 * Execute one planned send: provider FIRST, audit ONLY on provider success.
 * A provider failure records nothing and mutates nothing.
 */
export async function runRafeeqEmailSend(
  plan: RafeeqEmailSendPlan,
  meta: { jobId: string; packageId: string | null; sender: string; sentAtIso: string },
  ports: RafeeqEmailSendPorts,
): Promise<RafeeqEmailSendRunResult> {
  const sent = await ports.send(plan);
  if (!sent.ok) return { ok: false, error: "send_failed", detail: sent.detail };
  const auditRecorded = await ports.recordAudit({
    jobId: meta.jobId,
    packageId: meta.packageId,
    sender: meta.sender,
    recipients: plan.to,
    cc: plan.cc,
    subject: plan.subject,
    sentAtIso: meta.sentAtIso,
    providerMessageId: sent.messageId,
    attachmentFilenames: plan.attachments.map((a) => a.filename),
    status: "sent",
  });
  return { ok: true, messageId: sent.messageId, auditRecorded };
}

/** Fixed Arabic UI messages for send blocks — raw provider text never renders. */
export const RAFEEQ_SEND_ERROR_AR: Record<RafeeqEmailSendBlock | "forbidden" | "job_not_found" | "package_link_unavailable", string> = {
  package_link_unavailable:
    "تعذّر تجهيز رابط التنزيل الآمن للحزمة (فشل الرفع أو التحقق من الحجم) — لن يُرسل أي إيميل بدون رابط مُتحقق. حاول مرة أخرى أو راجع حد رفع الملفات في Supabase.",
  mail_not_configured: "لم يتم إعداد مزود البريد بعد — أضف إعدادات SMTP (متغيرات البيئة) أولاً.",
  invalid_recipient: "عنوان البريد غير صالح — تحقق من حقل المستلمين.",
  no_attachments: "لا توجد مرفقات جاهزة من الحزمة المكتملة.",
  attachments_too_large: "الحزمة أكبر من الحد المسموح للإرسال عبر البريد.",
  send_failed: "تعذّر إرسال الإيميل عبر مزود البريد — لم يتغيّر أي شيء، حاول مرة أخرى.",
  forbidden: "الإرسال المباشر متاح للمالك فقط.",
  job_not_found: "لا توجد حزمة مكتملة لهذه العملية.",
};

export function rafeeqSendErrorMessageAr(code: string | null | undefined): string {
  return RAFEEQ_SEND_ERROR_AR[(code ?? "") as RafeeqEmailSendBlock] ?? RAFEEQ_SEND_ERROR_AR.send_failed;
}

// ── stored-artifact attachment extraction (PURE) ─────────────────────────────
// The chunked job's FINAL part begins with the xlsx entry segment followed by
// the manifest entry segment (STORE, then the central directory). Slicing the
// workbook + manifest out of that one stored part is a pure read — the
// package is never rebuilt and no other part is needed.

export interface ExtractedZipEntry {
  filename: string;
  bytes: Uint8Array;
}

/**
 * Parse consecutive STORE local-file entries from the start of a ZIP segment,
 * stopping at the central directory. Returns [] on any structural mismatch —
 * the caller treats that as "attachment unavailable", never as data to fake.
 */
export function extractLeadingZipEntries(segment: Uint8Array, maxEntries = 8): ExtractedZipEntry[] {
  const out: ExtractedZipEntry[] = [];
  const dv = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
  let at = 0;
  while (out.length < maxEntries && at + 30 <= segment.length) {
    const sig = dv.getUint32(at, true);
    if (sig === 0x02014b50) break; // central directory — done
    if (sig !== 0x04034b50) return out; // not a local header — stop cleanly
    const method = dv.getUint16(at + 8, true);
    const size = dv.getUint32(at + 18, true);
    const uncompressed = dv.getUint32(at + 22, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extraLen = dv.getUint16(at + 28, true);
    if (method !== 0 || size !== uncompressed) return out; // STORE only
    const dataStart = at + 30 + nameLen + extraLen;
    if (dataStart + size > segment.length) return out;
    const filename = new TextDecoder().decode(segment.subarray(at + 30, at + 30 + nameLen));
    out.push({ filename, bytes: segment.subarray(dataStart, dataStart + size) });
    at = dataStart + size;
  }
  return out;
}
