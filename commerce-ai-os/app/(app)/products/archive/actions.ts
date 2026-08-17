"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";
import { requireOwner } from "@/lib/malak/authz";
import { reconcile } from "@/lib/inventory/reconcile";

const NO_DB = "الخادم غير مهيأ (SUPABASE_SERVICE_ROLE_KEY غير مضبوط).";
const NO_SETUP = "أدوات الأرشيف غير مهيأة — شغّل هجرة INV.4E (supabase/migrations) أولاً.";

// Fixed, user-safe Arabic for every restore_product_archive reason code. Never a
// raw DB message, a table/column name, or a uuid.
const RESTORE_REASON_AR: Record<string, string> = {
  archive_not_found: "سجل الأرشيف غير موجود.",
  bundle_invalid: "بيانات الأرشيف ناقصة أو تالفة — تعذّرت الاستعادة.",
  inventory_row_invalid: "بيانات مخزون الأرشيف غير صالحة — تعذّرت الاستعادة.",
  reference_mismatch: "بيانات الأرشيف غير متسقة — تعذّرت الاستعادة.",
  duplicate_identity: "بيانات الأرشيف مكرّرة — تعذّرت الاستعادة.",
  malformed_quantity: "كميات الأرشيف غير صالحة — تعذّرت الاستعادة.",
  parent_has_shelf_rows: "حالة رفوف غير متسقة على المنتج الأب — تعذّرت الاستعادة.",
  restore_conflict: "الكود أو الباركود مستخدم الآن — عدّله قبل الاستعادة.",
  restore_failed: "تعذّرت الاستعادة — حاول مجددًا.",
};
function restoreReasonAr(reason: unknown): string {
  if (typeof reason === "string" && Object.hasOwn(RESTORE_REASON_AR, reason)) {
    return RESTORE_REASON_AR[reason];
  }
  return "تعذّرت الاستعادة — حاول مجددًا.";
}
// The RPC/migration is missing (function not deployed yet).
function isMissingRpc(error: { code?: string; message?: string } | null): boolean {
  const code = error?.code ?? "";
  const msg = error?.message ?? "";
  return code === "42883" || code === "PGRST202" || /function .*does not exist/i.test(msg);
}

function adminClient(): any | null {
  try { return createAdminClient(); } catch { return null; }
}
async function adminEmail(): Promise<string | null> {
  try { const { data } = await createClient().auth.getUser(); return data.user?.email ?? null; } catch { return null; }
}

export type MatchedForArchive = {
  id: string; sku: string | null; barcode: string | null;
  name_en: string | null; name_ar: string | null; image_url: string | null;
  stock: number | null; matchedOn: string;
};

// Parse a free-text list (newlines / commas / spaces) of SKUs or barcodes and
// resolve them to real products. Returns matches + the tokens that hit nothing.
export async function matchProductsForArchive(text: string): Promise<{ matched: MatchedForArchive[]; unmatched: string[]; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { matched: [], unmatched: [], error: unauth.error };
  const admin = adminClient();
  if (!admin) return { matched: [], unmatched: [], error: NO_DB };

  const tokens = Array.from(new Set(
    String(text || "").split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
  )).slice(0, 500);
  if (!tokens.length) return { matched: [], unmatched: [] };

  const { data: rows, error } = await admin
    .from("products")
    .select("id, sku, barcode, name_en, name_ar, image_url, inventory(stock_quantity)")
    .or(`sku.in.(${tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(",")}),barcode.in.(${tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(",")})`);
  if (error) return { matched: [], unmatched: [], error: error.message };

  const matched: MatchedForArchive[] = [];
  const hitTokens = new Set<string>();
  for (const p of (rows ?? []) as any[]) {
    const onSku = p.sku && tokens.includes(String(p.sku));
    const onBc = p.barcode && tokens.includes(String(p.barcode));
    if (onSku) hitTokens.add(String(p.sku));
    if (onBc) hitTokens.add(String(p.barcode));
    matched.push({
      id: String(p.id), sku: p.sku ?? null, barcode: p.barcode ?? null,
      name_en: p.name_en ?? null, name_ar: p.name_ar ?? null, image_url: p.image_url ?? null,
      stock: p.inventory?.[0]?.stock_quantity ?? null,
      matchedOn: onSku ? String(p.sku) : onBc ? String(p.barcode) : "",
    });
  }
  const unmatched = tokens.filter((t) => !hitTokens.has(t));
  return { matched, unmatched };
}

