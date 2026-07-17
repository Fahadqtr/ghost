"use server";

import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logCatalogTask, computeFieldChanges } from "@/lib/tasks/catalog-log";
import { logStockTransition } from "@/lib/tasks/stock-tasks";
import { queueForTalabat } from "@/lib/talabat/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSignedIn } from "@/lib/auth/requireUser";
import { assertSafeImageUrl } from "@/lib/net/safeImage";
import { CATEGORIES } from "@/lib/constants";
import { buildDraftPrompt, parseProductDraft } from "@/lib/products/draft-compute";
import { clean, cleanDescription } from "@/lib/malak/talabat-export.mjs";

// --- input shapes (sent from the client form) -----------------------------

export interface VariantInput {
  id?: string;
  variant_name: string;
  sku: string;
  barcode: string;
  color: string;
  size: string;
  price: string;
  stock_quantity: string;
}

export interface ProductInput {
  sku: string;
  barcode: string;
  name_en: string;
  name_ar: string;
  brand_id: string;
  main_category: string;
  sub_category: string;
  product_type: string;
  color: string;
  size: string;
  price: string;
  discount_price: string;
  cost: string;
  stock_quantity: string;
  stock_status: string;
  platform_status: string;
  approval: string;
  rejection_reason: string;
  image_filename: string;
  image_url: string;
  description_en: string;
  description_ar: string;
  keywords_en: string;
  keywords_ar: string;
  notes: string;
  variants: VariantInput[];
}

// --- helpers --------------------------------------------------------------

