"use server";

// RAFEEQ.FULLSYNC.1 — Rafeeq file-sync WRITE actions (thin, gated wrappers).
//
// These server actions add NO storage/DB logic of their own — every mutation
// is delegated to the sanctioned boundary in lib/rafeeq/fullsync.server:
//   • markPackageSentAction  → OWNER-ONLY. The explicit "Mark as sent to
//     Rafeeq" confirmation — the only operation that establishes the durable
//     sent baseline (generation/download never does).
//   • previewReturnedFileAction → WRITER. READ-ONLY reconciliation preview of a
//     returned Rafeeq file (certified SKU/barcode matching — never titles).
//   • applyReturnedFileAction → OWNER-ONLY. Applies the reconciliation to the
//     storefront-scoped Rafeeq ECL identities; the plan is re-derived fresh
//     server-side from the uploaded bytes (a client can never submit a plan).
// The client never touches the database and never holds a service-role client;
// auth is gated HERE and the verified email is passed to the boundary.

import { revalidatePath } from "next/cache";
import { requireMalakWriter, requireOwner } from "@/lib/malak/authz";
import {
  markRafeeqPackageSent,
  previewRafeeqReturnedIds,
  applyRafeeqReturnedIds,
  type ReturnedIdsPreview,
  type ApplyReturnedIdsResult,
} from "@/lib/rafeeq/fullsync.server";
import type { ReconcileEntry } from "@/lib/export/rafeeq/reconcile";

const RAFEEQ_EXPORT_PATH = "/v2/export/rafeeq:malikas";
const MAX_PREVIEW_ENTRIES = 500;

const FILE_ERROR: Record<string, string> = {
  empty_file: "الملف فارغ أو لا يحتوي صفوفاً.",
  file_too_large: "حجم الملف كبير جداً (الحد الأقصى 10MB).",
  unreadable_file: "تعذّر قراءة الملف — الرجاء رفع ملف Excel المرتجع من رفيق.",
  missing_columns: "الملف لا يحتوي أعمدة IMAGE NAME / RAFEEQ ID المطلوبة.",
  evidence_unavailable: "تعذّر تحميل بيانات الكتالوج للمطابقة — حاول لاحقاً.",
  nothing_to_apply: "لا توجد صفوف قابلة للتطبيق في هذا الملف.",
  too_many_actions: "عدد التحديثات أكبر من الحد المسموح — قسّم الملف.",
};

async function fileBytes(formData: FormData): Promise<Uint8Array | null> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return null;
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

// ── mark as sent (owner-only) ─────────────────────────────────────────────────

export type MarkSentActionResult = { ok: true; sentAt: string } | { ok: false; error: string };

export async function markPackageSentAction(packageId: string): Promise<MarkSentActionResult> {
  const owner = await requireOwner();
  if (!owner.ok) return { ok: false, error: owner.error };

  const r = await markRafeeqPackageSent(String(packageId ?? ""), owner.email);
  if (!r.ok) return { ok: false, error: r.error };

  revalidatePath(RAFEEQ_EXPORT_PATH);
  return { ok: true, sentAt: r.sentAt };
}

// ── returned-file reconciliation ──────────────────────────────────────────────

export interface ReturnedPreviewVM {
  counts: {
    returnedRows: number;
    applicable: number;
    inserts: number;
    updates: number;
    needsReviewResolved: number;
    alreadyMapped: number;
    missingId: number;
    unknownSku: number;
    duplicates: number;
    conflicts: number;
    invalid: number;
  };
  entries: Pick<ReconcileEntry, "rowNumber" | "imageName" | "skuToken" | "returnedId" | "status" | "matchedSku" | "matchedBy">[];
  entriesTruncated: boolean;
}

export type PreviewReturnedActionResult = { ok: true; preview: ReturnedPreviewVM } | { ok: false; error: string };

/** READ-ONLY preview — writer-gated (viewing the plan mutates nothing). */
export async function previewReturnedFileAction(formData: FormData): Promise<PreviewReturnedActionResult> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { ok: false, error: writer.error };

  const bytes = await fileBytes(formData);
  if (!bytes) return { ok: false, error: FILE_ERROR.empty_file };

  const r: ReturnedIdsPreview = await previewRafeeqReturnedIds(bytes);
  if (!r.ok) return { ok: false, error: FILE_ERROR[r.error] ?? FILE_ERROR.unreadable_file };

  return {
    ok: true,
    preview: {
      counts: r.plan.counts,
      entries: r.plan.entries.slice(0, MAX_PREVIEW_ENTRIES).map((e) => ({
        rowNumber: e.rowNumber,
        imageName: e.imageName,
        skuToken: e.skuToken,
        returnedId: e.returnedId,
        status: e.status,
        matchedSku: e.matchedSku,
        matchedBy: e.matchedBy,
      })),
      entriesTruncated: r.plan.entries.length > MAX_PREVIEW_ENTRIES,
    },
  };
}

export type ApplyReturnedActionResult =
  | { ok: true; applied: number; inserted: number; updated: number; needsReviewResolved: number; failed: number }
  | { ok: false; error: string };

/** OWNER-ONLY apply — re-derives the plan fresh from the uploaded bytes. */
export async function applyReturnedFileAction(formData: FormData): Promise<ApplyReturnedActionResult> {
  const owner = await requireOwner();
  if (!owner.ok) return { ok: false, error: owner.error };

  const bytes = await fileBytes(formData);
  if (!bytes) return { ok: false, error: FILE_ERROR.empty_file };

  const r: ApplyReturnedIdsResult = await applyRafeeqReturnedIds(bytes, owner.email);
  if (!r.ok) return { ok: false, error: FILE_ERROR[r.error] ?? FILE_ERROR.unreadable_file };

  revalidatePath(RAFEEQ_EXPORT_PATH);
  return { ok: true, applied: r.applied, inserted: r.inserted, updated: r.updated, needsReviewResolved: r.needsReviewResolved, failed: r.failed };
}
