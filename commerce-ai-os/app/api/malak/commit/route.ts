// Malak WRITE executor (Phase 2B). This is the ONLY place a Malak-initiated
// write actually happens. It runs after the user taps [أكّد] in the confirm
// card: verify the signed action token, perform the mutation with the service
// role (bypasses RLS), then log a row to `malak_audit`. No token → no write.
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyAction, type MalakAction } from "@/lib/malak/confirm";
import { matchChannelsToMalika } from "@/app/(app)/inventory/actions";
import { requireMalakWriter } from "@/lib/malak/authz";
import { consumeOnce } from "@/lib/malak/ratelimit";
import { insertAuditRow } from "@/lib/audit";
import { inventorySeed } from "@/lib/products/inventory-seed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tier-2 safety limits from the Malak Constitution, enforced server-side here
// (the authoritative write path) — not just in the prompt. Below-cost is the
// absolute red line (never expands with trust); the ±15% band is flagged on the
// audit trail so an out-of-band change is always visible, but still allowed
// because the human already tapped [أكّد] (that tap IS the escalation approval).
const PRICE_SELF_BAND = 0.15; // ±15% self-execute window

type Sb = ReturnType<typeof createAdminClient>;

async function firstRow(builder: any): Promise<any | null> {
  const { data } = await builder.limit(1);
  return Array.isArray(data) && data.length ? data[0] : null;
}

interface CommitOutcome {
  message: string;
  productId?: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  overBand?: number; // signed % when a price change exceeded the ±15% band
}

// Resolve the target product by the signed productId first (robust to SKU
// casing), falling back to a case-insensitive SKU match.
async function findTarget(sb: Sb, a: MalakAction, cols: string): Promise<any | null> {
  if (a.productId) {
    const byId = await firstRow(sb.from("products").select(cols).eq("id", a.productId));
    if (byId) return byId;
  }
  if (a.sku) return await firstRow(sb.from("products").select(cols).ilike("sku", a.sku));
  return null;
}

async function commitStock(sb: Sb, a: MalakAction): Promise<CommitOutcome | { error: string }> {
  const p = await findTarget(sb, a, "id, name_en, stock_quantity");
  if (!p) return { error: `المنتج غير موجود (${a.sku}).` };
  const value = Number(a.newValue);
  if (!Number.isFinite(value) || value < 0) return { error: "قيمة مخزون غير صالحة." };

  const inv = await firstRow(sb.from("inventory").select("id, stock_quantity").eq("product_id", p.id));
  const oldVal = inv?.stock_quantity ?? p.stock_quantity ?? 0;

  // inventory is the source of truth.
  if (inv) {
    await sb.from("inventory").update({ stock_quantity: value, updated_at: new Date().toISOString() }).eq("id", inv.id);
  } else {
    await sb.from("inventory").insert({ product_id: p.id, stock_quantity: value, low_stock_threshold: 5, sold_quantity: 0 });
  }
  // keep the denormalized fields on products in sync for the catalog views.
  const stock_status = value <= 0 ? "Out of Stock" : value < 5 ? "Low Stock" : "In Stock";
  await sb.from("products").update({ stock_quantity: value, stock_status }).eq("id", p.id);

  return { message: `تم تحديث مخزون ${p.name_en}: ${oldVal} ← ${value}`, productId: p.id, field: "stock_quantity", oldValue: oldVal, newValue: value };
}

async function commitPrice(sb: Sb, a: MalakAction): Promise<CommitOutcome | { error: string }> {
  const p = await findTarget(sb, a, "id, name_en, price, cost");
  if (!p) return { error: `المنتج غير موجود (${a.sku}).` };
  const price = Number(a.newValue);
  if (!Number.isFinite(price) || price < 0) return { error: "سعر غير صالح." };

  // 🔴 Red line — never below cost. Hard block even with a confirm tap; this
  // limit never expands with trust. A genuine below-cost price must be set
  // deliberately from the product editor, not slipped through a Malak card.
  const cost = Number(p.cost);
  if (Number.isFinite(cost) && cost > 0 && price < cost) {
    return { error: `ممنوع: السعر ${price} ر.ق تحت التكلفة (${cost} ر.ق) — خط أحمر. لو فعلًا تقصده، عدّله يدويًا من صفحة المنتج.` };
  }

  const { error } = await sb.from("products").update({ price }).eq("id", p.id);
  if (error) return { error: error.message };

  // Flag a change beyond the ±15% self-execute band so it's visible (in the
  // result line + audit details) as an out-of-band/escalated change.
  const oldPrice = Number(p.price);
  let pct: number | null = null, note = "";
  if (Number.isFinite(oldPrice) && oldPrice > 0) {
    pct = (price - oldPrice) / oldPrice;
    if (Math.abs(pct) > PRICE_SELF_BAND) note = ` (تغيير ${pct > 0 ? "+" : ""}${Math.round(pct * 100)}٪ — فوق حدّ ±١٥٪)`;
  }
  return {
    message: `تم تحديث سعر ${p.name_en}: ${p.price ?? "—"} ← ${price} ر.ق${note}`,
    productId: p.id, field: "price", oldValue: p.price, newValue: price,
    overBand: pct != null && Math.abs(pct) > PRICE_SELF_BAND ? Math.round(pct * 100) : undefined,
  };
}