const str = (v: string) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
// Like str(), but also strips emojis/decorative symbols (names & descriptions),
// so anything typed/pasted in the editor lands clean — matches the export.
const cleanStr = (v: string) => {
  const t = clean(v);
  return t === "" ? null : t;
};
// For descriptions: same cleanup but the house bullets (🔸 / ✔️) survive.
const cleanDesc = (v: string) => {
  const t = cleanDescription(v);
  return t === "" ? null : t;
};
const num = (v: string) => {
  const t = (v ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return isNaN(n) ? null : n;
};

function toProductRow(input: ProductInput) {
  // Enforce the locked category list (defence in depth; UI also restricts it).
  const category = str(input.main_category);
  if (category && !CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    throw new Error(`Invalid category "${category}". Must be one of the known categories.`);
  }
  return {
    sku: str(input.sku),
    barcode: str(input.barcode),
    name_en: cleanStr(input.name_en),
    name_ar: cleanStr(input.name_ar),
    brand_id: str(input.brand_id),
    main_category: category,
    sub_category: str(input.sub_category),
    product_type: str(input.product_type),
    color: str(input.color),
    size: str(input.size),
    price: num(input.price),
    discount_price: num(input.discount_price),
    cost: num(input.cost),
    stock_quantity: num(input.stock_quantity),
    stock_status: str(input.stock_status),
    platform_status: str(input.platform_status),
    approval: str(input.approval),
    rejection_reason: str(input.rejection_reason),
    image_filename: str(input.image_filename),
    image_url: str(input.image_url),
    // Descriptions keep the house bullet markers (🔸 / ✔️) — the platform
    // exports strip them at export time.
    description_en: cleanDesc(input.description_en),
    description_ar: cleanDesc(input.description_ar),
    keywords_en: str(input.keywords_en),
    keywords_ar: str(input.keywords_ar),
    notes: str(input.notes),
  };
}

// Turn a raw Postgres write error into something a human can act on. The most
// common one is a duplicate SKU/barcode (unique violation, code 23505) which
// otherwise surfaces as "duplicate key value violates unique constraint …".
function friendlyWriteError(
  error: { code?: string; message: string } | null,
  fallback: string
): string {
  if (!error) return fallback;
  if (error.code === "23505") {
    return "A product with this SKU or barcode already exists. Please use a unique value.";
  }
  return error.message || fallback;
}

function toVariantRows(parentId: string, variants: VariantInput[]) {
  return variants
    .filter((v) => str(v.variant_name) || str(v.sku))
    .map((v) => ({
      parent_product_id: parentId,
      variant_name: str(v.variant_name),
      sku: str(v.sku),
      barcode: str(v.barcode),
      color: str(v.color),
      size: str(v.size),
      price: num(v.price),
      stock_quantity: num(v.stock_quantity),
    }));
}

// --- actions --------------------------------------------------------------

export async function createProduct(input: ProductInput) {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const supabase = createClient();

  let productRow;
  try {
    productRow = toProductRow(input);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid product data." };
  }

  const { data: product, error } = await supabase
    .from("products")
    .insert(productRow)
    .select("id")
    .single();

  if (error || !product) {
    return { error: friendlyWriteError(error, "Could not create product.") };
  }

  // Seed an inventory row so the product appears on the Inventory page.
  const invErr = (
    await supabase.from("inventory").insert({
      product_id: product.id,
      stock_quantity: productRow.stock_quantity ?? 0,
      low_stock_threshold: 5,
      sold_quantity: 0,
    })
  ).error;
  if (invErr) {
    return {
      error: `Product created, but its inventory row failed: ${invErr.message}`,
    };
  }

  // Insert variants (parent-child) if any.
  const variantRows = toVariantRows(product.id, input.variants);
  if (variantRows.length > 0) {
    const vErr = (await supabase.from("product_variants").insert(variantRows)).error;
    if (vErr) {
      return { error: friendlyWriteError(vErr, "Product created, but its variants failed to save.") };
    }
  }

  await logCatalogTask({ action: "create", productId: product.id, snapshot: productRow as Record<string, unknown> });

  revalidatePath("/products");
  revalidatePath("/inventory");
  redirect("/products");
}

export async function updateProduct(id: string, input: ProductInput) {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const supabase = createClient();

  let productRow;
  try {
    productRow = toProductRow(input);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid product data." };
  }

  // Snapshot BEFORE the write so the auto-task can show old -> new.
  const { data: beforeRow } = await supabase
    .from("products")
    .select("name_en, name_ar, sku, barcode, price, discount_price, description_en, description_ar, main_category, sub_category, image_url, approval")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase
    .from("products")
    .update(productRow)
    .eq("id", id);

  if (error) return { error: friendlyWriteError(error, "Could not update product.") };

  // Keep the inventory pool in sync. The Inventory & Dashboard pages read stock
  // from the `inventory` table (not `products`), so an edit that doesn't write
  // `inventory` would leave the displayed stock stale. Update the existing row
  // if there is one, otherwise seed a new one (older products may predate it).
  const { data: invRow } = await supabase
    .from("inventory")
    .select("id, stock_quantity")
    .eq("product_id", id)
    .maybeSingle();
  const invErr = invRow
    ? (
        await supabase
          .from("inventory")
          .update({ stock_quantity: productRow.stock_quantity ?? 0 })
          .eq("product_id", id)
      ).error
    : (
        await supabase.from("inventory").insert({
          product_id: id,
          stock_quantity: productRow.stock_quantity ?? 0,
          low_stock_threshold: 5,
          sold_quantity: 0,
        })
      ).error;
  if (invErr) return { error: `Product saved, but stock sync failed: ${invErr.message}` };

  // Stock crossed zero in this edit? Open the manual-platforms task.
  try {
    await logStockTransition(createAdminClient(), {
      productId: id,
      before: Number(invRow?.stock_quantity) || 0,
      after: productRow.stock_quantity ?? 0,
    });
  } catch { /* best-effort */ }

  // Replace variants: delete existing, re-insert the submitted set.
  await supabase.from("product_variants").delete().eq("parent_product_id", id);
  const variantRows = toVariantRows(id, input.variants);
  if (variantRows.length > 0) {
    const vErr = (await supabase.from("product_variants").insert(variantRows)).error;
    if (vErr) return { error: friendlyWriteError(vErr, "Could not save variants.") };
  }

  const changes = computeFieldChanges(
    (beforeRow ?? {}) as Record<string, unknown>,
    productRow as Record<string, unknown>,
    ["name_en", "name_ar", "sku", "barcode", "price", "discount_price", "description_en", "description_ar", "main_category", "sub_category", "image_url"],
  );
  // Approving through the full form gets the same "add it to the platforms"
  // task as the quick-approve buttons.
  const becameApproved =
    String((beforeRow as { approval?: string | null } | null)?.approval ?? "") !== "Approved" &&
    productRow.approval === "Approved";
  if (becameApproved) {
    await logCatalogTask({
      action: "create", productId: id, snapshot: productRow as Record<string, unknown>,
      note: "✅ المنتج انعتمد — أضِفه في المنصات اليدوية بكل بياناته، وبعد الإضافة علّم المهمة «تم».",
    });
    try { await queueForTalabat(createAdminClient(), id); } catch { /* best-effort */ }
  } else if (changes.length) {
    await logCatalogTask({ action: "update", productId: id, snapshot: productRow as Record<string, unknown>, changes });
  }

  revalidatePath("/products");
  revalidatePath(`/products/${id}`);
  revalidatePath("/inventory");
  redirect("/products");
}

// Quick approve/reject from the list or dashboard (no full form). Empty -> null.
// Optional reason (written to rejection_reason) records WHY.
const APPROVAL_OPTS = new Set(["Approved", "Rejected", "SentAI", ""]);
export async function setProductApproval(id: string, approval: string, reason?: string) {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  if (!id) return { error: "Missing product id." };
  if (!APPROVAL_OPTS.has(approval)) return { error: `Invalid approval "${approval}".` };
  const supabase = createClient();
  const patch: Record<string, unknown> = { approval: approval === "" ? null : approval };
  if (reason !== undefined) patch.rejection_reason = reason.trim() || null;
  // Full row: an APPROVAL task must carry everything the employee copies into
  // the manual platforms (names, prices, descriptions, category, photo).
  const { data: beforeRow } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  const { error } = await supabase.from("products").update(patch).eq("id", id);
  if (error) return { error: error.message };
  if (String(beforeRow?.approval ?? "") !== String(approval)) {
    if (approval === "Approved") {
      // Newly approved → the "add it to the platforms" task, full details.
      // The employee enters it in سنونو/رفيق then marks the task done; the
      // platform-export verification confirms it later. Talabat goes by the
      // owner's email instead — the product waits in talabat_queue.
      await logCatalogTask({
        action: "create", productId: id,
        snapshot: { ...(beforeRow ?? {}), approval: "Approved" } as Record<string, unknown>,
        note: "✅ المنتج انعتمد — أضِفه في المنصات اليدوية بكل بياناته، وبعد الإضافة علّم المهمة «تم».",
      });
      try { await queueForTalabat(createAdminClient(), id); } catch { /* best-effort */ }
    } else {
      await logCatalogTask({
        action: "approval", productId: id, snapshot: (beforeRow ?? {}) as Record<string, unknown>,
        changes: [{ field: "approval", old: String(beforeRow?.approval ?? "—"), new: approval || "—" }],
      });
    }
  }
  revalidatePath("/products");
  revalidatePath("/dashboard");
  revalidatePath(`/products/${id}`);
  return { ok: true };
}

// Inline product status toggle (Active / Draft) — straight from the catalog,
// no need to open the product editor.
export async function setProductStatus(id: string, status: string): Promise<{ ok?: true; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  if (!id) return { error: "Missing product id." };
  const value = status === "Active" ? "Active" : "Draft";
  const supabase = createClient();
  const { error } = await supabase.from("products").update({ platform_status: value }).eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/products");
  revalidatePath(`/products/${id}`);
  return { ok: true };
}

// Bulk approve/reject (e.g. reject everything Snoonu marked unavailable).
// Optional `reason` records WHY (written to notes), e.g. "بسبب الصورة".
export async function setProductsApproval(ids: string[], approval: string, reason?: string) {
  if (!(await isSignedIn())) return { error: "Not signed in.", updated: 0 };
  const list = (ids ?? []).filter(Boolean);
  if (list.length === 0) return { error: "No products selected.", updated: 0 };
  if (!APPROVAL_OPTS.has(approval)) return { error: `Invalid approval "${approval}".`, updated: 0 };
  const supabase = createClient();
  const value = approval === "" ? null : approval;
  const patch: Record<string, unknown> = { approval: value };
  // Record/clear the rejection reason on its own column.
  if (reason !== undefined) patch.rejection_reason = reason.trim() || null;
  let updated = 0, failed = 0;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { error, count } = await supabase
      .from("products").update(patch, { count: "exact" }).in("id", chunk);
    if (error) failed += chunk.length; else updated += count ?? chunk.length;
  }
  if (updated > 0) {
    const { data: sample } = await supabase.from("products").select("name_en, sku").in("id", list.slice(0, 6));
    const names = ((sample ?? []) as { name_en: string | null; sku: string | null }[])
      .map((r) => `${r.name_en ?? ""}${r.sku ? ` (${r.sku})` : ""}`).join("، ");
    await logCatalogTask({
      action: "bulk",
      note: `تغيير حالة ${updated} منتج إلى «${value ?? "بدون"}»${names ? ` — منها: ${names}${list.length > 6 ? "…" : ""}` : ""}`,
    });
  }
  revalidatePath("/products");
  revalidatePath("/dashboard");
  return { ok: failed === 0, updated, failed };
}

