import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Every catalog change opens a staff task carrying the FULL details, so the
// manual platforms (Talabat / Snoonu / Rafeeq) get updated by hand and later
// verified against the platform's own export. Strictly best-effort: a logging
// failure must never block the product write it describes.

export type CatalogTaskAction = "create" | "update" | "delete" | "image" | "approval" | "bulk" | "oos" | "restock";
export interface CatalogFieldChange { field: string; old: string; new: string }

export const CATALOG_FIELD_AR: Record<string, string> = {
  name_en: "الاسم EN", name_ar: "الاسم AR", price: "السعر", discount_price: "الخصم",
  description_en: "الوصف EN", description_ar: "الوصف AR", sku: "SKU", barcode: "الباركود",
  main_category: "التصنيف", sub_category: "التصنيف الفرعي", image_url: "الصورة", approval: "الحالة",
};

const ICON: Record<CatalogTaskAction, string> = {
  create: "🆕", update: "✏️", delete: "🗑️", image: "🖼️", approval: "🔖", bulk: "📦",
  oos: "🚫", restock: "🔄",
};
const VERB: Record<CatalogTaskAction, string> = {
  create: "منتج جديد", update: "تعديل منتج", delete: "حذف منتج",
  image: "تغيير صورة", approval: "تغيير حالة", bulk: "عملية جماعية",
  oos: "نفد المخزون", restock: "رجع المخزون",
};

const s = (v: unknown) => String(v ?? "").trim();
const cut = (v: unknown, n = 160) => { const t = s(v); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** Which of `fields` differ between the two rows (values trimmed/stringified). */
export function computeFieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): CatalogFieldChange[] {
  const out: CatalogFieldChange[] = [];
  for (const f of fields) {
    const a = s(before?.[f]);
    const b = s(after?.[f]);
    if (a !== b) out.push({ field: f, old: cut(a, 90) || "—", new: cut(b, 90) || "—" });
  }
  return out;
}

function describeSnapshot(snap: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (s(snap.name_en)) lines.push(`الاسم EN: ${cut(snap.name_en)}`);
  if (s(snap.name_ar)) lines.push(`الاسم AR: ${cut(snap.name_ar)}`);
  const idBits = [s(snap.sku) && `SKU: ${s(snap.sku)}`, s(snap.barcode) && `باركود: ${s(snap.barcode)}`].filter(Boolean);
  if (idBits.length) lines.push(idBits.join(" · "));
  const priceBits = [
    Number(snap.price) > 0 && `السعر: ${snap.price} ر.ق`,
    Number(snap.discount_price) > 0 && `بعد الخصم: ${snap.discount_price} ر.ق`,
  ].filter(Boolean);
  if (priceBits.length) lines.push(priceBits.join(" · "));
  if (s(snap.main_category)) lines.push(`التصنيف: ${s(snap.main_category)}`);
  if (s(snap.description_en)) lines.push(`الوصف EN: ${cut(snap.description_en, 220)}`);
  if (s(snap.description_ar)) lines.push(`الوصف AR: ${cut(snap.description_ar, 220)}`);
  if (s(snap.image_url)) lines.push(`الصورة: ${s(snap.image_url)}`);
  return lines;
}

/**
 * Open the task. `snapshot` is the product data AT CHANGE TIME (for delete:
 * before it was removed — the assignee needs it to remove it from platforms).
 */
export async function logCatalogTask(opts: {
  action: CatalogTaskAction;
  productId?: string | null;
  snapshot?: Record<string, unknown> | null;
  changes?: CatalogFieldChange[];
  note?: string; // bulk summaries / extra context line
  actor?: string; // explicit attribution (staff/supervisor paths have no Supabase user)
}): Promise<void> {
  try {
    const admin = createAdminClient();
    let actor = opts.actor ?? "";
    if (!actor) {
      try { actor = (await createClient().auth.getUser()).data.user?.email ?? ""; } catch { /* cron/staff paths */ }
    }

    const snap = (opts.snapshot ?? {}) as Record<string, unknown>;
    const name = s(snap.name_en) || s(snap.name_ar) || s(opts.note) || "منتج";
    const sku = s(snap.sku);
    const title = `${ICON[opts.action]} ${VERB[opts.action]}: ${cut(name, 120)}${sku ? ` (${sku})` : ""}`.slice(0, 200);

    const parts: string[] = [];
    parts.push(`${VERB[opts.action]}${actor ? ` — بواسطة ${actor}` : ""}`);
    if (opts.note) parts.push(opts.note);
    const dataLines = describeSnapshot(snap);
    if (dataLines.length) parts.push("", "البيانات:", ...dataLines.map((l) => `• ${l}`));
    if (opts.changes?.length) {
      parts.push("", "التغييرات:");
      for (const c of opts.changes) parts.push(`• ${CATALOG_FIELD_AR[c.field] ?? c.field}: ${c.old} ← ${c.new}`);
    }
    if (opts.action === "delete") parts.push("", "⚠️ احذفه من المنصات اليدوية أيضًا.");
    if (opts.action === "oos") parts.push("", "⚠️ علّمه «غير متوفر / Out of stock» في المنصات اليدوية.");
    if (opts.action === "restock") parts.push("", "✅ فعّله من جديد (متوفر) في المنصات اليدوية.");
    parts.push("", "📌 حدّث يدويًا في: طلبات ☐ · سنونو ☐ · رفيق ☐", "(شوبي فاي يتزامن تلقائيًا — لا يحتاج شي)");

    const row: Record<string, unknown> = {
      title,
      description: parts.join("\n").slice(0, 4000),
      assigned_to: null,
      assigned_name: null,
      priority: opts.action === "delete" || opts.action === "oos" ? "high" : "normal",
      status: "open",
      created_by: actor || "system",
      kind: "catalog",
      product_id: opts.productId || null,
      payload: { action: opts.action, snapshot: snap, changes: opts.changes ?? [] },
    };
    let { error } = await admin.from("staff_tasks").insert(row);
    if (error && /kind|payload|product_id/i.test(error.message)) {
      // Migration not run yet — keep the task, drop the new columns.
      const { kind: _k, product_id: _p, payload: _pl, ...legacy } = row;
      ({ error } = await admin.from("staff_tasks").insert(legacy));
    }
    if (error) console.error("[catalog-task]", error.message);
  } catch (e) {
    console.error("[catalog-task]", e instanceof Error ? e.message : e);
  }
}
