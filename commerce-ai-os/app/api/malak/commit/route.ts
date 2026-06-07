// Malak WRITE executor (Phase 2B). This is the ONLY place a Malak-initiated
// write actually happens. It runs after the user taps [أكّد] in the confirm
// card: verify the signed action token, perform the mutation with the service
// role (bypasses RLS), then log a row to `malak_audit`. No token → no write.
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyAction, type MalakAction } from "@/lib/malak/confirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const p = await findTarget(sb, a, "id, name_en, price");
  if (!p) return { error: `المنتج غير موجود (${a.sku}).` };
  const price = Number(a.newValue);
  if (!Number.isFinite(price) || price < 0) return { error: "سعر غير صالح." };
  const { error } = await sb.from("products").update({ price }).eq("id", p.id);
  if (error) return { error: error.message };
  return { message: `تم تحديث سعر ${p.name_en}: ${p.price ?? "—"} ← ${price} ر.ق`, productId: p.id, field: "price", oldValue: p.price, newValue: price };
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
  await sb.from("inventory").insert({ product_id: ins.id, stock_quantity: 0, low_stock_threshold: 5, sold_quantity: 0 });

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
async function writeAudit(sb: Sb, a: MalakAction, out: CommitOutcome): Promise<string> {
  try {
    const row = {
      action_type: a.type,
      agent: a.agent,
      sku: a.sku ?? a.product?.sku ?? null,
      product_id: out.productId ?? null,
      field: out.field ?? a.field ?? null,
      old_value: out.oldValue != null ? String(out.oldValue) : a.oldValue != null ? String(a.oldValue) : null,
      new_value: out.newValue != null ? String(out.newValue) : null,
      details: a,
      status: "committed",
    };
    const { error } = await sb.from("malak_audit").insert(row);
    return error ? `failed: ${error.message}` : "ok";
  } catch (e: any) {
    return `failed: ${e?.message ?? "unknown"}`;
  }
}

export async function POST(req: Request) {
  let token: unknown;
  try {
    const body = await req.json();
    token = body?.token;
  } catch {
    return Response.json({ error: "صيغة الطلب غير صحيحة." }, { status: 400 });
  }

  const action = verifyAction(token);
  if (!action) return Response.json({ error: "طلب التأكيد غير صالح أو منتهي الصلاحية. أعد العملية." }, { status: 400 });

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