// Turn selected catalog products into manual "add to platforms" tasks — one
// task per product, each carrying its FULL snapshot and the exact platforms the
// manager picked, so an employee can add it by hand on those platforms and tick
// them off. Best-effort logging never blocks; returns how many tasks opened.
export async function createAddToPlatformTasks(
  productIds: string[],
  platforms: string[],
): Promise<{ ok?: true; created: number; error?: string }> {
  if (!(await isSignedIn())) return { error: "Not signed in.", created: 0 };
  const ids = [...new Set((productIds ?? []).filter(Boolean))];
  const plats = [...new Set((platforms ?? []).map((p) => String(p ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) return { error: "No products selected.", created: 0 };
  if (plats.length === 0) return { error: "No platforms selected.", created: 0 };

  const supabase = createClient();
  let created = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: rows } = await supabase.from("products").select("*").in("id", chunk);
    for (const row of (rows ?? []) as Record<string, unknown>[]) {
      await logCatalogTask({
        action: "add",
        productId: String(row.id),
        snapshot: row,
        platforms: plats,
        extraPayload: { platforms: plats },
      });
      created += 1;
    }
  }
  if (created > 0) revalidatePath("/tasks");
  return { ok: true, created };
}

export interface MatchedProduct { id: string; sku: string | null; name_en: string | null; approval: string | null }

// Match pasted lines (Snoonu names or SKUs) to catalog products, so the user can
// bulk-reject the products Snoonu rejected (that status isn't in the export).
export async function matchProductsByText(text: string): Promise<{ error?: string; matched: MatchedProduct[]; unmatched: string[] }> {
  if (!(await isSignedIn())) return { error: "Not signed in.", matched: [], unmatched: [] };
  const lines = [...new Set((text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
  if (lines.length === 0) return { matched: [], unmatched: [] };

  const supabase = createClient();
  const all: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.from("products").select("id, sku, name_en, name_ar, approval").range(f, f + 999);
    if (error) return { error: error.message, matched: [], unmatched: [] };
    all.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  // Normalize for matching: lowercase, drop apostrophes/quotes (straight vs
  // curly "Men's"), and collapse spaces — so OCR/paste text matches the catalog.
  const norm = (s: string) =>
    String(s ?? "").toLowerCase().replace(/[’‘'`´]/g, "").replace(/\s+/g, " ").trim();
  const matched: MatchedProduct[] = [];
  const seen = new Set<string>();
  const unmatched: string[] = [];
  for (const line of lines) {
    // strip trailing ellipsis from truncated names copied out of the Snoonu app
    const ln = norm(line).replace(/[.…]+$/, "").trim();
    if (!ln) continue;
    const hits = all.filter((p) =>
      norm(p.sku) === ln ||
      (p.name_en && norm(p.name_en).includes(ln)) ||
      (p.name_ar && norm(p.name_ar).includes(ln))
    );
    if (hits.length === 0) { unmatched.push(line); continue; }
    for (const h of hits) {
      if (!seen.has(h.id)) { seen.add(h.id); matched.push({ id: h.id, sku: h.sku, name_en: h.name_en, approval: h.approval }); }
    }
  }
  return { matched, unmatched };
}

// Read Snoonu "Drafts & Approvals" screenshots and extract the REJECTED product
// names (vision via Claude). Needs ANTHROPIC_API_KEY (set on Vercel).
export async function extractRejectedFromImages(
  images: { media_type: string; data: string }[]
): Promise<{ error?: string; names: string[] }> {
  if (!(await isSignedIn())) return { error: "Not signed in.", names: [] };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "ميزة قراءة الصور غير مفعّلة (ANTHROPIC_API_KEY).", names: [] };
  const imgs = (images ?? []).filter((i) => i?.data && i?.media_type).slice(0, 8);
  if (imgs.length === 0) return { error: "ما في صورة.", names: [] };

  const PROMPT =
    "هذي لقطات شاشة من تطبيق سنونو (قسم Drafts & Approvals). كل منتج له اسم وشارة حالة " +
    "(Rejected / Draft / Awaiting Approval). استخرج فقط أسماء المنتجات الإنجليزية اللي حالتها " +
    "Rejected. بعض الأسماء مقطوعة بـ '…' — رجّعها كما هي. أجب بمصفوفة JSON من النصوص فقط، بدون أي كلام آخر.";

  try {
    const client = new Anthropic({ apiKey });
    const content: any[] = imgs.map((im) => ({
      type: "image",
      source: { type: "base64", media_type: im.media_type, data: im.data },
    }));
    content.push({ type: "text", text: PROMPT });
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content }],
    });
    const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const m = text.match(/\[[\s\S]*\]/);
    let names: string[] = [];
    if (m) { try { names = JSON.parse(m[0]).filter((x: any) => typeof x === "string" && x.trim()); } catch {} }
    return { names: [...new Set(names.map((n) => n.trim()))] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "فشل قراءة الصورة.", names: [] };
  }
}

/** Next SKU in the catalog's mk#### scheme (max existing mk-number + 1). */
export async function nextProductSku(): Promise<{ sku: string; error?: string }> {
  if (!(await isSignedIn())) return { sku: "", error: "Not signed in." };
  const supabase = createClient();
  let maxMk = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("products").select("sku").range(from, from + 999);
    if (error) return { sku: "", error: error.message };
    for (const p of data ?? []) {
      const m = /^mk(\d+)$/i.exec(String((p as any).sku ?? "").trim());
      if (m) maxMk = Math.max(maxMk, parseInt(m[1], 10));
    }
    if ((data ?? []).length < 1000) break;
  }
  return { sku: `mk${maxMk + 1}` };
}

