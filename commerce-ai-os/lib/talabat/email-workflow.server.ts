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
import { verifyArtifactScope, runFingerprint, artifactPath } from "@/lib/export/talabat/email-artifacts";
import {
  validateBaselineWorkbook, baselineObjectPath, parseActiveBaselineMeta,
  ACTIVE_BASELINE_POINTER, BASELINE_SHEET_NAME, type ActiveBaselineMeta,
} from "@/lib/export/talabat/baseline-upload";
import { baselineFingerprint } from "@/lib/talabat/baseline-fingerprint";
import { RAFEEQ_LINK_TTL_SECONDS } from "@/lib/export/rafeeq/artifact-object";
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
  /**
   * STEP 89 — the exact HTML the transport sends. The preview screen renders
   * THIS string; there is no second, prettier preview template, so what the
   * owner approves is byte-for-byte what Talabat would receive.
   *
   * null only when the approved signature artwork is missing, in which case the
   * message degrades to plain text rather than going out unsigned.
   */
  bodyHtml: string | null;
  bodyText: string;
  attachments: { filename: string; bytes: number; contentType: string }[];
  size: AttachmentSizeReport;
  oversizeGuidance: string[];
  artifactPresent: boolean;
  artifactFresh: boolean;
  artifactRunFingerprint: string | null;
  artifactGeneratedAtIso: string | null;
  /** which uploaded Talabat export the artifact was compared against. */
  artifactBaselineFingerprint: string | null;
  activeBaseline: { filename: string; rowCount: number; fingerprint: string; uploadedAtIso: string } | null;
  /** Email B only — the images travel by link, never as an attachment. */
  imagesLink: { url: string; expiresAtIso: string; filename: string; bytes: number } | null;
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
  const activeBaseline = await readActiveBaseline();
  const artifactPresent = bundle !== null;
  const artifactFresh = bundle !== null && input.currentRunFingerprint !== null
    && verifyArtifactScope(bundle.artifactScope, input.currentRunFingerprint,
      activeBaseline?.fingerprint).length === 0;

  const files = bundle?.attachments.map((a) => a.filename) ?? [];
  // Email B's ZIP is delivered by a time-limited signed link. Minting it here
  // means the preview shows the owner the same link the send will carry.
  const zipName = kind === "new_products" ? files.find((f) => f.endsWith(".zip")) ?? null : null;
  const imagesLink = zipName !== null ? await signImagesLink(zipName) : null;

  // Every figure the email states comes from the artifact scope that was written
  // when the files were generated — never from a constant in this file. If the
  // scope is missing the summary card is omitted rather than guessed.
  const scope = bundle?.artifactScope ?? null;
  const draft = kind === "existing_updates"
    ? buildTalabatUpdateEmail(files[0] ?? "", scope === null ? undefined : {
        products: scope.workbookProducts, rows: scope.workbookRows,
      })
    : buildTalabatNewProductsEmail(files[0] ?? "", zipName ?? "", {
        sendable: false,
        categoryRequests: input.categoryRequests,
        imagesLink,
        summary: scope === null ? undefined : {
          products: scope.workbookProducts, rows: scope.workbookRows,
          images: scope.imageCount ?? 0,
        },
      });
  const presented = presentForMode(input.mode, draft.subject, draft.bodyText, draft.bodyHtml);

  // Only what the draft CLAIMS to attach is measured and sent — the ZIP is
  // excluded the moment a link exists, so the size gate reflects reality.
  const attachments = (bundle?.attachments ?? [])
    .filter((a) => draft.attachments.includes(a.filename))
    .map((a) => ({ filename: a.filename, bytes: a.bytes.length, contentType: a.contentType }));
  // Both MIME parts count towards the message: the HTML body is an order of
  // magnitude larger than the text one, and a size report that ignored it would
  // under-report every message this step produces.
  const bodyBytes = presented.bodyText.length + (presented.bodyHtml?.length ?? 0);
  const size = attachmentSizeReport(attachments, bodyBytes, config?.attachmentMaxBytes ?? 0);

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
      bodyHtml: presented.bodyHtml,
      bodyText: presented.bodyText,
      attachments,
      size,
      oversizeGuidance: oversizeGuidance(size),
      artifactPresent, artifactFresh,
      artifactRunFingerprint: bundle?.artifactScope.runFingerprint ?? null,
      artifactGeneratedAtIso: bundle?.artifactScope.generatedAtIso ?? null,
      artifactBaselineFingerprint: bundle?.artifactScope.baselineFingerprint ?? null,
      activeBaseline: activeBaseline === null ? null : {
        filename: activeBaseline.filename, rowCount: activeBaseline.rowCount,
        fingerprint: activeBaseline.fingerprint, uploadedAtIso: activeBaseline.uploadedAtIso,
      },
      imagesLink,
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
    // The SAME string the preview displayed — not a re-render, not a wrapper
    // around the plain text. When the approved signature is unavailable the
    // HTML part is dropped entirely and the message goes out as text.
    html: p.bodyHtml ?? undefined,
    // EXACTLY the files the preview listed: the image ZIP is excluded because
    // the body delivers it by link, and attaching it anyway would both blow the
    // size limit and contradict what the owner reviewed.
    attachments: bundle.attachments
      .filter((a) => p.attachments.some((x) => x.filename === a.filename))
      .map((a) => ({ filename: a.filename, content: Buffer.from(a.bytes), contentType: a.contentType })),
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
      attachment_filenames: p.attachments.map((a) => a.filename),
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
      attachmentFilenames: p.attachments.map((a) => a.filename),
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


