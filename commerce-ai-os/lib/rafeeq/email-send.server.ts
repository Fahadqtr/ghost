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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMailConfig, sendMailViaSmtp } from "@/lib/mail/smtp.server";
import { isValidEmailAddress, diagnoseMailEnv, blockingMailEnvNames, type MailEnvDiagnostic } from "@/lib/mail/config";
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
import { createRafeeqPackageSignedLink } from "@/lib/rafeeq/artifact-object.server";
import { RAFEEQ_GUIDE_PNG } from "@/lib/export/rafeeq/email-draft";

const RECIPIENT_SETTING_KEY = "rafeeq_email_recipient";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type RafeeqSendApiError = RafeeqEmailSendBlock | "job_not_found" | "package_link_unavailable" | "guide_unavailable";
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
  /**
   * The certified ZIP is NEVER attached — it is delivered by a scoped signed
   * direct-download link from private object storage. null ⇒ the stored
   * object could not be prepared/verified, and sending is blocked.
   */
  zipLink: { sha256: string; bytes: number; expiresAtIso: string } | null;
  /** the attachment set (workbook + manifest + reading guide — the ZIP is link-delivered). */
  attachments: { filename: string; bytes: number; kind: "xlsx" | "manifest" | "guide" }[];
  generatedAt: string;
  productCount: number;
  imageCount: number;
  packageId: string | null;
  /** explicit owner-saved Rafeeq recipient (app_settings) — "" when unset. NEVER guessed. */
  savedRecipient: string;
  /**
   * Owner-only runtime diagnostic of the mail environment: BOOLEANS ONLY
   * (per-variable present/valid state + mailConfigResolved) and blocking
   * variable NAMES. No environment value, length, or fragment ever appears
   * here — this route is owner-gated on GET and POST.
   */
  diagnostic: MailEnvDiagnostic;
  /** NAMES of the variables blocking config resolution ([] when resolved). */
  blockingEnvNames: string[];
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

/**
 * The options reading guide, as REAL attachment bytes. FULL emails say "The
 * attached Rafeeq-Options-Reading-Guide.png shows the option structure
 * visually", so it must actually be attached — a body that claims an
 * attachment it does not carry is worse than no guide at all.
 *
 * The file ships in `public/` and is traced into this route's bundle via
 * outputFileTracingIncludes (see next.config.mjs). Returns null if it cannot
 * be read, and the caller FAILS CLOSED rather than sending the claim without
 * the file.
 */
async function loadGuideAttachment(): Promise<{ filename: string; bytes: Uint8Array; contentType: string } | null> {
  try {
    const bytes = await readFile(join(process.cwd(), "public", RAFEEQ_GUIDE_PNG));
    if (bytes.length === 0) return null;
    return { filename: RAFEEQ_GUIDE_PNG, bytes: new Uint8Array(bytes), contentType: "image/png" };
  } catch {
    return null;
  }
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
  const diagnostic = diagnoseMailEnv(process.env as Record<string, string | undefined>);
  const maxBytes = config?.attachmentMaxBytes ?? 0;
  const tailAttachments = await loadTailAttachments(artifact.value.parts);
  const base: RafeeqSendPreflightDTO["attachments"] = tailAttachments.map((a) => ({
    filename: a.filename,
    bytes: a.bytes.length,
    kind: a.filename.endsWith(".xlsx") ? ("xlsx" as const) : ("manifest" as const),
  }));
  // the guide ships as a real attachment whenever the body claims it — show it
  // in the confirmation modal so the preflight matches what is actually sent.
  if (draft.value.attachments.includes(RAFEEQ_GUIDE_PNG)) {
    const guide = await loadGuideAttachment();
    if (guide) base.push({ filename: guide.filename, bytes: guide.bytes.length, kind: "guide" as const });
  }
  // the certified ZIP is NEVER attached — ensure the stored single object +
  // report the verified link facts the modal shows (sha256/size/expiry).
  const link = await createRafeeqPackageSignedLink(jobId);

  return {
    ok: true,
    value: {
      configured: config !== null,
      from: config ? `${config.fromName} <${config.fromAddress}>` : null,
      attachmentMaxBytes: maxBytes,
      subject: draft.value.subject,
      zipFilename: artifact.value.filename,
      zipTotalBytes: artifact.value.totalBytes,
      zipLink: link.ok ? { sha256: link.value.sha256, bytes: link.value.bytes, expiresAtIso: link.value.expiresAtIso } : null,
      attachments: base,
      generatedAt: row.created_at,
      productCount: row.products_total,
      imageCount: row.images_done,
      packageId: row.package_id,
      savedRecipient: await readSavedRecipient(),
      diagnostic,
      blockingEnvNames: blockingMailEnvNames(diagnostic),
    },
  };
}

export interface RafeeqSendRequest {
  toRaw: string;
  ccRaw: string;
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

  // FAST DELIVERY LINK — the certified ZIP is NEVER attached. The email is
  // blocked outright unless the stored single object is verified and a fresh
  // scoped signed URL was created: a broken/missing package link can never
  // be emailed.
  const link = await createRafeeqPackageSignedLink(jobId);
  if (!link.ok) return sendErr("package_link_unavailable", link.status);

  const draft = await buildRafeeqEmailDraftForJob(jobId, {
    downloadLink: { url: link.value.url, expiresAtIso: link.value.expiresAtIso, filename: link.value.filename },
  });
  if (!draft.ok) return sendErr("job_not_found", draft.status);

  const tailAttachments = await loadTailAttachments(artifact.value.parts);
  if (tailAttachments.length === 0) return sendErr("no_attachments", 409);

  // The DRAFT decides whether the guide belongs: it lists the guide exactly
  // when its body says "The attached Rafeeq-Options-Reading-Guide.png …".
  // Attaching off that same signal keeps the claim and the MIME part in
  // lockstep; unreadable ⇒ block rather than ship an unfulfilled claim.
  const guideClaimed = draft.value.attachments.includes(RAFEEQ_GUIDE_PNG);
  const guide = guideClaimed ? await loadGuideAttachment() : null;
  if (guideClaimed && !guide) return sendErr("guide_unavailable", 409);

  const allAttachments = guide ? [...tailAttachments, guide] : tailAttachments;
  const attachmentsBytes = new Map(allAttachments.map((a) => [a.filename, a.bytes]));
  const planned: RafeeqPlannedAttachment[] = allAttachments.map((a) => ({
    filename: a.filename,
    bytes: a.bytes.length,
    contentType: a.contentType,
  }));

  const plan = planRafeeqEmailSend({
    configured: true,
    toRaw: req.toRaw,
    ccRaw: req.ccRaw,
    subject: draft.value.subject,
    html: draft.value.html,
    text: draft.value.textEmail,
    attachments: planned,
    attachmentMaxBytes: config.attachmentMaxBytes,
    draftBlockers: draft.value.blockers,
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