const ALLOWED_IMG = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Vision: look at a product image and draft title + description + keywords +
 *  category (EN/AR) in the SAME house style as the staff photo-first flow
 *  (shared prompt/parser in lib/products/draft-compute). The form decides
 *  what to apply. */
export async function describeProductFromImage(
  imageUrl: string,
  instructions?: string,
): Promise<{
  error?: string;
  data?: { name_en: string; name_ar: string; description_en: string; description_ar: string; keywords_en: string; keywords_ar: string; main_category: string; variants?: { variant_name: string; color: string; size: string }[] };
}> {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "ميزة الذكاء غير مفعّلة (ANTHROPIC_API_KEY)." };
  const rawUrl = (imageUrl ?? "").trim();
  if (!rawUrl) return { error: "أضف صورة (Image URL) أولاً." };
  // SSRF guard: only fetch public https URLs, never internal/metadata hosts.
  let url: string;
  try {
    url = assertSafeImageUrl(rawUrl);
  } catch (e: any) {
    return { error: e?.message || "رابط الصورة غير مسموح به." };
  }

  let media_type = "image/jpeg";
  let b64 = "";
  try {
    const r = await fetch(url);
    if (!r.ok) return { error: `تعذّر جلب الصورة (${r.status}).` };
    const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    media_type = ALLOWED_IMG.has(ct) ? ct : "image/jpeg";
    b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  } catch {
    return { error: "تعذّر جلب الصورة من الرابط." };
  }
  if (!b64) return { error: "الصورة فارغة." };

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: process.env.STAFF_MALAK_MODEL || "claude-sonnet-5",
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type, data: b64 } } as any,
            { type: "text", text: buildDraftPrompt(CATEGORIES, instructions) },
          ],
        },
      ],
    });
    const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const draft = parseProductDraft(text, CATEGORIES);
    if (!draft) return { error: "ما قدرت أحلّل الصورة." };
    return { data: draft };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "فشل تحليل الصورة." };
  }
}

export async function deleteProduct(id: string) {
  if (!(await isSignedIn())) return { error: "Not signed in." };
  const supabase = createClient();
  // Full snapshot BEFORE deleting — the auto-task carries it so the assignee
  // can remove the product from the manual platforms too.
  const { data: doomed } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  // Capture the options BEFORE deleting the variant rows, so the removal task
  // still lists every option to pull off the manual platforms.
  const { data: doomedVariants } = await supabase
    .from("product_variants")
    .select("variant_name, sku, barcode, color, size, price")
    .eq("parent_product_id", id);
  // Clean up dependent rows first (in case FKs aren't ON DELETE CASCADE).
  await supabase.from("product_variants").delete().eq("parent_product_id", id);
  await supabase.from("channel_products").delete().eq("product_id", id);
  await supabase.from("inventory").delete().eq("product_id", id);
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) return { error: error.message };
  await logCatalogTask({ action: "delete", productId: id, snapshot: { ...(doomed ?? {}), variants: doomedVariants ?? [] } as Record<string, unknown> });
  revalidatePath("/products");
  revalidatePath("/inventory");
  redirect("/products");
}