// ── generation ───────────────────────────────────────────────────────────────

/**
 * Where the owner's copy of Talabat's own menu export lives.
 *
 * The delta is a comparison against THEIR current catalog, so it cannot be
 * derived from ours alone. Rather than invent a baseline, the workflow reads
 * the file the owner uploaded and refuses when there is none — a generated
 * artifact built against a guessed baseline would be worse than no artifact.
 */
/**
 * The pre-STEP-88 fixed path. Kept ONLY as a fallback for an installation that
 * has never uploaded through the versioned flow — never preferred over the
 * active pointer, and never used to paper over a broken one.
 */
export const TALABAT_BASELINE_OBJECT = "email-artifacts/baseline/products.xlsx";
const BUCKET = "talabat-packages";

export type BaselineReadError =
  | "baseline_missing"
  | "baseline_invalid"
  | "baseline_pointer_invalid"
  | "baseline_fingerprint_mismatch";

export type BaselineRead =
  | { ok: true; bytes: Uint8Array; meta: ActiveBaselineMeta | null }
  | { ok: false; error: BaselineReadError };

async function download(path: string): Promise<Uint8Array | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(BUCKET).download(path);
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the ACTIVE baseline.
 *
 * STEP 88 moved storage to versioned objects behind an `active.json` pointer,
 * but this reader was left on the old fixed path — so a perfectly good upload
 * read back as "no baseline". The order below is the fix, and the failure modes
 * are deliberately distinct rather than all collapsing into "missing":
 *
 *   pointer present + readable + fingerprint matches  → use it
 *   pointer present but malformed                     → baseline_pointer_invalid
 *   pointer present but its object is unreadable      → baseline_invalid
 *   pointer present but the bytes hash differently    → baseline_fingerprint_mismatch
 *   NO pointer at all                                 → legacy fixed path, else missing
 *
 * A broken pointer NEVER falls back to the legacy path. Silently comparing
 * against an older file because the current one failed to load would produce
 * confident, wrong numbers — worse than refusing.
 */
export async function readActiveBaselineBytes(): Promise<BaselineRead> {
  let pointerRaw: unknown = null;
  let pointerExists = false;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(BUCKET).download(ACTIVE_BASELINE_POINTER);
    if (!error && data) {
      pointerExists = true;
      try {
        pointerRaw = JSON.parse(await data.text()) as unknown;
      } catch {
        pointerRaw = null;
      }
    }
  } catch {
    pointerExists = false;
  }

  if (pointerExists) {
    const meta = parseActiveBaselineMeta(pointerRaw);
    if (meta === null) return { ok: false, error: "baseline_pointer_invalid" };
    const bytes = await download(meta.objectPath);
    if (bytes === null) return { ok: false, error: "baseline_invalid" };
    // The pointer claims a fingerprint; the bytes must actually hash to it.
    if (baselineFingerprint(bytes) !== meta.fingerprint) {
      return { ok: false, error: "baseline_fingerprint_mismatch" };
    }
    return { ok: true, bytes, meta };
  }

  const legacy = await download(TALABAT_BASELINE_OBJECT);
  if (legacy === null) return { ok: false, error: "baseline_missing" };
  return { ok: true, bytes: legacy, meta: null };
}

/** Rebuild the certified delta for THIS moment. One definition, no second copy. */
export async function loadCurrentTalabatDelta(): Promise<
  { ok: true; result: TalabatDeltaResult; fingerprint: string; baseline: ActiveBaselineMeta | null }
  | { ok: false; error: BaselineReadError | "preview_unavailable" }
