"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CATEGORIES } from "@/lib/constants";

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
    throw new Error(`Invalid category "${category}". Must be one of the 11 locked categories.`);
  }
  return {
    sku: str(input.sku),
    barcode: str(input.barcode),
    name_en: str(input.name_en),
    name_ar: str(input.name_ar),
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
    image_filename: str(input.image_filename),
    image_url: str(input.image_url),
    description_en: str(input.description_en),
    description_ar: str(input.description_ar),
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