async function commitApproval(sb: Sb, a: MalakAction): Promise<CommitOutcome | { error: string }> {
  const p = await findTarget(sb, a, "id, name_en, approval");
  if (!p) return { error: `المنتج غير موجود (${a.sku}).` };
  const status = String(a.newValue ?? "");
  const { error } = await sb.from("products").update({ approval: status }).eq("id", p.id);
  if (error) return { error: error.message };
  return { message: `تم تغيير اعتماد ${p.name_en}: ${p.approval ?? "—"} ← ${status}`, productId: p.id, field: "approval", oldValue: p.approval, newValue: status };
}

async function commitAddProduct(sb: Sb, a: MalakAction): Promise<CommitOutcome | { error: string }> {
  const pr = a.product;
  if (!pr) return { error: "بيانات المنتج ناقصة." };

  // Re-ensure SKU uniqueness at commit time.
  let sku = pr.sku;
  const clash = await firstRow(sb.from("products").select("id").eq("sku", sku));
  if (clash) sku = `${sku}-${Date.now().toString().slice(-3)}`;

  const row = {
    sku,
    name_en: pr.name_en,
    name_ar: pr.name_ar,
    brand_id: pr.brand_id,
    main_category: pr.main_category,
    sub_category: pr.sub_category,
    price: pr.price,
    platform_status: pr.platform_status || "Draft",
    description_en: pr.description_en,
    description_ar: pr.description_ar,
    stock_quantity: 0,
    stock_status: "Out of Stock",
    notes: "أُضيف عبر ملاك (Malak) — الصورة تُرفع لاحقًا من صفحة التعديل.",
  };
  const { data: ins, error } = await sb.from("products").insert(row).select("id").single();
  if (error || !ins) return { error: error?.message ?? "تعذّر إنشاء المنتج." };

  // Seed an inventory row so it shows on the Inventory page.
  await sb.from("inventory").insert({ product_id: ins.id, ...inventorySeed(0) });

  return { message: `تمت إضافة المنتج "${pr.name_en}" (SKU ${sku}) بحالة Draft.`, productId: ins.id, field: "add_product", newValue: sku };
}

async function commitSetImage(sb: Sb, a: MalakAction): Promise<CommitOutcome | { error: string }> {
  const p = await findTarget(sb, a, "id, name_en, image_url");
  if (!p) return { error: `المنتج غير موجود (${a.sku}).` };
  const url = String(a.newValue ?? "");
  if (!url) return { error: "رابط الصورة مفقود." };

  // Mirror the product editor: record the image row + point products.image_url.
  await sb.from("product_images").update({ is_primary: false }).eq("product_id", p.id);
  await sb.from("product_images").insert({
    product_id: p.id,
    url,
    filename: url.split("/").pop() ?? null,
    is_primary: true,
    sort_order: 0,
  });
  const { error } = await sb.from("products").update({ image_url: url }).eq("id", p.id);
  if (error) return { error: error.message };
  return { message: `تم ربط صورة ${p.name_en}.`, productId: p.id, field: "image_url", oldValue: p.image_url ?? null, newValue: url };
}

