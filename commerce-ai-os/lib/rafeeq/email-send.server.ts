// RAFEEQ DIRECT SEND — server orchestration (SERVER-ONLY, OWNER-GATED at the
// route).
//
// Operates ONLY on an existing COMPLETED package job's stored artifact:
//   • attachments are sliced/concatenated from the ALREADY-STORED parts
//     (the same read-only references the download routes use) — nothing is
//     ever regenerated;
//   • no provider configured (env vars missing) → every surface reports
//     mail_not_configured and nothing can be sent;
//   • the ZIP is attached only when it fits the configured cap — otherwise
//     the send proceeds with the workbook + manifest and the body already
//     carries "The full catalog package will be shared separately.";
//   • the delivery audit row (rafeeq_email_deliveries) is written ONLY after
//     the provider accepted the message; provider failure changes nothing;
//   • sending an email NEVER touches rafeeq_packages.sent_at — the Rafeeq
//     SENT baseline remains the separate explicit owner action.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getMailConfig, sendMailViaSmtp } from "@/lib/mail/smtp.server";
import { isValidEmailAddress } from "@/lib/mail/config";
import {
  planRafeeqEmailSend,
  runRafeeqEmailSend,
  extractLeadingZipEntries,
  type RafeeqPlannedAttachment,
  type RafeeqEmailSendBlock,
} from "@/lib/export/rafeeq/email-send";
import {
  buildRafeeqEmailDraftForJob,
  getRafeeqPackageArtifact,
  readRafeeqPackagePart,
} from "@/lib/rafeeq/package-job.server";

const RECIPIENT_SETTING_KEY = "rafeeq_email_recipient";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type RafeeqSendApiError = RafeeqEmailSendBlock | "job_not_found";
export type RafeeqSendApiResult<T> = { ok: true; value: T } | { ok: false; error: RafeeqSendApiError; status: number };
const sendErr = <T,>(error: RafeeqSendApiError, status: number): RafeeqSendApiResult<T> => ({ ok: false, error, status });

export interface RafeeqSendPreflightDTO {
  configured: boolean;
  /** display-only From ("Name <address>") — null while unconfigured. Never credentials. */
  from: string | null;
  attachmentMaxBytes: number;
  subject: string;
  zipFilename: string;
  zipTotalBytes: number;
  /** true ⇒ the whole ZIP fits under the cap and may be attached. */
  zipAttachable: boolean;
  /** the default attachment set (workbook + manifest; ZIP listed when attachable). */
  attachments: { filename: string; bytes: number; kind: "xlsx" | "manifest" | "zip" }[];
  generatedAt: string;
  productCount: number;
  imageCount: number;
  packageId: string | null;
  /** explicit owner-saved Rafeeq recipient (app_settings) — "" when unset. NEVER guessed. */
  savedRecipient: string;
}

interface JobRowLite {
  status: string;
  created_at: string;
  products_total: number;
  images_done: number;
  package_id: string | null;
}

async function readJobRow(jobId: string): Promise<JobRowLite | null> {
  const admin = createAdminClient();
  const res = await admin
    .from("rafeeq_package_jobs")
    .select("status, created_at, products_total, images_done, package_id")
    .eq("id", jobId)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return res.data as unknown as JobRowLite;
}

/** Defensive read of the explicit owner-saved recipient. Unset/missing table → "". */
async function readSavedRecipient(): Promise<string> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.from("app_settings").select("value").eq("key", RECIPIENT_SETTING_KEY).maybeSingle();
    if (error) return "";
    const to = (data as { value?: { to?: unknown } } | null)?.value?.to;
    return typeof to === "string" && isValidEmailAddress(to) ? to : "";
  } catch {
    return "";
  }
}

/** Workbook + manifest sliced from the stored tail part (read-only, no rebuild). */
async function loadTailAttachments(
  parts: { path: string; bytes: number }[],
): Promise<{ filename: string; bytes: Uint8Array; contentType: string }[]> {
  const tailPath = parts[parts.length - 1]?.path;
  if (!tailPath) return [];
  const tail = await readRafeeqPackagePart(tailPath);
  if (!tail) return [];
  return extractLeadingZipEntries(tail)
    .filter((e) => !e.filename.startsWith("images/"))
    .map((e) => ({
      filename: e.filename,
      bytes: e.bytes,
      contentType: e.filename.endsWith(".xlsx") ? XLSX_MIME : "application/json",
    }));
}

/** Everything the confirmation modal shows BEFORE the owner can confirm. READ-ONLY. */
export async function getRafeeqEmailSendPreflight(jobId: string): Promise<RafeeqSendApiResult<RafeeqSendPreflightDTO>> {
  const row = await readJobRow(jobId);
  if (!row || row.status !== "complete") return sendErr("job_not_found", 404);
  const artifact = await getRafeeqPackageArtifact(jobId);
  if (!artifact.ok) return sendErr("job_not_found", artifact.status);
  const draft = await buildRafeeqEmailDraftForJob(jobId);
  if (!draft.ok) return sendErr("job_not_found", draft.status);

  const config = getMailConfig();
  const maxBytes = config?.attachmentMaxBytes ?? 0;
  const tailAttachments = await loadTailAttachments(artifact.value.parts);
  const base = tailAttachments.map((a) => ({
    filename: a.filename,
    bytes: a.bytes.length,
    kind: a.filename.endsWith(".xlsx") ? ("xlsx" as const) : ("manifest" as const),
  }));
  const baseBytes = base.reduce((s, a) => s + a.bytes, 0);
  const zipAttachable = config !== null && artifact.value.totalBytes + baseBytes <= maxBytes;

  return {
    ok: true,
    value: {
      configured: config !== null,
      from: config ? `${config.fromName} <${config.fromAddress}>` : null,
      attachmentMaxBytes: maxBytes,
      subject: draft.value.subject,
      zipFilename: artifact.value.filename,
      zipTotalBytes: artifact.value.totalBytes,
      zipAttachable,
      attachments: zipAttachable
        ? [...base, { filename: artifact.value.filename, bytes: artifact.value.totalBytes, kind: "zip" as const }]
        : base,
      generatedAt: row.created_at,
      productCount: row.products_total,
      imageCount: row.images_done,
      packageId: row.package_id,
      savedRecipient: await readSavedRecipient(),
    },
  };
}

