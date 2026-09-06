// TALABAT EMAIL WORKFLOW — server actions for the V2 screen (SERVER-ONLY).
//
// Generate → Preview → Test Send. Every decision comes from the PURE modules
// (email-workflow.ts, email-send.ts, email-artifacts.ts); this file supplies
// them with truth and carries out only what they authorise.
//
// What it deliberately does NOT do:
//   • generate artifacts itself — it calls the STEP 84 generator;
//   • build a transport — it uses the ONE shared SMTP layer;
//   • enable the official send — that is a constant in the pure module, so no
//     runtime input can turn it on;
//   • hard-code any recipient, including the saved Talabat contact.

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getMailConfig, sendMailViaSmtp } from "@/lib/mail/smtp.server";
import { validateRecipients } from "@/lib/mail/config";
import { readChannelRecipients, readSenderStatus, loadTalabatEmailBundle } from "@/lib/talabat/email-send.server";
import { resolveSendRecipients } from "@/lib/mail/recipient-settings";
import { buildTalabatUpdateEmail, buildTalabatNewProductsEmail } from "@/lib/export/talabat/email-templates";
import { isTalabatSendableKind, type TalabatSendKind } from "@/lib/export/talabat/email-send";
import { verifyArtifactScope, runFingerprint } from "@/lib/export/talabat/email-artifacts";
import { loadTalabatPreview } from "@/lib/export/talabat/preview.server";
import { parseTalabatBaseline, compareTalabatBaseline, type TalabatDeltaResult } from "@/lib/export/talabat/baseline-delta";
import {
  generateSafeUpdateArtifact, generateNewProductsArtifact, safeUpdateComposition,
} from "@/lib/talabat/email-artifacts.server";
import { newProductPreviewRows, newProductImageScope } from "@/lib/export/talabat/delta-workbooks";
import { allowedNewDeltaRows } from "@/lib/export/talabat/category-policy";
import {
  attachmentSizeReport, oversizeGuidance, presentForMode, confirmationToken, checkConfirmation,
  evaluateWorkflowGate, OFFICIAL_SEND_ENABLED, OFFICIAL_SEND_DISABLED_AR, WORKFLOW_BLOCK_AR,
  type AttachmentSizeReport, type SendMode, type WorkflowBlock,
} from "@/lib/export/talabat/email-workflow";

export type WorkflowApiResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };
const fail = <T,>(error: string, status: number): WorkflowApiResult<T> => ({ ok: false, error, status });

/**
 * Does the delivery log carry the delivery_mode column yet?
 *
 * A test send that cannot be recorded AS a test would leave a row indexed
 * exactly like a real Talabat delivery. Rather than write that row and hope
 * someone remembers, the workflow refuses until the additive migration is
 * applied — and says so by name.
 */
export async function deliveryLogSupportsMode(): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("talabat_email_deliveries").select("delivery_mode").limit(1);
    return !error && Array.isArray(data);
  } catch {
    return false;
  }
}

// ── preview ──────────────────────────────────────────────────────────────────

export interface WorkflowPreviewDTO {
  kind: TalabatSendKind;
  mode: SendMode;
  from: string | null;
  senderVerified: boolean;
  senderGuidance: string[];
  /** the saved convenience value. A SUGGESTION — never the final destination. */
  savedTo: string[];
  savedCc: string[];
  /** the recipients this preview is actually built for. */
  to: string[];
  cc: string[];
  recipientPresent: boolean;
  recipientValid: boolean;
  subject: string;
  bodyText: string;
  attachments: { filename: string; bytes: number; contentType: string }[];
  size: AttachmentSizeReport;
  oversizeGuidance: string[];
  artifactPresent: boolean;
  artifactFresh: boolean;
  artifactRunFingerprint: string | null;
  artifactGeneratedAtIso: string | null;
  /** the token the owner must echo back to confirm THIS exact message. */
  confirmationToken: string;
  blockers: string[];
  sendable: boolean;
  officialSendEnabled: false;
  officialSendDisabledReason: string;
  deliveryLogReady: boolean;
}

export interface WorkflowPreviewInput {
  kind: string;
  mode: SendMode;
  /** the owner's typed recipient for this send. Blank ⇒ fall back to the saved one. */
  toRaw: string;
  ccRaw: string;
  currentRunFingerprint: string | null;
  categoryRequests: string[];
}

