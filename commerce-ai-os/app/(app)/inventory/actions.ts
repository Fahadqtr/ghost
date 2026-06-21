"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

/** Single-row inline save (kept for backward compatibility). */
export async function updateInventory(
  id: string,
  values: { stock_quantity: string; low_stock_threshold: string }
) {
  const supabase = createClient();
  const { error } = await supabase
    .from("inventory")
    .update({
      stock_quantity: toNum(values.stock_quantity),
      low_stock_threshold: toNum(values.low_stock_threshold),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok: true };
}

export type BulkUpdate = {
  id: string;
  stock_quantity?: string | number | null;
  low_stock_threshold?: string | number | null;
};

/** Apply many inventory edits in one call (bulk save / set-selected). */
export async function bulkUpdateInventory(updates: BulkUpdate[]) {
  const supabase = createClient();
  const now = new Date().toISOString();
  let ok = 0;
  const errors: string[] = [];

  for (const u of updates) {
    const patch: Record<string, unknown> = { updated_at: now };
    if (u.stock_quantity !== undefined) patch.stock_quantity = toNum(u.stock_quantity);
    if (u.low_stock_threshold !== undefined) patch.low_stock_threshold = toNum(u.low_stock_threshold);
    const { error } = await supabase.from("inventory").update(patch).eq("id", u.id);
    if (error) errors.push(`${u.id}: ${error.message}`);
    else ok++;
  }

  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok, failed: errors.length, errors: errors.slice(0, 5) };
}

export type CsvRow = { sku: string; stock_quantity?: string | number; low_stock_threshold?: string | number };

/** Import stock by SKU: maps each SKU → inventory row, then bulk-updates. */
export async function importInventoryBySku(rows: CsvRow[]) {
  const supabase = createClient();
  const clean = rows
    .map((r) => ({ ...r, sku: String(r.sku ?? "").trim() }))
    .filter((r) => r.sku);
  if (clean.length === 0) return { updated: 0, notFound: 0, failed: 0, missing: [] as string[] };

  const skus = Array.from(new Set(clean.map((r) => r.sku)));

  // sku -> inventory.id (inventory joined to products via product_id)
  const skuToInv = new Map<string, string>();
  for (let i = 0; i < skus.length; i += 300) {
    const chunk = skus.slice(i, i + 300);
    const { data } = await supabase
      .from("inventory")
      .select("id, products!inner(sku)")
      .in("products.sku", chunk);
    for (const row of (data ?? []) as any[]) {
      const sku = row.products?.sku;
      if (sku) skuToInv.set(String(sku), row.id);
    }
  }

  const now = new Date().toISOString();
  let updated = 0,
    failed = 0;
  const missing: string[] = [];

  for (const r of clean) {
    const id = skuToInv.get(r.sku);
    if (!id) {
      missing.push(r.sku);
      continue;
    }
    const patch: Record<string, unknown> = { updated_at: now };
    if (r.stock_quantity !== undefined && r.stock_quantity !== "") patch.stock_quantity = toNum(r.stock_quantity);
    if (r.low_stock_threshold !== undefined && r.low_stock_threshold !== "")
      patch.low_stock_threshold = toNum(r.low_stock_threshold);
    const { error } = await supabase.from("inventory").update(patch).eq("id", id);
    if (error) failed++;
    else updated++;
  }

  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { updated, notFound: missing.length, failed, missing: missing.slice(0, 20) };
}

/**
 * Push current Supabase stock to Shopify for the given SKUs.
 * Honest, env-gated: requires SHOPIFY_SHOP + SHOPIFY_ADMIN_TOKEN. Without them
 * it returns a clear "not configured" status instead of pretending to work.
 */
export async function pushStockToShopify(items: { sku: string; quantity: number }[]) {
  const SHOP = process.env.SHOPIFY_SHOP;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const LOCATION = process.env.SHOPIFY_LOCATION_ID || "gid://shopify/Location/81908531438";
  const VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

  if (!SHOP || !TOKEN) {
    return {
      configured: false as const,
      message:
        "Shopify push is not configured. Add SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN (Admin API token with write_inventory) to the server env to enable it.",
    };
  }

  const endpoint = `https://${SHOP}/admin/api/${VERSION}/graphql.json`;
  const gql = async (query: string, variables?: unknown) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  };

  let pushed = 0;
  const errors: string[] = [];
  for (const it of items) {
    try {
      const q = await gql(
        `query($q:String!){ productVariants(first:1, query:$q){ edges { node { inventoryItem { id } } } } }`,
        { q: `sku:${it.sku}` }
      );
      const invItem = q?.data?.productVariants?.edges?.[0]?.node?.inventoryItem?.id;
      if (!invItem) {
        errors.push(`${it.sku}: not found in Shopify`);
        continue;
      }
      const m = await gql(
        `mutation($input:InventorySetQuantitiesInput!){ inventorySetQuantities(input:$input){ userErrors{ message } } }`,
        {
          input: {
            name: "available",
            ignoreCompareQuantity: true,
            reason: "correction",
            quantities: [{ inventoryItemId: invItem, locationId: LOCATION, quantity: it.quantity }],
          },
        }
      );
      const ue = m?.data?.inventorySetQuantities?.userErrors;
      if (ue && ue.length) errors.push(`${it.sku}: ${ue[0].message}`);
      else pushed++;
    } catch (e: any) {
      errors.push(`${it.sku}: ${e?.message ?? "request failed"}`);
    }
  }

  return { configured: true as const, pushed, failed: errors.length, errors: errors.slice(0, 5) };
}