export interface RafeeqSendRequest {
  toRaw: string;
  ccRaw: string;
  /** attach the whole ZIP too (only honored when it fits the cap). */
  includeZip: boolean;
  /** explicit owner choice to store toRaw as the default Rafeeq recipient. */
  saveRecipient: boolean;
}

export interface RafeeqSendResultDTO {
  sent: true;
  messageId: string | null;
  auditRecorded: boolean;
  attachmentFilenames: string[];
}

/**
 * Send the completed package by email after the owner's explicit confirmation.
 * Provider first; audit only on provider success; sent-baseline untouched.
 */
export async function sendRafeeqPackageEmail(
  jobId: string,
  req: RafeeqSendRequest,
): Promise<RafeeqSendApiResult<RafeeqSendResultDTO>> {
  const config = getMailConfig();
  if (!config) return sendErr("mail_not_configured", 503);

  const row = await readJobRow(jobId);
  if (!row || row.status !== "complete") return sendErr("job_not_found", 404);
  const artifact = await getRafeeqPackageArtifact(jobId);
  if (!artifact.ok) return sendErr("job_not_found", artifact.status);
  const draft = await buildRafeeqEmailDraftForJob(jobId);
  if (!draft.ok) return sendErr("job_not_found", draft.status);

  const tailAttachments = await loadTailAttachments(artifact.value.parts);
  if (tailAttachments.length === 0) return sendErr("no_attachments", 409);
  const attachmentsBytes = new Map(tailAttachments.map((a) => [a.filename, a.bytes]));
  const planned: RafeeqPlannedAttachment[] = tailAttachments.map((a) => ({
    filename: a.filename,
    bytes: a.bytes.length,
    contentType: a.contentType,
  }));

  if (req.includeZip) {
    // size-gate BEFORE loading anything: an oversized ZIP is refused outright
    // (never a silent partial attachment set).
    const baseBytes = planned.reduce((s, a) => s + a.bytes, 0);
    if (artifact.value.totalBytes + baseBytes > config.attachmentMaxBytes) {
      return sendErr("attachments_too_large", 413);
    }
    const zip = new Uint8Array(artifact.value.totalBytes);
    let at = 0;
    for (const part of artifact.value.parts) {
      const bytes = await readRafeeqPackagePart(part.path);
      if (!bytes || bytes.length !== part.bytes) return sendErr("no_attachments", 409);
      zip.set(bytes, at);
      at += bytes.length;
    }
    attachmentsBytes.set(artifact.value.filename, zip);
    planned.push({ filename: artifact.value.filename, bytes: zip.length, contentType: "application/zip" });
  }

  const plan = planRafeeqEmailSend({
    configured: true,
    toRaw: req.toRaw,
    ccRaw: req.ccRaw,
    subject: draft.value.subject,
    html: draft.value.html,
    text: draft.value.textEmail,
    attachments: planned,
    attachmentMaxBytes: config.attachmentMaxBytes,
  });
  if (!plan.ok) return sendErr(plan.error, plan.error === "attachments_too_large" ? 413 : 422);

  const sentAtIso = new Date().toISOString();
  const result = await runRafeeqEmailSend(
    plan.plan,
    { jobId, packageId: row.package_id, sender: config.fromAddress, sentAtIso },
    {
      send: (p) =>
        sendMailViaSmtp(config, {
          to: p.to,
          cc: p.cc,
          subject: p.subject,
          html: p.html,
          text: p.text,
          attachments: p.attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.from(attachmentsBytes.get(a.filename) ?? new Uint8Array()),
            contentType: a.contentType,
          })),
        }),
      recordAudit: async (record) => {
        try {
          const admin = createAdminClient();
          const { error } = await admin.from("rafeeq_email_deliveries").insert({
            job_id: record.jobId,
            package_id: record.packageId,
            sender: record.sender,
            recipients: record.recipients,
            cc: record.cc,
            subject: record.subject,
            sent_at: record.sentAtIso,
            provider_message_id: record.providerMessageId,
            attachment_filenames: record.attachmentFilenames,
            status: record.status,
          });
          return !error;
        } catch {
          return false;
        }
      },
    },
  );
  if (!result.ok) return sendErr("send_failed", 502);

  if (req.saveRecipient) {
    // explicit owner choice only — stored via the existing app_settings infra.
    try {
      const admin = createAdminClient();
      await admin.from("app_settings").upsert({
        key: RECIPIENT_SETTING_KEY,
        value: { to: req.toRaw.trim() },
        updated_at: sentAtIso,
      });
    } catch {
      // saving the convenience default must never fail the completed send.
    }
  }

  return {
    ok: true,
    value: {
      sent: true,
      messageId: result.messageId,
      auditRecorded: result.auditRecorded,
      attachmentFilenames: plan.plan.attachments.map((a) => a.filename),
    },
  };
}