export async function buildWorkflowPreview(
  input: WorkflowPreviewInput,
): Promise<WorkflowApiResult<WorkflowPreviewDTO>> {
  if (!isTalabatSendableKind(input.kind)) return fail("email_kind_not_sendable", 422);
  const kind = input.kind;

  const config = getMailConfig();
  const { status: sender } = readSenderStatus();
  const saved = await readChannelRecipients("talabat");
  const resolved = resolveSendRecipients(saved, { toRaw: input.toRaw, ccRaw: input.ccRaw });
  const to = resolved.ok ? resolved.value.to : [];
  const cc = resolved.ok ? resolved.value.cc : [];
  const recipientPresent = (input.toRaw.trim() !== "") || saved.to.length > 0;
  const recipientValid = resolved.ok && to.length > 0;

  const bundle = await loadTalabatEmailBundle(kind);
  const artifactPresent = bundle !== null;
  const artifactFresh = bundle !== null && input.currentRunFingerprint !== null
    && verifyArtifactScope(bundle.artifactScope, input.currentRunFingerprint).length === 0;

  const files = bundle?.attachments.map((a) => a.filename) ?? [];
  const draft = kind === "existing_updates"
    ? buildTalabatUpdateEmail(files[0] ?? "")
    : buildTalabatNewProductsEmail(files[0] ?? "", files[1] ?? "",
        { sendable: false, categoryRequests: input.categoryRequests });
  const presented = presentForMode(input.mode, draft.subject, draft.bodyText);

  const attachments = (bundle?.attachments ?? []).map((a) => ({
    filename: a.filename, bytes: a.bytes.length, contentType: a.contentType,
  }));
  const size = attachmentSizeReport(attachments, presented.bodyText.length, config?.attachmentMaxBytes ?? 0);

  const token = confirmationToken({
    kind, mode: input.mode, from: sender.expected.address, to, cc,
    subject: presented.subject, attachmentFilenames: files,
    runFingerprint: bundle?.artifactScope.runFingerprint ?? "",
  });

  const deliveryLogReady = input.mode === "test" ? await deliveryLogSupportsMode() : true;
  // The preview reports what would block a send if it were confirmed right now,
  // so the confirmation check is deliberately treated as satisfied here.
  const blocks = evaluateWorkflowGate({
    mode: input.mode,
    senderVerified: sender.match,
    artifactPresent, artifactFresh, recipientPresent, recipientValid,
    sizeWithinLimit: size.withinLimit,
    confirmation: { ok: true },
    deliveryLogReady,
  });

  return {
    ok: true,
    value: {
      kind, mode: input.mode,
      from: config ? `${config.fromName} <${config.fromAddress}>` : null,
      senderVerified: sender.match,
      senderGuidance: sender.guidance,
      savedTo: saved.to, savedCc: saved.cc,
      to, cc, recipientPresent, recipientValid,
      subject: presented.subject,
      bodyText: presented.bodyText,
      attachments,
      size,
      oversizeGuidance: oversizeGuidance(size),
      artifactPresent, artifactFresh,
      artifactRunFingerprint: bundle?.artifactScope.runFingerprint ?? null,
      artifactGeneratedAtIso: bundle?.artifactScope.generatedAtIso ?? null,
      confirmationToken: token,
      blockers: blocks.map((b) => WORKFLOW_BLOCK_AR[b]),
      sendable: blocks.length === 0,
      officialSendEnabled: false,
      officialSendDisabledReason: OFFICIAL_SEND_DISABLED_AR,
      deliveryLogReady,
    },
  };
}

// ── test send ────────────────────────────────────────────────────────────────

export interface TestSendInput extends WorkflowPreviewInput {
  /** the token the owner confirmed. Must still match the message being sent. */
  confirmationToken: string | null;
  createdBy: string;
}

export interface TestSendResultDTO {
  sent: true;
  mode: "test";
  messageId: string | null;
  auditRecorded: boolean;
  to: string[];
  subject: string;
  attachmentFilenames: string[];
}

/**
 * Send ONE test message. Same transport, same sender, same attachments — only
 * the subject and the first line of the body say it is a test.
 *
 * The gate is re-evaluated here from scratch: a preview the owner read a minute
 * ago is not authority for the state now, and the confirmation token is matched
 * against the message as it stands at this instant.
 */