// Bulk cross-platform sync: hide every out-of-stock product still listed on a
// channel + push 0 to Shopify. Delegates to the shared action (apply=true).
async function commitSync(_sb: Sb): Promise<CommitOutcome | { error: string }> {
  const r = await matchChannelsToMalika(true);
  if (r.error) return { error: r.error };
  const s = r.shopify;
  const shopBit = s?.configured
    ? ` · شوبيفاي: دُفع ${s.pushed ?? 0}${s.failed ? ` (فشل ${s.failed})` : ""}`
    : " · (دفع شوبيفاي غير مفعّل)";
  return {
    message: `تمت المزامنة: أُخفي ${r.products.length} منتج نافد على ${r.channelRows} إدراج قناة${shopBit}.`,
    field: "channel_sync",
    newValue: r.products.length,
  };
}

// Re-resolve a bulk action's target set at commit time (same filter the prepare
// step previewed) so the applied set is always live and can't be forged.
function bulkResolve(sb: Sb, cols: string, f: { category?: string; query?: string; onlyPending?: boolean } | undefined) {
  let q = sb.from("products").select(cols);
  if (f?.category) q = q.ilike("main_category", `%${f.category}%`);
  if (f?.query) q = q.ilike("name_en", `%${String(f.query).replace(/[%,()]/g, " ")}%`);
  if (f?.onlyPending) q = q.or("approval.is.null,approval.eq.");
  return q.limit(1000);
}

async function commitBulkApprove(sb: Sb, a: MalakAction): Promise<CommitOutcome | { error: string }> {
  const status = String(a.newValue ?? "");
  if (!["Approved", "Rejected", "SentAI"].includes(status)) return { error: "حالة اعتماد غير صالحة." };
  const { data } = await bulkResolve(sb, "id", a.filter);
  const ids = ((data ?? []) as any[]).map((r) => r.id).filter(Boolean);
  if (ids.length === 0) return { error: "ما في منتجات مطابقة الآن." };
  let done = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { error } = await sb.from("products").update({ approval: status }).in("id", chunk);
    if (error) return { error: error.message };
    done += chunk.length;
  }
  return { message: `اعتماد جماعي: ${done} منتج → ${status}.`, field: "bulk_approve", newValue: `${status}×${done}` };
}

async function commitBulkPrice(sb: Sb, a: MalakAction): Promise<CommitOutcome | { error: string }> {
  const pct = Number(a.pct);
  if (!Number.isFinite(pct) || pct === 0) return { error: "نسبة تعديل غير صالحة." };
  const factor = 1 + pct / 100;
  const { data } = await bulkResolve(sb, "id, price, cost", a.filter);
  const rows = ((data ?? []) as any[]).filter((p) => Number.isFinite(Number(p.price)) && Number(p.price) > 0);
  let applied = 0, skipped = 0;
  for (const p of rows) {
    const next = Math.round(Number(p.price) * factor * 100) / 100;
    const cost = Number(p.cost);
    // 🔴 Red line — never below cost, even in bulk. Skip (don't fail the batch).
    if (Number.isFinite(cost) && cost > 0 && next < cost) { skipped++; continue; }
    if (next <= 0) { skipped++; continue; }
    const { error } = await sb.from("products").update({ price: next }).eq("id", p.id);
    if (error) return { error: error.message };
    applied++;
  }
  const dir = pct > 0 ? `+${pct}٪` : `${pct}٪`;
  return {
    message: `تعديل سعر جماعي (${dir}): عُدّل ${applied} منتج${skipped ? ` · تُخطّي ${skipped} (تحت التكلفة)` : ""}.`,
    field: "bulk_price", newValue: `${dir}×${applied}`,
  };
}

