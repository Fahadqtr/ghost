"use server";

import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CATEGORIES } from "@/lib/constants";
import { clean } from "@/lib/malak/talabat-export.mjs";

// --- input shapes (sent from the client form) -----------------------------

export interface VariantInput {
  id?: string;
  variant_name: string;
  sku: string;
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
    image_filename: str(input.image_filename),
    image_url: str(input.image_url),
    description_en: cleanStr(input.description_en),
    description_ar: cleanStr(input.description_ar),
    keywords_en: str(input.keywords_en),
    keywords_ar: str(input.keywords_ar),
    notes: str(input.notes),
  };
}

function toVariantRows(parentId: string, variants: VariantInput[]) {
  return variants
    .filter((v) => str(v.variant_name) || str(v.sku))
    .map((v) => ({
      parent_product_id: parentId,
      variant_name: str(v.variant_name),
      sku: str(v.sku),
      color: str(v.color),
      size: str(v.size),
      price: num(v.price),
      stock_quantity: num(v.stock_quantity),
    }));
}

// --- actions --------------------------------------------------------------

export async function createProduct(input: ProductInput) {
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
    return { error: error?.message ?? "Could not create product." };
  }

  // Seed an inventory row so the product appears on the Inventory page.
  await supabase.from("inventory").insert({
    product_id: product.id,
    stock_quantity: productRow.stock_quantity ?? 0,
    low_stock_threshold: 5,
    sold_quantity: 0,
  });

  // Insert variants (parent-child) if any.
  const variantRows = toVariantRows(product.id, input.variants);
  if (variantRows.length > 0) {
    await supabase.from("product_variants").insert(variantRows);
  }

  revalidatePath("/products");
  revalidatePath("/inventory");
  redirect("/products");
}

export async function updateProduct(id: string, input: ProductInput) {
  const supabase = createClient();

  let productRow;
  try {
    productRow = toProductRow(input);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid product data." };
  }

  const { error } = await supabase
    .from("products")
    .update(productRow)
    .eq("id", id);

  if (error) return { error: error.message };

  // Replace variants: delete existing, re-insert the submitted set.
  await supabase.from("product_variants").delete().eq("parent_product_id", id);
  const variantRows = toVariantRows(id, input.variants);
  if (variantRows.length > 0) {
    await supabase.from("product_variants").insert(variantRows);
  }

  revalidatePath("/products");
  revalidatePath(`/products/${id}`);
  redirect("/products");
}

// Quick approve/reject from the list or dashboard (no full form). Empty -> null.
const APPROVAL_OPTS = new Set(["Approved", "Rejected", "SentAI", ""]);
export async function setProductApproval(id: string, approval: string) {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { error: "Not signed in." };
  if (!id) return { error: "Missing product id." };
  if (!APPROVAL_OPTS.has(approval)) return { error: `Invalid approval "${approval}".` };
  const supabase = createClient();
  const { error } = await supabase
    .from("products")
    .update({ approval: approval === "" ? null : approval })
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/products");
  revalidatePath("/dashboard");
  revalidatePath(`/products/${id}`);
  return { ok: true };
}

// Bulk approve/reject (e.g. reject everything Snoonu marked unavailable).
export async function setProductsApproval(ids: string[], approval: string) {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { error: "Not signed in.", updated: 0 };
  const list = (ids ?? []).filter(Boolean);
  if (list.length === 0) return { error: "No products selected.", updated: 0 };
  if (!APPROVAL_OPTS.has(approval)) return { error: `Invalid approval "${approval}".`, updated: 0 };
  const supabase = createClient();
  const value = approval === "" ? null : approval;
  let updated = 0, failed = 0;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { error, count } = await supabase
      .from("products").update({ approval: value }, { count: "exact" }).in("id", chunk);
    if (error) failed += chunk.length; else updated += count ?? chunk.length;
  }
  revalidatePath("/products");
  revalidatePath("/dashboard");
  return { ok: failed === 0, updated, failed };
}

export interface MatchedProduct { id: string; sku: string | null; name_en: string | null; approval: string | null }

// Match pasted lines (Snoonu names or SKUs) to catalog products, so the user can
// bulk-reject the products Snoonu rejected (that status isn't in the export).
export async function matchProductsByText(text: string): Promise<{ error?: string; matched: MatchedProduct[]; unmatched: string[] }> {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { error: "Not signed in.", matched: [], unmatched: [] };
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
  const norm = (s: string) => String(s ?? "").toLowerCase().trim();
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
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return { error: "Not signed in.", names: [] };
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

export async function deleteProduct(id: string) {
  const supabase = createClient();
  // Clean up dependent rows first (in case FKs aren't ON DELETE CASCADE).
  await supabase.from("product_variants").delete().eq("parent_product_id", id);
  await supabase.from("channel_products").delete().eq("product_id", id);
  await supabase.from("inventory").delete().eq("product_id", id);
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/products");
  revalidatePath("/inventory");
  redirect("/products");
}