> {
  const baseline = await readActiveBaselineBytes();
  if (!baseline.ok) return { ok: false, error: baseline.error };
  const baselineBytes = baseline.bytes;
  const preview = await loadTalabatPreview();
  if (!preview) return { ok: false, error: "preview_unavailable" };

  const { createRequire } = await import("node:module");
  const XLSX = createRequire(import.meta.url)("xlsx");
  const wb = XLSX.read(baselineBytes, { type: "buffer" });
  const sheetName: string = wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
  const parsed = parseTalabatBaseline(aoa as unknown[][], sheetName);
  const result = compareTalabatBaseline(preview.rows, parsed.rows);
  return { ok: true, result, fingerprint: runFingerprint(result), baseline: baseline.meta };
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
  // the baseline the delta was actually built from — not a second, racing read
  const baseline = delta.baseline;

  if (kind === "existing_updates") {
    const out = await generateSafeUpdateArtifact(delta.result, nowIso, baseline?.fingerprint);
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
    baselineFingerprint: baseline?.fingerprint,
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

// ── baseline upload (STEP 88) ────────────────────────────────────────────────

/**
 * Versioned baseline storage. Each upload lands under its own fingerprint and
 * a pointer records which is active, so an already-generated artifact can
 * always be traced to the exact file it was compared against — an overwrite
 * would destroy that evidence.
 */
export interface BaselineUploadResultDTO {
  filename: string;
  byteLength: number;
  rowCount: number;
  fingerprint: string;
  uploadedAtIso: string;
  detectedHeaders: string[];
  extraColumns: string[];
  objectPath: string;
  /** artifacts generated from a DIFFERENT baseline are now stale. */
  invalidatesExistingArtifacts: boolean;
}

export async function uploadTalabatBaseline(
  filename: string, bytes: Uint8Array, uploadedBy: string,
): Promise<WorkflowApiResult<BaselineUploadResultDTO>> {
  // Parse first, store second: an unreadable or wrong-shaped file must never
  // reach storage, or the next generation would compare against garbage.
  let aoa: unknown[][] | null = null;
  let sheetNames: string[] = [];
  try {
    const { createRequire } = await import("node:module");
    const XLSX = createRequire(import.meta.url)("xlsx");
    const wb = XLSX.read(bytes, { type: "buffer" });
    sheetNames = Array.isArray(wb.SheetNames) ? wb.SheetNames : [];
    const sheet = wb.Sheets[BASELINE_SHEET_NAME];
    aoa = sheet ? (XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true }) as unknown[][]) : null;
  } catch {
    aoa = null;
  }

  const check = validateBaselineWorkbook({ filename, byteLength: bytes.length, aoa, sheetNames });
  if (!check.ok) return fail(check.reason, 422);

  const fingerprint = baselineFingerprint(bytes);
  const previous = await readActiveBaseline();
  const objectPath = baselineObjectPath(fingerprint);
  const uploadedAtIso = new Date().toISOString();

  const stored = await putObject(objectPath, bytes,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  if (!stored) return fail("baseline_write_failed", 502);

  const meta: ActiveBaselineMeta = {
    filename, byteLength: bytes.length, rowCount: check.rowCount, fingerprint,
    uploadedAtIso, uploadedBy, detectedHeaders: check.detectedHeaders, objectPath,
  };
  const pointed = await putObject(ACTIVE_BASELINE_POINTER,
    new TextEncoder().encode(JSON.stringify(meta, null, 2)), "application/json");
  if (!pointed) return fail("baseline_write_failed", 502);

  return {
    ok: true,
    value: {
      ...meta,
      extraColumns: check.extraColumns,
      invalidatesExistingArtifacts: previous !== null && previous.fingerprint !== fingerprint,
    },
  };
}

async function putObject(path: string, bytes: Uint8Array, contentType: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true });
    return !error;
  } catch {
    return false;
  }
}

export async function readActiveBaseline(): Promise<ActiveBaselineMeta | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(BUCKET).download(ACTIVE_BASELINE_POINTER);
    if (error || !data) return null;
    return parseActiveBaselineMeta(JSON.parse(await data.text()) as unknown);
  } catch {
    return null;
  }
}

// ── signed link for the image package (STEP 88) ──────────────────────────────

/**
 * Reuses the Rafeeq policy verbatim: a private bucket, a time-limited signed
 * URL minted on demand, seven days. Nothing is made public and no URL is
 * persisted — the link is generated when the preview or the send needs one, so
 * an expired link simply stops existing rather than lingering in a record.
 */
export const TALABAT_LINK_TTL_SECONDS = RAFEEQ_LINK_TTL_SECONDS;

export interface SignedImagesLink {
  url: string;
  expiresAtIso: string;
  filename: string;
  bytes: number;
}

/**
 * Mint a link for the image ZIP belonging to THIS run.
 *
 * The object path is derived from the artifact the run produced, so a link can
 * never point at a different run's package: a stale artifact yields a link to
 * the stale object, and the artifact gate refuses the send before the link is
 * ever used.
 */
export async function signImagesLink(zipFilename: string): Promise<SignedImagesLink | null> {
  try {
    const admin = createAdminClient();
    const path = artifactPath("new_products", zipFilename);
    const { data, error } = await admin.storage.from(BUCKET)
      .createSignedUrl(path, TALABAT_LINK_TTL_SECONDS, { download: zipFilename });
    if (error || !data?.signedUrl) return null;
    const head = await admin.storage.from(BUCKET).download(path);
    const bytes = head.error || !head.data ? 0 : (await head.data.arrayBuffer()).byteLength;
    if (bytes === 0) return null;
    return {
      url: data.signedUrl,
      expiresAtIso: new Date(Date.now() + TALABAT_LINK_TTL_SECONDS * 1000).toISOString(),
      filename: zipFilename,
      bytes,
    };
  } catch {
    return null;
  }
}