// Idempotency: was an identical write already logged in the last 30s? Used to
// drop accidental double-taps. Best-effort — if the audit table is missing or
// mismatched the query errors and we DON'T block the write (fail open).
async function isRecentDuplicate(sb: Sb, a: MalakAction): Promise<boolean> {
  try {
    const sku = a.sku ?? a.product?.sku ?? null;
    const field = a.field ?? a.type; // matches what writeAudit stores
    const newVal = a.newValue != null ? String(a.newValue) : a.product?.sku ?? null;
    if (!sku || !field || newVal == null) return false;
    const since = new Date(Date.now() - 30_000).toISOString();
    const { data, error } = await sb
      .from("malak_audit")
      .select("id")
      .eq("sku", sku)
      .eq("field", field)
      .eq("new_value", newVal)
      .gte("created_at", since)
      .limit(1);
    if (error) return false; // audit unavailable → don't block the real write
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

// Best-effort audit. Never blocks a successful write; reports its own status.
// NOTE: malak_audit was renamed from a legacy `audit_log` table, which kept a
// NOT NULL `action` column in addition to `action_type` — so we populate both.
async function writeAudit(sb: Sb, a: MalakAction, out: CommitOutcome): Promise<string> {
  try {
    const row = {
      action_type: a.type,
      action: a.type, // legacy NOT NULL column (from audit_log)
      agent: a.agent,
      sku: a.sku ?? a.product?.sku ?? null,
      // product_id is uuid once supabase/malak_audit_product_id_uuid.sql has
      // run; insertAuditRow falls back to the legacy shape (uuid only inside
      // details) on an unmigrated table.
      product_id: out.productId ?? a.productId ?? null,
      field: out.field ?? a.field ?? null,
      old_value: out.oldValue != null ? String(out.oldValue) : a.oldValue != null ? String(a.oldValue) : null,
      new_value: out.newValue != null ? String(out.newValue) : null,
      details: { ...a, productId: out.productId ?? a.productId ?? null, ...(out.overBand != null ? { overBand: out.overBand } : {}) },
      status: out.overBand != null ? "committed_over_band" : "committed",
    };
    const { error } = await insertAuditRow(sb, row);
    if (error) {
      // Surface the LITERAL Supabase error for diagnosis (logs + response).
      console.error(
        "[malak-commit] audit insert FAILED:",
        JSON.stringify({ message: error.message, details: (error as any).details, hint: (error as any).hint, code: (error as any).code })
      );
      return "failed"; // generic to client; details are in the server log (F6)
    }
    return "ok";
  } catch (e: any) {
    console.error("[malak-commit] audit insert threw:", e?.message);
    return `failed: ${e?.message ?? "unknown"}`;
  }
}

export async function POST(req: Request) {
  // This route performs real service-role writes. Require a signed-in user who
  // is on the writer allow-list (F2) — not just any authenticated account — so a
  // leaked token or low-trust session can't mutate the catalog.
  const auth = await requireMalakWriter();
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  let token: unknown;
  try {
    const body = await req.json();
    token = body?.token;
  } catch {
    return Response.json({ error: "صيغة الطلب غير صحيحة." }, { status: 400 });
  }

  const action = verifyAction(token);
  if (!action) return Response.json({ error: "طلب التأكيد غير صالح أو منتهي الصلاحية. أعد العملية." }, { status: 400 });

  // Single-use (F7): a given confirm token can only be committed once (within its
  // 15-min lifetime), so a captured token can't be replayed.
  if (typeof token === "string" && !consumeOnce(`tok:${token}`, 15 * 60 * 1000)) {
    return Response.json({ ok: true, duplicate: true, audit: "skipped", message: "هالعملية تأكّدت قبل — تجاهلت التكرار." });
  }

  const sb = createAdminClient();

  // Drop accidental double-submits of the same change within 30s (idempotency).
  if (await isRecentDuplicate(sb, action)) {
    console.log("[malak-commit] duplicate within 30s, skipped:", action.type, action.sku);
    return Response.json({ ok: true, duplicate: true, audit: "skipped", message: "سوّيتها قبل ثواني — تجاهلت التكرار." });
  }

  try {
    let out: CommitOutcome | { error: string };
    switch (action.type) {
      case "update_stock": out = await commitStock(sb, action); break;
      case "set_price": out = await commitPrice(sb, action); break;
      case "set_approval": out = await commitApproval(sb, action); break;
      case "add_product": out = await commitAddProduct(sb, action); break;
      case "set_image": out = await commitSetImage(sb, action); break;
      case "sync_availability": out = await commitSync(sb); break;
      case "bulk_approve": out = await commitBulkApprove(sb, action); break;
      case "bulk_price": out = await commitBulkPrice(sb, action); break;
      default: return Response.json({ error: "نوع عملية غير معروف." }, { status: 400 });
    }
    if ("error" in out) return Response.json({ error: out.error }, { status: 200 });

    const audit = await writeAudit(sb, action, out);
    console.log(`[malak-commit] ${action.type} done; audit=${audit}`);
    return Response.json({ ok: true, message: out.message, audit });
  } catch (e: any) {
    console.error("[malak-commit] error", e?.message);
    return Response.json({ error: e?.message ?? "خطأ غير متوقع أثناء التنفيذ." }, { status: 200 });
  }
}