export async function sendTalabatTestEmail(input: TestSendInput): Promise<WorkflowApiResult<TestSendResultDTO>> {
  // Official send is unreachable through this function by construction: the
  // mode is pinned to "test" and the pure gate refuses anything else anyway.
  if (input.mode !== "test") return fail("official_send_disabled", 403);
  if (!OFFICIAL_SEND_ENABLED && input.mode !== "test") return fail("official_send_disabled", 403);

  const preview = await buildWorkflowPreview({ ...input, mode: "test" });
  if (!preview.ok) return fail(preview.error, preview.status);
  const p = preview.value;

  const confirmation = checkConfirmation(input.confirmationToken, {
    kind: p.kind, mode: "test", from: readSenderStatus().status.expected.address,
    to: p.to, cc: p.cc, subject: p.subject, attachmentFilenames: p.attachments.map((a) => a.filename),
    runFingerprint: p.artifactRunFingerprint ?? "",
  });

  const blocks = evaluateWorkflowGate({
    mode: "test",
    senderVerified: p.senderVerified,
    artifactPresent: p.artifactPresent,
    artifactFresh: p.artifactFresh,
    recipientPresent: p.recipientPresent,
    recipientValid: p.recipientValid,
    sizeWithinLimit: p.size.withinLimit,
    confirmation,
    deliveryLogReady: p.deliveryLogReady,
  });
  if (blocks.length > 0) return fail(firstBlock(blocks), statusFor(blocks[0]));

  const config = getMailConfig();
  if (!config) return fail("mail_not_configured", 503);
  const bundle = await loadTalabatEmailBundle(p.kind);
  if (!bundle) return fail("artifact_missing", 409);

  // recipients are re-validated at the transport boundary, not trusted from the DTO
  const check = validateRecipients(p.to.join(", "), p.cc.join(", "));
  if (!check.ok) return fail("recipient_invalid", 422);

  const sent = await sendMailViaSmtp(config, {
    to: check.to,
    cc: check.cc,
    subject: p.subject,
    text: p.bodyText,
    html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(p.bodyText)}</pre>`,
    attachments: bundle.attachments.map((a) => ({
      filename: a.filename, content: Buffer.from(a.bytes), contentType: a.contentType,
    })),
  });
  if (!sent.ok) return fail("send_failed", 502);

  // Recorded ONLY after the provider accepted, and recorded AS A TEST.
  let auditRecorded = false;
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("talabat_email_deliveries").insert({
      email_kind: p.kind,
      delivery_mode: "test",
      sender: config.fromAddress,
      recipients: check.to,
      cc: check.cc,
      subject: p.subject,
      sent_at: new Date().toISOString(),
      provider_message_id: sent.messageId,
      attachment_filenames: bundle.attachments.map((a) => a.filename),
      status: "sent",
      created_by: input.createdBy,
      error_reference: p.artifactRunFingerprint,
    });
    auditRecorded = !error;
  } catch {
    auditRecorded = false;
  }

  return {
    ok: true,
    value: {
      sent: true, mode: "test", messageId: sent.messageId, auditRecorded,
      to: check.to, subject: p.subject,
      attachmentFilenames: bundle.attachments.map((a) => a.filename),
    },
  };
}

function firstBlock(blocks: readonly WorkflowBlock[]): string {
  return blocks[0];
}

function statusFor(block: WorkflowBlock): number {
  switch (block) {
    case "official_send_disabled": return 403;
    case "attachments_too_large": return 413;
    case "not_confirmed":
    case "confirmation_stale": return 428;
    case "artifact_missing":
    case "artifact_stale":
    case "delivery_log_not_ready": return 409;
    default: return 422;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


// ── generation ───────────────────────────────────────────────────────────────

/**
 * Where the owner's copy of Talabat's own menu export lives.
 *
 * The delta is a comparison against THEIR current catalog, so it cannot be
 * derived from ours alone. Rather than invent a baseline, the workflow reads
 * the file the owner uploaded and refuses when there is none — a generated
 * artifact built against a guessed baseline would be worse than no artifact.
 */
export const TALABAT_BASELINE_OBJECT = "email-artifacts/baseline/products.xlsx";
const BUCKET = "talabat-packages";

async function readStoredBaseline(): Promise<Uint8Array | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(BUCKET).download(TALABAT_BASELINE_OBJECT);
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Rebuild the certified delta for THIS moment. One definition, no second copy. */
export async function loadCurrentTalabatDelta(): Promise<
  { ok: true; result: TalabatDeltaResult; fingerprint: string } | { ok: false; error: "baseline_missing" | "preview_unavailable" }
> {
  const baselineBytes = await readStoredBaseline();
  if (!baselineBytes) return { ok: false, error: "baseline_missing" };
  const preview = await loadTalabatPreview();
  if (!preview) return { ok: false, error: "preview_unavailable" };

  const { createRequire } = await import("node:module");
  const XLSX = createRequire(import.meta.url)("xlsx");
  const wb = XLSX.read(baselineBytes, { type: "buffer" });
  const sheetName: string = wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
  const parsed = parseTalabatBaseline(aoa as unknown[][], sheetName);
  const result = compareTalabatBaseline(preview.rows, parsed.rows);
  return { ok: true, result, fingerprint: runFingerprint(result) };
}

export interface GenerationResultDTO {
  kind: TalabatSendKind;
  runFingerprint: string;
  generatedAtIso: string;
  files: { filename: string; bytes: number }[];
  workbookRows: number;
  workbookProducts: number;
  imageCount: number | null;
  composition: { nameRows: number; priceRows: number; bothRows: number } | null;
}

/**
 * Build and store the artifacts for one email kind.
 *
 * Email B's image package is NOT built here: assembling 632 images is a long
 * chunked job, and the certified engine already owns that flow. Regenerating
 * the full catalog package to get it would be exactly the 538 MB rebuild the
 * owner ruled out. So the workbook is produced and the image package is taken
 * from the completed delta job's stored artifact when one exists.
 */
export async function generateTalabatEmailArtifacts(kind: string): Promise<WorkflowApiResult<GenerationResultDTO>> {
  if (!isTalabatSendableKind(kind)) return fail("email_kind_not_sendable", 422);
  const delta = await loadCurrentTalabatDelta();
  if (!delta.ok) return fail(delta.error, 409);
  const nowIso = new Date().toISOString();

  if (kind === "existing_updates") {
    const out = await generateSafeUpdateArtifact(delta.result, nowIso);
    if (!out.ok) return fail("artifact_write_failed", 502);
    const c = safeUpdateComposition(delta.result);
    return {
      ok: true,
      value: {
        kind, runFingerprint: out.scope.runFingerprint, generatedAtIso: nowIso,
        files: out.scope.files.map((f) => ({ filename: f.filename, bytes: f.bytes })),
        workbookRows: out.scope.workbookRows, workbookProducts: out.scope.workbookProducts,
        imageCount: null,
        composition: { nameRows: c.nameRows, priceRows: c.priceRows, bothRows: c.bothRows },
      },
    };
  }

  const zip = await readCompletedDeltaImageZip();
  if (!zip) return fail("image_package_missing", 409);
  const out = await generateNewProductsArtifact({
    result: delta.result, nowIso,
    imageZipBytes: zip.bytes, imageCount: zip.imageCount, extensionAudit: zip.extensionAudit,
  });
  if (!out.ok) return fail("artifact_write_failed", 502);
  return {
    ok: true,
    value: {
      kind, runFingerprint: out.scope.runFingerprint, generatedAtIso: nowIso,
      files: out.scope.files.map((f) => ({ filename: f.filename, bytes: f.bytes })),
      workbookRows: out.scope.workbookRows, workbookProducts: out.scope.workbookProducts,
      imageCount: out.scope.imageCount,
      composition: null,
    },
  };
}

/**
 * The new-product image ZIP produced by the certified delta job.
 *
 * Read from storage, never rebuilt here. Absent ⇒ the caller reports
 * image_package_missing rather than shipping a workbook with no images.
 */
export const DELTA_IMAGE_ZIP_OBJECT = "email-artifacts/new_products/source/images.zip";
export const DELTA_IMAGE_META_OBJECT = "email-artifacts/new_products/source/images.json";

async function readCompletedDeltaImageZip(): Promise<
  { bytes: Uint8Array; imageCount: number; extensionAudit: { mismatches: number; renamed: number; collisions: number } } | null
> {
  try {
    const admin = createAdminClient();
    const [zip, meta] = await Promise.all([
      admin.storage.from(BUCKET).download(DELTA_IMAGE_ZIP_OBJECT),
      admin.storage.from(BUCKET).download(DELTA_IMAGE_META_OBJECT),
    ]);
    if (zip.error || !zip.data || meta.error || !meta.data) return null;
    const bytes = new Uint8Array(await zip.data.arrayBuffer());
    const parsed = JSON.parse(await meta.data.text()) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const imageCount = num(parsed.imageCount);
    const a = parsed.extensionAudit as Record<string, unknown> | undefined;
    if (bytes.length === 0 || imageCount === null || !a) return null;
    const mismatches = num(a.mismatches); const renamed = num(a.renamed); const collisions = num(a.collisions);
    if (mismatches === null || renamed === null || collisions === null) return null;
    return { bytes, imageCount, extensionAudit: { mismatches, renamed, collisions } };
  } catch {
    return null;
  }
}

/** Scope figures the V2 screen shows before anything is generated. */
export async function talabatEmailScopeSummary(): Promise<WorkflowApiResult<{
  runFingerprint: string;
  safeUpdateProducts: number; safeUpdateRows: number; nameRows: number; priceRows: number;
  newProducts: number; newProductRows: number; plannedImages: number;
  barcodeReviewRows: number;
}>> {
  const delta = await loadCurrentTalabatDelta();
  if (!delta.ok) return fail(delta.error, 409);
  const c = safeUpdateComposition(delta.result);
  const allowed = allowedNewDeltaRows(delta.result);
  const scope = newProductImageScope(delta.result);
  return {
    ok: true,
    value: {
      runFingerprint: delta.fingerprint,
      safeUpdateProducts: c.products, safeUpdateRows: c.rows, nameRows: c.nameRows, priceRows: c.priceRows,
      newProducts: new Set(newProductPreviewRows(delta.result).map((r) => r.internalProductId)).size,
      newProductRows: allowed.length,
      plannedImages: scope.newRowCount,
      barcodeReviewRows: delta.result.counts.barcodeDiffs,
    },
  };
}