// Snapshot each product's full bundle into product_archive, then delete it (and
// every dependent row — inventory, variants, BOTH shelf tables, channel rows) in
// ONE transaction. INV.4E: this delegates to the atomic archive_product_bundle
// RPC — the action performs no direct product/inventory/variant/shelf/channel
// write of its own (no partial archive, no orphan shelf rows).
export async function archiveAndDeleteProducts(ids: string[]): Promise<{ ok: true; archived: number; failed: string[] } | { error: string }> {
  // OPS.8C §1 — archive is a terminal, irreversible cold-storage move: OWNER-only
  // (hardened from the earlier CH.3b writer gate). Archive/restore RPC semantics
  // (INV.4E / OPS.8A) are unchanged; only the authorization boundary is stricter.
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const list = Array.from(new Set((ids ?? []).map(String))).filter(Boolean);
  if (!list.length) return { ok: true as const, archived: 0, failed: [] };
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const by = await adminEmail();

  let archived = 0;
  const failed: string[] = [];
  for (const id of list) {
    try {
      const { data, error } = await admin.rpc("archive_product_bundle", {
        p_product_id: id,
        p_archived_by: by,
      });
      if (error) {
        if (isMissingRpc(error)) return { error: NO_SETUP };
        failed.push(id);
        continue;
      }
      if ((data as any)?.status === "archived") archived++;
      else failed.push(id);
    } catch {
      failed.push(id);
    }
  }
  revalidatePath("/products");
  revalidatePath("/products/archive");
  revalidatePath("/dashboard");
  return { ok: true as const, archived, failed };
}

export type ArchivedRow = {
  id: string; product_id: string | null; sku: string | null; barcode: string | null;
  name_en: string | null; name_ar: string | null; image_url: string | null;
  archived_by: string | null; archived_at: string | null;
};

export async function listArchive(limit = 100): Promise<{ rows: ArchivedRow[]; ready: boolean; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { rows: [], ready: true, error: unauth.error };
  const admin = adminClient();
  if (!admin) return { rows: [], ready: true, error: NO_DB };
  const { data, error } = await admin
    .from("product_archive")
    .select("id, product_id, sku, barcode, name_en, name_ar, image_url, archived_by, archived_at")
    .order("archived_at", { ascending: false })
    .limit(limit);
  if (error) {
    if ((error as any).code === "42P01" || /product_archive/.test(error.message)) return { rows: [], ready: false };
    return { rows: [], ready: true, error: error.message };
  }
  return { rows: (data ?? []) as ArchivedRow[], ready: true };
}

// Re-insert an archived product bundle into the live catalog, then drop the
// archive entry — atomically. INV.4E: this delegates to restore_product_archive,
// which validates + reconciles the bundle to the authoritative inventory model
// (never restores drift or the retired products.stock_quantity mirror) and does
// the whole re-insert + archive-delete in one transaction. The action performs
// no direct product/inventory/variant/shelf/channel insert of its own; on any
// failure the RPC rolls back and the archive row stays put (no partial restore).
export async function restoreFromArchive(archiveId: string): Promise<{ ok: true } | { error: string }> {
  // OPS.8C §1 — restore re-inserts a product into the live catalog: OWNER-only
  // (hardened from the earlier CH.3b writer gate). Restore RPC semantics
  // (INV.4E / OPS.8A) are unchanged — the restored product still returns DRAFT.
  const owner = await requireOwner();
  if (!owner.ok) return { error: owner.error };
  const admin = adminClient();
  if (!admin) return { error: NO_DB };

  const { data, error } = await admin.rpc("restore_product_archive", { p_archive_id: archiveId });
  if (error) {
    if (isMissingRpc(error)) return { error: NO_SETUP };
    // Never surface a raw DB message.
    return { error: "تعذّرت الاستعادة — حاول مجددًا." };
  }
  const result = data as { status?: string; reason?: string; productId?: string } | null;
  if (!result || result.status !== "applied") {
    return { error: restoreReasonAr(result?.reason) };
  }

  // INV.4E Phase 17 — best-effort, READ-ONLY verification only. The RPC already
  // guarantees the authoritative invariants inside its transaction; this reconcile
  // never writes and never "repairs". A surprising verdict is logged for
  // diagnosis (the transaction has already committed — no rollback is implied).
  try {
    if (result.productId) {
      const verdict = await reconcile(admin, result.productId);
      if (verdict.status !== "clean") {
        console.error(
          "[archive-restore] post-restore reconcile not clean:",
          JSON.stringify({ productId: result.productId, status: verdict.status, issues: verdict.issues }),
        );
      }
    }
  } catch (e) {
    console.error("[archive-restore] post-restore reconcile threw:", e instanceof Error ? e.message : e);
  }

  revalidatePath("/products");
  revalidatePath("/products/archive");
  revalidatePath("/dashboard");
  return { ok: true as const };
}
