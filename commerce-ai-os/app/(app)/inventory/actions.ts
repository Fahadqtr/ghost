"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/paginate";
import { applyMovement } from "@/lib/inventory/movements";
import { requireUser } from "@/lib/auth/requireUser";
import { insertAuditRow } from "@/lib/audit";
import { getInventoryMode, setInventoryMode, type InventoryMode } from "@/lib/settings";
import { logStockTransition, logVariantStockTransition } from "@/lib/tasks/stock-tasks";
import { pushInventoryStockToShopify } from "@/lib/shopify/admin";
import { summarizeStockSync, type ShopifyStockSyncStatus } from "@/lib/shopify/stock-push";
import Anthropic from "@anthropic-ai/sdk";

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

// Prefer the service-role client (bypasses RLS); fall back to the request-scoped
// RLS client when SUPABASE_SERVICE_ROLE_KEY isn't configured (e.g. a preview
// deployment). Reads and inventory writes work under RLS for a signed-in user.
function writableClient(): any {
  try {
    return createAdminClient();
  } catch {
    return createClient();
  }
}

// Best-effort audit ledger write (malak_audit). Never throws — the underlying
// data change has already succeeded by the time we log. Routed through
// insertAuditRow so product_id lands in the (post-migration) uuid column.
async function logAudit(
  admin: any,
  entry: { action: string; sku?: string | null; productId?: string | null; field?: string; oldVal?: string | null; newVal?: string | null; details?: Record<string, unknown> }
) {
  try {
    await insertAuditRow(admin, {
      agent: "inventory",
      action: entry.action,
      action_type: entry.action,
      sku: entry.sku ?? null,
      product_id: entry.productId ?? null,
      field: entry.field ?? null,
      old_value: entry.oldVal ?? null,
      new_value: entry.newVal ?? null,
      status: "done",
      details: entry.details ?? {},
    });
  } catch (e) {
    console.error("[logAudit] insert failed:", e);
  }
}

// Resolve a product's SKU from an inventory row id (for audit labelling).
async function skuForInventory(admin: any, inventoryId: string): Promise<string | null> {
  const { data } = await admin.from("inventory").select("products(sku)").eq("id", inventoryId).single();
  return (data as any)?.products?.sku ?? null;
}

/** Single-row inline save (kept for backward compatibility). */
export async function updateInventory(
  id: string,
  values: { stock_quantity: string; low_stock_threshold: string }
) {
  const unauth = await requireUser();
  if (unauth) return unauth;
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
  const unauth = await requireUser();
  if (unauth) return { ok: 0, failed: updates.length, errors: [unauth.error] };
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

export type StocktakeCount = {
  inventoryId: string;
  sku?: string | null;
  counted: number;
  location?: string | null; // when set, also save the product's shelf location
};

/**
 * Apply a shelf stocktake: set each inventory row's stock_quantity to the
 * physically counted number, and write a `stocktake` ledger row recording the
 * variance (old → new). Service-role client so it works under preview too.
 */
export async function applyStocktake(counts: StocktakeCount[]) {
  const unauth = await requireUser();
  if (unauth) return { ok: 0, failed: counts.length, errors: [unauth.error] };
  const admin = writableClient();
  const now = new Date().toISOString();
  let ok = 0;
  const errors: string[] = [];

  for (const c of counts) {
    // Validate the RAW value first — Math.max/floor turn NaN into 0, so a
    // garbage count would otherwise be silently SET as zero stock.
    const rawCounted = Number(c.counted);
    if (!c.inventoryId || Number.isNaN(rawCounted)) {
      errors.push(`${c.sku ?? c.inventoryId}: invalid count`);
      continue;
    }
    const counted = Math.max(0, Math.floor(rawCounted));
    const { data: inv, error: readErr } = await admin
      .from("inventory")
      .select("id, stock_quantity, product_id, location")
      .eq("id", c.inventoryId)
      .single();
    if (readErr || !inv) {
      errors.push(`${c.sku ?? c.inventoryId}: not found`);
      continue;
    }
    const before = inv.stock_quantity ?? 0;
    const newLoc = c.location != null ? c.location.trim().toUpperCase() : null;
    const locChanged = newLoc != null && newLoc !== (inv.location ?? null);
    if (before === counted && !locChanged) {
      ok++; // no change needed, still a success
      continue;
    }
    const patch: Record<string, unknown> = { stock_quantity: counted, updated_at: now };
    if (locChanged) patch.location = newLoc;
    const { error: upErr } = await admin.from("inventory").update(patch).eq("id", inv.id);
    if (upErr) {
      errors.push(`${c.sku ?? c.inventoryId}: ${upErr.message}`);
      continue;
    }
    ok++;
    // Best-effort ledger entry recording the variance (insertAuditRow degrades
    // to the legacy details-only shape on an unmigrated malak_audit).
    await insertAuditRow(admin, {
      agent: "stocktake",
      action: "stocktake",
      action_type: "stocktake",
      sku: c.sku ?? null,
      product_id: inv.product_id ?? null,
      field: "stock_quantity",
      old_value: String(before),
      new_value: String(counted),
      status: "done",
      details: { productId: inv.product_id ?? null, counted, previous: before, variance: counted - before },
    });
  }

  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok, failed: errors.length, errors: errors.slice(0, 5) };
}

export type VariantCount = {
  variantId: string;
  sku?: string | null;
  counted: number;
};

/**
 * Apply a VARIANT-level stocktake: set each variant's stock_quantity to the
 * physically counted number, then re-total each affected parent product's
 * inventory (= sum of its variants' stock). Each option is counted independently
 * — used when scanning per-variant barcodes on the shelf.
 */
export async function applyVariantStocktake(counts: VariantCount[]) {
  const unauth = await requireUser();
  if (unauth) return { ok: 0, failed: counts.length, errors: [unauth.error] };
  const admin = writableClient();
  const now = new Date().toISOString();
  let ok = 0;
  const errors: string[] = [];
  const parents = new Set<string>();

  for (const c of counts) {
    const rawCounted = Number(c.counted);
    if (!c.variantId || Number.isNaN(rawCounted)) {
      errors.push(`${c.sku ?? c.variantId}: invalid count`);
      continue;
    }
    const counted = Math.max(0, Math.floor(rawCounted));
    const { data: v, error: readErr } = await admin
      .from("product_variants")
      .select("id, stock_quantity, parent_product_id")
      .eq("id", c.variantId)
      .single();
    if (readErr || !v) {
      errors.push(`${c.sku ?? c.variantId}: not found`);
      continue;
    }
    const before = v.stock_quantity ?? 0;
    if (before !== counted) {
      const { error: upErr } = await admin
        .from("product_variants")
        .update({ stock_quantity: counted })
        .eq("id", v.id);
      if (upErr) {
        errors.push(`${c.sku ?? c.variantId}: ${upErr.message}`);
        continue;
      }
      // Best-effort variance ledger (see note in applyStocktake).
      await insertAuditRow(admin, {
        agent: "stocktake",
        action: "stocktake",
        action_type: "stocktake",
        sku: c.sku ?? null,
        product_id: v.parent_product_id ?? null,
        field: "variant_stock_quantity",
        old_value: String(before),
        new_value: String(counted),
        status: "done",
        details: { variantId: v.id, productId: v.parent_product_id ?? null, counted, previous: before, variance: counted - before },
      });
    }
    if (v.parent_product_id) parents.add(v.parent_product_id);
    ok++;
  }

  // Re-total each affected parent: inventory.stock_quantity = sum of its variants.
  for (const pid of parents) {
    const { data: sibs } = await admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("parent_product_id", pid);
    const sum = ((sibs ?? []) as any[]).reduce((s, r) => s + (r.stock_quantity ?? 0), 0);
    await admin.from("inventory").update({ stock_quantity: sum, updated_at: now }).eq("product_id", pid);
  }

  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok, failed: errors.length, errors: errors.slice(0, 5) };
}

// ── Shelf / bin locations ──────────────────────────────────────────────────

/** Set (or clear) a product's physical shelf location, e.g. "A1". */
export async function setLocation(inventoryId: string, location: string) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  if (!inventoryId) return { error: "Missing inventory row." };
  const admin = writableClient();
  const value = location.trim().toUpperCase() || null;
  const { data: prev } = await admin.from("inventory").select("location, stock_quantity, products(sku)").eq("id", inventoryId).single();
  const { error } = await admin
    .from("inventory")
    .update({ location: value, updated_at: new Date().toISOString() })
    .eq("id", inventoryId);
  if (error) return { error: error.message };

  // Keep shelf_stock in sync. The shelves page reads slot counts AND "Shelf
  // contents" from shelf_stock (when that table exists), so assigning a slot via
  // the inventory Location field MUST place a shelf_stock row — otherwise the
  // product is invisible on the shelf even though inventory.location is set.
  const hasShelfStock = !(await admin.from("shelf_stock").select("inventory_id").limit(1)).error;
  if (hasShelfStock) {
    await admin.from("shelf_stock").delete().eq("inventory_id", inventoryId);
    if (value) {
      const qty = Math.max(0, Math.floor(Number((prev as any)?.stock_quantity) || 0));
      await admin.from("shelf_stock").insert({ inventory_id: inventoryId, location: value, quantity: qty, updated_at: new Date().toISOString() });
    }
  }

  await logAudit(admin, {
    action: "shelf_move",
    sku: (prev as any)?.products?.sku ?? null,
    field: "location",
    oldVal: (prev as any)?.location ?? null,
    newVal: value,
    details: { inventoryId },
  });
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  revalidatePath("/inventory/movements");
  return { ok: true };
}

/**
 * Apply a shelf-scoped count: set each product's quantity AT one slot, then set
 * the product's total stock to the SUM of all its shelves. Used by the stocktake
 * "count one shelf" flow.
 */
export async function applyShelfCounts(
  location: string,
  counts: { inventoryId: string; counted: number }[]
) {
  const unauth = await requireUser();
  if (unauth) return { ok: 0, failed: counts.length, errors: [unauth.error] };
  const admin = writableClient();
  const slot = (location ?? "").trim().toUpperCase();
  if (!slot) return { ok: 0, failed: counts.length, errors: ["No shelf selected."] };
  const now = new Date().toISOString();
  let ok = 0;
  const errors: string[] = [];
  const touched = new Set<string>();
  for (const c of counts) {
    if (!c.inventoryId) { errors.push("missing row"); continue; }
    const qty = Math.max(0, Math.floor(Number(c.counted) || 0));
    if (qty <= 0) {
      const del = await admin.from("shelf_stock").delete().eq("inventory_id", c.inventoryId).eq("location", slot);
      if (del.error) { errors.push(del.error.message); continue; }
    } else {
      const up = await admin
        .from("shelf_stock")
        .upsert({ inventory_id: c.inventoryId, location: slot, quantity: qty, updated_at: now }, { onConflict: "inventory_id,location" });
      if (up.error) { errors.push(up.error.message); continue; }
    }
    touched.add(c.inventoryId);
    ok++;
  }
  // Re-total each touched product: stock_quantity = sum of all its shelves.
  for (const id of touched) {
    const { data } = await admin.from("shelf_stock").select("quantity").eq("inventory_id", id);
    const sum = ((data ?? []) as any[]).reduce((s, r) => s + (r.quantity ?? 0), 0);
    await admin.from("inventory").update({ stock_quantity: sum, updated_at: now }).eq("id", id);
  }
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  return { ok, failed: errors.length, errors: errors.slice(0, 5) };
}

/**
 * Replace a VARIANT's per-shelf distribution. The variant's stock_quantity is set
 * to the sum of its placements, and the parent product's inventory total is set
 * to the sum of all its variants' stock.
 */
export async function saveVariantShelfStock(
  variantId: string,
  rows: { location: string; quantity: number }[]
) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  if (!variantId) return { error: "Missing variant." };
  const admin = writableClient();
  const now = new Date().toISOString();

  const merged = new Map<string, number>();
  for (const r of rows) {
    const code = (r.location ?? "").trim().toUpperCase();
    const q = Math.max(0, Math.floor(Number(r.quantity) || 0));
    if (!code || q <= 0) continue;
    merged.set(code, (merged.get(code) ?? 0) + q);
  }
  const clean = Array.from(merged.entries()).map(([location, quantity]) => ({
    variant_id: variantId,
    location,
    quantity,
    updated_at: now,
  }));

  const del = await admin.from("variant_shelf_stock").delete().eq("variant_id", variantId);
  if (del.error) return { error: del.error.message };
  if (clean.length) {
    const ins = await admin.from("variant_shelf_stock").insert(clean);
    if (ins.error) return { error: ins.error.message };
  }

  // Variant stock = sum of its placements (only when there's at least one).
  const totalQty = clean.reduce((s, r) => s + r.quantity, 0);
  if (clean.length) {
    await admin.from("product_variants").update({ stock_quantity: totalQty }).eq("id", variantId);
  }

  // Parent product inventory total = sum of all its variants' stock.
  const { data: v } = await admin.from("product_variants").select("parent_product_id").eq("id", variantId).single();
  const parentId = (v as any)?.parent_product_id;
  if (parentId) {
    const { data: sibs } = await admin.from("product_variants").select("stock_quantity").eq("parent_product_id", parentId);
    const sum = ((sibs ?? []) as any[]).reduce((s, r) => s + (r.stock_quantity ?? 0), 0);
    await admin.from("inventory").update({ stock_quantity: sum, updated_at: now }).eq("product_id", parentId);
  }

  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  return { ok: true };
}

/**
 * Replace a product's per-shelf distribution. `rows` is the full desired set of
 * (location, quantity) placements; empty/zero quantities are dropped. The total
 * stock (inventory.stock_quantity) is set to the SUM of the placements, and
 * inventory.location is kept in sync with the largest placement (primary).
 */
export async function saveShelfStock(
  inventoryId: string,
  rows: { location: string; quantity: number }[]
) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  if (!inventoryId) return { error: "Missing inventory row." };
  const admin = writableClient();

  // Normalize: uppercase codes, merge duplicates, keep positive quantities.
  const merged = new Map<string, number>();
  for (const r of rows) {
    const code = (r.location ?? "").trim().toUpperCase();
    const q = Math.max(0, Math.floor(Number(r.quantity) || 0));
    if (!code || q <= 0) continue;
    merged.set(code, (merged.get(code) ?? 0) + q);
  }
  const clean = Array.from(merged.entries()).map(([location, quantity]) => ({
    inventory_id: inventoryId,
    location,
    quantity,
    updated_at: new Date().toISOString(),
  }));

  // Replace the product's placements wholesale.
  const del = await admin.from("shelf_stock").delete().eq("inventory_id", inventoryId);
  if (del.error) return { error: del.error.message };
  if (clean.length) {
    const ins = await admin.from("shelf_stock").insert(clean);
    if (ins.error) return { error: ins.error.message };
  }

  // Primary location = the slot holding the most units (or null); total stock =
  // sum of all placements (only when there's at least one, so clearing all
  // placements doesn't silently zero the stock).
  const primary = clean.slice().sort((a, b) => b.quantity - a.quantity)[0]?.location ?? null;
  const totalQty = clean.reduce((s, r) => s + r.quantity, 0);
  const patch: Record<string, unknown> = { location: primary, updated_at: new Date().toISOString() };
  if (clean.length) patch.stock_quantity = totalQty;
  await admin.from("inventory").update(patch).eq("id", inventoryId);

  await logAudit(admin, {
    action: "shelf_assign",
    sku: await skuForInventory(admin, inventoryId),
    field: "location",
    oldVal: null,
    newVal: clean.map((c) => `${c.location}×${c.quantity}`).join(", ") || null,
    details: { inventoryId, placements: clean.map((c) => ({ location: c.location, quantity: c.quantity })) },
  });
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  revalidatePath("/inventory/movements");
  return { ok: true };
}

/** Set barcodes on specific variant rows. Uses the service-role client so it
 *  works even when product_variants RLS has no UPDATE policy for the user (the
 *  rest of the app only ever inserts/deletes variants, never updates them from
 *  the browser, so a client-side update would silently affect 0 rows). */
export async function setVariantBarcodes(updates: { id: string; barcode: string | null }[]) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  if (!updates?.length) return { ok: true };
  const admin = writableClient();
  for (const u of updates) {
    if (!u.id) continue;
    const bc = u.barcode && u.barcode.trim() !== "" ? u.barcode.trim() : null;
    const { error } = await admin.from("product_variants").update({ barcode: bc }).eq("id", u.id);
    if (error) return { error: error.message };
  }
  revalidatePath("/catalog/health");
  revalidatePath("/inventory");
  return { ok: true };
}

/** Upsert a product's variant rows: rows with an id are updated (name/barcode),
 *  rows without an id are inserted as new options. Service-role write so it
 *  propagates everywhere (inventory KPIs, labels, catalog health). */
export async function upsertVariants(
  parentProductId: string,
  rows: { id?: string | null; variant_name: string | null; barcode: string | null }[]
) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  if (!parentProductId) return { error: "Missing product." };
  const admin = writableClient();
  for (const r of rows) {
    const bc = r.barcode && r.barcode.trim() !== "" ? r.barcode.trim() : null;
    const name = r.variant_name && r.variant_name.trim() !== "" ? r.variant_name.trim() : null;
    if (r.id) {
      const { error } = await admin
        .from("product_variants")
        .update({ variant_name: name, barcode: bc })
        .eq("id", r.id);
      if (error) return { error: error.message };
    } else {
      // Skip empty new rows (no name and no barcode).
      if (!name && !bc) continue;
      const { error } = await admin
        .from("product_variants")
        .insert({ parent_product_id: parentProductId, variant_name: name, barcode: bc });
      if (error) return { error: error.message };
    }
  }
  revalidatePath("/catalog/health");
  revalidatePath("/inventory");
  return { ok: true };
}

/** Recompute inventory.location (primary slot) + total stock from shelf_stock. */
async function resyncInventoryFromShelfStock(
  admin: ReturnType<typeof writableClient>,
  inventoryId: string
) {
  const { data } = await admin
    .from("shelf_stock")
    .select("location, quantity")
    .eq("inventory_id", inventoryId);
  const rows = (data ?? []) as { location: string; quantity: number }[];
  const primary = rows.slice().sort((a, b) => b.quantity - a.quantity)[0]?.location ?? null;
  const total = rows.reduce((s, r) => s + (r.quantity ?? 0), 0);
  const patch: Record<string, unknown> = { location: primary, updated_at: new Date().toISOString() };
  // Don't silently zero stock when the last placement is removed — only adjust
  // the total while there's still at least one placement to sum.
  if (rows.length) patch.stock_quantity = total;
  await admin.from("inventory").update(patch).eq("id", inventoryId);
}

/** Remove a product from a single shelf slot (deletes that shelf_stock row). */
export async function removeFromShelf(inventoryId: string, location: string) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const slot = (location ?? "").trim().toUpperCase();
  if (!inventoryId || !slot) return { error: "Missing inventory row or slot." };
  const admin = writableClient();

  const del = await admin.from("shelf_stock").delete().eq("inventory_id", inventoryId).eq("location", slot);
  if (del.error) return { error: del.error.message };

  await resyncInventoryFromShelfStock(admin, inventoryId);
  await logAudit(admin, {
    action: "shelf_remove",
    sku: await skuForInventory(admin, inventoryId),
    field: "location",
    oldVal: slot,
    newVal: null,
    details: { inventoryId },
  });
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  revalidatePath("/inventory/movements");
  return { ok: true };
}

/** Move a product's placement from one slot to another (merges if the target
 *  already holds units of the same product). */
export async function moveShelfStock(inventoryId: string, fromLocation: string, toLocation: string) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const from = (fromLocation ?? "").trim().toUpperCase();
  const to = (toLocation ?? "").trim().toUpperCase();
  if (!inventoryId || !from || !to) return { error: "Missing inventory row or slot." };
  if (from === to) return { ok: true };
  const admin = writableClient();

  const { data: src } = await admin
    .from("shelf_stock")
    .select("quantity")
    .eq("inventory_id", inventoryId)
    .eq("location", from)
    .maybeSingle();
  if (!src) return { error: "Placement not found." };
  const { data: dst } = await admin
    .from("shelf_stock")
    .select("quantity")
    .eq("inventory_id", inventoryId)
    .eq("location", to)
    .maybeSingle();

  const now = new Date().toISOString();
  const del = await admin.from("shelf_stock").delete().eq("inventory_id", inventoryId).eq("location", from);
  if (del.error) return { error: del.error.message };
  const up = await admin
    .from("shelf_stock")
    .upsert(
      { inventory_id: inventoryId, location: to, quantity: (dst?.quantity ?? 0) + (src.quantity ?? 0), updated_at: now },
      { onConflict: "inventory_id,location" }
    );
  if (up.error) return { error: up.error.message };

  await resyncInventoryFromShelfStock(admin, inventoryId);
  await logAudit(admin, {
    action: "shelf_move",
    sku: await skuForInventory(admin, inventoryId),
    field: "location",
    oldVal: from,
    newVal: to,
    details: { inventoryId, quantity: src.quantity ?? 0 },
  });
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  revalidatePath("/inventory/movements");
  return { ok: true };
}

/**
 * Bulk-assign selected products to one shelf slot in a single batch. Replaces
 * each product's placement with the chosen slot (holding its full stock) and
 * logs every assignment to the movement history.
 */
export async function bulkAssignShelf(inventoryIds: string[], location: string, setQty?: number) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const slot = (location ?? "").trim().toUpperCase();
  const ids = (inventoryIds ?? []).filter(Boolean);
  if (!slot || ids.length === 0) return { error: "اختر رفّاً ومنتجاً واحداً على الأقل." };
  // When provided, the placed quantity is forced to this value (and the row's
  // total stock is updated to match) — lets "set qty + assign shelf" be one step.
  const forced = setQty == null ? null : Math.max(0, Math.floor(setQty));
  const admin = writableClient();
  const now = new Date().toISOString();
  const hasShelfStock = !(await admin.from("shelf_stock").select("id").limit(1)).error;

  let done = 0;
  const errors: string[] = [];
  for (const id of ids) {
    const { data: inv } = await admin
      .from("inventory")
      .select("id, stock_quantity, location, products(sku)")
      .eq("id", id)
      .single();
    if (!inv) continue;
    const before = (inv as any).location ?? null;
    const qty = forced ?? ((inv as any).stock_quantity ?? 0);
    // 0 units → nothing to place; keep `location` consistent with the (empty)
    // shelf map instead of pointing at a slot that holds no shelf_stock row.
    const newLoc = qty > 0 ? slot : null;

    if (hasShelfStock) {
      const del = await admin.from("shelf_stock").delete().eq("inventory_id", id);
      if (del.error) { errors.push(del.error.message); continue; }
      if (qty > 0) {
        const ins = await admin
          .from("shelf_stock")
          .insert({ inventory_id: id, location: slot, quantity: qty, updated_at: now });
        if (ins.error) { errors.push(ins.error.message); continue; }
      }
    }
    const patch: Record<string, unknown> = { location: newLoc, updated_at: now };
    if (forced != null) patch.stock_quantity = forced;
    const up = await admin.from("inventory").update(patch).eq("id", id);
    if (up.error) { errors.push(up.error.message); continue; }

    await logAudit(admin, {
      action: "shelf_assign",
      sku: (inv as any).products?.sku ?? null,
      field: "location",
      oldVal: before,
      newVal: newLoc,
      details: { inventoryId: id, quantity: qty },
    });
    done++;
  }

  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  revalidatePath("/inventory/movements");
  if (errors.length) return { ok: done > 0, done, error: `${done} نُسب، ${errors.length} فشل: ${errors.join("; ")}` };
  return { ok: true, done };
}

/**
 * Bulk-assign selected variants (options) to one shelf slot. Each variant's full
 * stock is placed at the slot (replacing its placements), the parent product's
 * inventory total is re-synced, and every assignment is logged to history.
 */
export async function bulkAssignVariantShelf(variantIds: string[], location: string, setQty?: number) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const slot = (location ?? "").trim().toUpperCase();
  const ids = (variantIds ?? []).filter(Boolean);
  if (!slot || ids.length === 0) return { error: "اختر رفّاً وخياراً واحداً على الأقل." };
  // When provided, force each option's placed quantity (and its stock) to this.
  const forced = setQty == null ? null : Math.max(0, Math.floor(setQty));
  const admin = writableClient();
  const now = new Date().toISOString();
  const parents = new Set<string>();

  let done = 0;
  const errors: string[] = [];
  for (const id of ids) {
    const { data: v } = await admin
      .from("product_variants")
      .select("id, stock_quantity, parent_product_id, variant_name, sku")
      .eq("id", id)
      .single();
    if (!v) continue;
    // Track the parent up front so a mid-loop failure still re-syncs its total.
    if ((v as any).parent_product_id) parents.add((v as any).parent_product_id);
    const qty = forced ?? ((v as any).stock_quantity ?? 0);
    const del = await admin.from("variant_shelf_stock").delete().eq("variant_id", id);
    if (del.error) { errors.push(del.error.message); continue; }
    if (qty > 0) {
      const ins = await admin
        .from("variant_shelf_stock")
        .insert({ variant_id: id, location: slot, quantity: qty, updated_at: now });
      if (ins.error) { errors.push(ins.error.message); continue; }
    }
    if (forced != null) {
      const uv = await admin.from("product_variants").update({ stock_quantity: forced }).eq("id", id);
      if (uv.error) { errors.push(uv.error.message); continue; }
    }
    await logAudit(admin, {
      action: "shelf_assign",
      sku: (v as any).sku ?? null,
      field: "location",
      oldVal: null,
      newVal: slot,
      details: { variantId: id, variantName: (v as any).variant_name ?? null, quantity: qty },
    });
    done++;
  }

  // Re-sync each affected parent product's inventory total = sum of variant stock.
  // Runs regardless of per-item failures so the parent total never drifts.
  for (const parentId of parents) {
    const { data: sibs } = await admin.from("product_variants").select("stock_quantity").eq("parent_product_id", parentId);
    const sum = ((sibs ?? []) as any[]).reduce((s, r) => s + (r.stock_quantity ?? 0), 0);
    await admin.from("inventory").update({ stock_quantity: sum, updated_at: now }).eq("product_id", parentId);
  }

  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  revalidatePath("/inventory/movements");
  if (errors.length) return { ok: done > 0, done, error: `${done} نُسب، ${errors.length} فشل: ${errors.join("; ")}` };
  return { ok: true, done };
}

/**
 * Create a shelf and its slots in one go: shelf "A" with count 5 makes
 * A1..A5. Existing slots are left untouched (idempotent upsert).
 */
export async function createShelf(shelf: string, count: number) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const letter = shelf.trim().toUpperCase().replace(/[^A-Z]/g, "");
  const n = Math.max(1, Math.min(200, Math.floor(count)));
  if (!letter) return { error: "Enter a shelf letter (A–Z)." };
  const admin = writableClient();
  const rows = Array.from({ length: n }, (_, i) => ({
    code: `${letter}${i + 1}`,
    shelf: letter,
    sort: i + 1,
  }));
  const { error } = await admin.from("shelf_slots").upsert(rows, { onConflict: "code" });
  if (error) return { error: error.message };
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  revalidatePath("/inventory");
  return { ok: true, created: rows.length };
}

/** Add a single slot by code, e.g. "C7". */
export async function addSlot(code: string) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const c = code.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]+[0-9]+$/.test(c)) return { error: "Use a code like A1, B12." };
  const shelf = c.match(/^[A-Z]+/)![0];
  const sort = parseInt(c.replace(/^[A-Z]+/, ""), 10) || 0;
  const admin = writableClient();
  const { error } = await admin.from("shelf_slots").upsert({ code: c, shelf, sort }, { onConflict: "code" });
  if (error) return { error: error.message };
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  return { ok: true };
}

/** Delete one slot. Any products placed there are unplaced (shelf_stock rows
 *  removed + their location pointer cleared) so no stock is stranded at a slot
 *  that no longer exists. Their total stock is kept. */
export async function deleteSlot(code: string) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = writableClient();
  const slot = code.trim().toUpperCase();
  // Unplace products at this slot (best-effort; ignores missing shelf_stock table).
  await admin.from("shelf_stock").delete().eq("location", slot);
  await admin.from("inventory").update({ location: null }).eq("location", slot);
  const { error } = await admin.from("shelf_slots").delete().eq("code", code);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  return { ok: true };
}

/** Delete a whole shelf (all its slots) + unplace any products on it. */
export async function deleteShelf(shelf: string) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = writableClient();
  const sh = shelf.trim().toUpperCase();
  // Resolve this shelf's slot codes, then unplace products at any of them.
  const { data: slots } = await admin.from("shelf_slots").select("code").eq("shelf", sh);
  const codes = ((slots ?? []) as any[]).map((s) => String(s.code).toUpperCase());
  if (codes.length) {
    await admin.from("shelf_stock").delete().in("location", codes);
    await admin.from("inventory").update({ location: null }).in("location", codes);
  }
  const { error } = await admin.from("shelf_slots").delete().eq("shelf", sh);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  return { ok: true };
}

export type CsvRow = { sku: string; stock_quantity?: string | number; low_stock_threshold?: string | number };

/** Import stock by SKU: maps each SKU → inventory row, then bulk-updates. */
export async function importInventoryBySku(rows: CsvRow[]) {
  const unauth = await requireUser();
  if (unauth) return { updated: 0, notFound: 0, failed: 0, missing: [] as string[], error: unauth.error };
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
 * Push current Supabase stock to Shopify for the given SKUs — through the ONE
 * central Shopify client (`lib/shopify/admin.ts`), so it works with the OAuth
 * connection exactly like every other Shopify call (products, orders, prices,
 * the nightly availability sync). No Shopify credentials, API version, shop URL,
 * or location id are read here; the central client owns all of that.
 *
 * Returns a typed, UI-safe status (never raw Shopify errors, never a silent
 * success): `configured` reflects the real connection, `synced` is true only
 * when a set actually succeeded, and `reason` explains a batch-level stop.
 */
export async function pushStockToShopify(
  items: { sku: string; quantity: number }[],
): Promise<ShopifyStockSyncStatus & { message?: string }> {
  const unauth = await requireUser();
  if (unauth) {
    return { configured: false, synced: false, pushed: 0, failed: 0, missing: 0, reason: "not_configured", message: unauth.error };
  }
  const summary = await pushInventoryStockToShopify(items);
  return summarizeStockSync(summary);
}

export type MovementInput = {
  inventoryId: string;
  sku?: string | null;
  type: "in" | "out";
  quantity: string | number;
  reason?: string | null;
  note?: string | null;
  by?: string | null;
};

/**
 * Record a stock IN/OUT movement: updates inventory.stock_quantity and writes a
 * ledger row into malak_audit (action_type stock_in / stock_out). Atomic-ish
 * read-modify-write via the service-role client (server-only).
 */
export async function recordMovement(input: MovementInput) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  // Stock mutation + audit ledger live in the shared engine so the admin and
  // staff (/staff) entry points can never diverge.
  return applyMovement(writableClient(), input);
}

export type VariantMovementInput = {
  variantId: string;
  sku?: string | null;
  type: "in" | "out";
  quantity: string | number;
  reason?: string | null;
  note?: string | null;
  by?: string | null;
};

/**
 * Record a stock IN/OUT movement for a single VARIANT (option): applies the delta
 * to product_variants.stock_quantity, then re-totals the parent product's
 * inventory (= sum of its variants). Mirrors recordMovement but at variant grain,
 * keeping the parent pool consistent with the variants' independent stock.
 */
export async function recordVariantMovement(input: VariantMovementInput) {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = writableClient();
  const qty = Math.floor(Math.abs(Number(input.quantity)));
  if (!input.variantId || !qty || Number.isNaN(qty)) {
    return { error: "Pick a variant and a quantity greater than 0." };
  }
  if (input.type !== "in" && input.type !== "out") return { error: "Invalid movement type." };

  const { data: v, error: readErr } = await admin
    .from("product_variants")
    .select("id, stock_quantity, parent_product_id")
    .eq("id", input.variantId)
    .single();
  if (readErr || !v) return { error: "Variant not found." };

  const before = v.stock_quantity ?? 0;
  const delta = input.type === "in" ? qty : -qty;
  const after = before + delta;
  if (after < 0) {
    return { error: `Not enough stock: have ${before}, tried to remove ${qty}.` };
  }

  const { error: upErr } = await admin
    .from("product_variants")
    .update({ stock_quantity: after })
    .eq("id", v.id);
  if (upErr) return { error: upErr.message };

  // Re-total the parent product's inventory = sum of all its variants' stock.
  // (Bump sold_quantity on a sale, like recordMovement does.)
  const now = new Date().toISOString();
  const parentId = v.parent_product_id;
  if (parentId) {
    const { data: sibs } = await admin
      .from("product_variants")
      .select("stock_quantity")
      .eq("parent_product_id", parentId);
    const sum = ((sibs ?? []) as any[]).reduce((s, r) => s + (r.stock_quantity ?? 0), 0);
    const patch: Record<string, unknown> = { stock_quantity: sum, updated_at: now };
    if (input.type === "out" && (input.reason ?? "").toLowerCase() === "sale") {
      const { data: invRow } = await admin
        .from("inventory")
        .select("sold_quantity")
        .eq("product_id", parentId)
        .maybeSingle();
      patch.sold_quantity = ((invRow as any)?.sold_quantity ?? 0) + qty;
    }
    await admin.from("inventory").update(patch).eq("product_id", parentId);
  }

  // Best-effort ledger row (see note in recordMovement).
  const { error: logErr } = await insertAuditRow(admin, {
    agent: input.by || "inventory",
    action: input.type === "in" ? "stock_in" : "stock_out",
    action_type: input.type === "in" ? "stock_in" : "stock_out",
    sku: input.sku ?? null,
    product_id: parentId ?? null,
    field: "variant_stock_quantity",
    old_value: String(before),
    new_value: String(after),
    status: "done",
    details: {
      variantId: v.id,
      productId: parentId ?? null,
      quantity: qty,
      direction: input.type,
      reason: input.reason ?? null,
      note: input.note ?? null,
    },
  });
  if (logErr) console.error("[recordVariantMovement] audit insert failed:", logErr.message);

  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  revalidatePath("/dashboard");
  return { ok: true, before, after, logged: !logErr };
}

export type RecogCandidate = {
  inventoryId: string;
  sku: string | null;
  name: string | null;
  name_ar: string | null;
  barcode: string | null;
  stock: number;
  image_url: string | null;
};

/**
 * Visual product recognition: send a captured photo to Claude (vision), extract
 * brand / type / keywords, then search the catalog and return the closest
 * matching products for the user to confirm. Human-in-the-loop by design.
 */
export async function recognizeProduct(imageDataUrl: string): Promise<
  { error: string } | { guess: string; terms: string[]; candidates: RecogCandidate[] }
> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "AI vision isn’t configured on the server (ANTHROPIC_API_KEY missing)." };

  const m = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(imageDataUrl || "");
  if (!m) return { error: "Invalid image capture." };
  const media_type = m[1] as "image/png" | "image/jpeg" | "image/webp";
  const data = m[2];

  let guess = "";
  let tokens: string[] = [];
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system:
        "You identify retail beauty, skincare, cosmetics and home products from a photo, to search a store catalog. Reply with ONLY compact JSON, no prose.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type, data } },
            {
              type: "text",
              text:
                'Identify this product for catalog search. Return JSON exactly: {"brand": string, "type": string, "color": string, "keywords": string[], "guess_name": string}. keywords = 5-10 lowercase English words a catalog search would match: brand name, product type, and distinctive words/text visible on the packaging.',
            },
          ],
        },
      ],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    guess = String(json.guess_name ?? "");
    const raw: string[] = [
      ...(Array.isArray(json.keywords) ? json.keywords : []),
      json.brand,
      json.type,
    ].filter(Boolean);
    // tokenise to safe alphanumeric words for ilike search
    tokens = Array.from(
      new Set(
        raw
          .join(" ")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 3)
      )
    ).slice(0, 12);
  } catch (e: any) {
    return { error: `Vision request failed: ${e?.message ?? "unknown error"}` };
  }

  if (tokens.length === 0) return { guess, terms: [], candidates: [] };

  try {
  const admin = writableClient();
  const orExpr = tokens
    .flatMap((t) => [`name_en.ilike.%${t}%`, `keywords_en.ilike.%${t}%`])
    .join(",");
  const { data: prods } = await admin
    .from("products")
    .select("id, sku, name_en, name_ar, barcode, image_url, keywords_en")
    .or(orExpr)
    .limit(1000);

  const scored = ((prods ?? []) as any[])
    .map((p) => {
      const hay = `${p.name_en ?? ""} ${p.keywords_en ?? ""}`.toLowerCase();
      const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const ids = scored.map((x) => x.p.id);
  const invRes = ids.length
    ? await admin.from("inventory").select("id, stock_quantity, product_id").in("product_id", ids)
    : { data: [] as any[] };
  const inv = (invRes.data ?? []) as any[];
  const invByProd = new Map<any, any>(inv.map((r: any) => [r.product_id, r]));

  const candidates: RecogCandidate[] = scored
    .map(({ p }) => {
      const iv = invByProd.get(p.id);
      if (!iv) return null;
      return {
        inventoryId: iv.id,
        sku: p.sku ?? null,
        name: p.name_en ?? null,
        name_ar: p.name_ar ?? null,
        barcode: p.barcode ?? null,
        stock: iv.stock_quantity ?? 0,
        image_url: p.image_url ?? null,
      };
    })
    .filter((c): c is RecogCandidate => c !== null);

  return { guess, terms: tokens, candidates };
  } catch (e: any) {
    return { error: `Catalog search failed: ${e?.message ?? "unknown error"}` };
  }
}

/**
 * Mark a pasted list of product names as out of stock across platforms:
 *  - zeroes inventory.stock_quantity (and every variant's stock),
 *  - sets products.stock_status = "Out of Stock",
 *  - delists each linked sales channel (channel_status = "Not Listed"),
 *  - pushes quantity 0 to Shopify (best-effort).
 * Names are matched against sku / name_en / name_ar (case/punctuation-insensitive,
 * trailing "…" tolerated). Returns matched count, the unmatched lines, and the
 * Shopify push result so the UI can show exactly what happened.
 */
export async function markOutOfStockByNames(text: string, apply = false): Promise<{
  error?: string;
  applied: boolean;
  matched: number;
  products: { sku: string | null; name: string | null }[];
  unmatched: string[];
  shopify?: ShopifyStockSyncStatus & { message?: string };
}> {
  const unauth = await requireUser();
  if (unauth) return { error: (unauth as any).error ?? "Not signed in.", applied: false, matched: 0, products: [], unmatched: [] };

  const lines = [...new Set((text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
  if (lines.length === 0) return { applied: false, matched: 0, products: [], unmatched: [] };

  const admin = writableClient();

  // Load the whole catalog once for fuzzy name matching.
  const all: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await admin.from("products").select("id, sku, name_en, name_ar").range(f, f + 999);
    if (error) return { error: error.message, applied: false, matched: 0, products: [], unmatched: [] };
    all.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  // Loose key: keep only letters/digits (drops spaces, dashes – — -, &, (), …,
  // ², quotes) so "Bath Bombs Set – 6 Pieces" matches the catalog whatever the
  // punctuation. Latin + Arabic letters kept.
  const keyOf = (s: string) =>
    String(s ?? "").toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, "");
  // Significant words (≥3 chars) for the token-overlap fallback.
  const toks = (s: string) =>
    new Set(
      String(s ?? "").toLowerCase().replace(/[^a-z0-9؀-ۿ ]/g, " ").split(/\s+/).filter((w) => w.length >= 3)
    );
  // Variant-suffix stripper: drops parentheticals "(50ml)", size/unit tokens, and
  // trailing "– Gold" / "- Mint Green" style segments that are only colour/size
  // words — so a pasted "Smeg Thermal Tumbler – Gold" can still reach the catalog
  // "Smeg Thermal Tumbler" (where colour is a variant, not part of the name).
  const COLORS = new Set([
    "gold","silver","rose","pink","peach","mint","green","blue","red","black","white",
    "purple","beige","brown","gray","grey","ivory","cream","clear","nude","lavender",
    "yellow","orange","navy","teal","violet","coral","tan","khaki","champagne","bronze",
  ]);
  const variantWord = (w: string) =>
    COLORS.has(w) ||
    /^\d/.test(w) ||
    /^(ml|g|kg|l|cm|mm|pcs|pc|pieces?|pack|set|pro|max|models?|colou?rs?|size|sizes?|and|with|the|for)$/.test(w) ||
    w.length <= 2;
  const stripVariant = (s: string) => {
    const x = String(s ?? "").toLowerCase().replace(/\([^)]*\)/g, " ");
    const parts = x.split(/[–—-]/);
    while (parts.length > 1) {
      const tail = parts[parts.length - 1].trim().split(/\s+/).filter(Boolean);
      if (tail.length > 0 && tail.length <= 4 && tail.every(variantWord)) parts.pop();
      else break;
    }
    return parts.join(" ").replace(/\b\d+\s?(ml|g|kg|l|cm|mm|pcs|pc|pieces?)\b/g, " ");
  };
  const cat = all.map((p) => ({
    p,
    en: keyOf(p.name_en),
    ar: keyOf(p.name_ar),
    sku: keyOf(p.sku),
    t: toks(`${p.name_en ?? ""} ${p.name_ar ?? ""}`),
    cen: keyOf(stripVariant(p.name_en)),
    car: keyOf(stripVariant(p.name_ar)),
    ct: toks(`${stripVariant(p.name_en)} ${stripVariant(p.name_ar)}`),
  }));

  const ids = new Set<string>();
  const skus = new Set<string>();
  const matchedList: { sku: string | null; name: string | null }[] = [];
  const unmatched: string[] = [];
  const take = (c: (typeof cat)[number]) => {
    if (!ids.has(c.p.id)) matchedList.push({ sku: c.p.sku ?? null, name: c.p.name_en ?? c.p.name_ar ?? null });
    ids.add(c.p.id);
    if (c.p.sku) skus.add(String(c.p.sku));
  };
  for (const line of lines) {
    const ln = keyOf(line.replace(/[.…]+$/, ""));
    if (ln.length < 5) { unmatched.push(line); continue; }
    // 1) SKU equality, or either-direction containment of the name key
    //    (handles "Name – 6 Pieces" in paste vs "Name" in catalog and vice-versa).
    const hits = cat.filter(
      (c) =>
        (c.sku && c.sku === ln) ||
        (c.en.length >= 6 && (c.en.includes(ln) || ln.includes(c.en))) ||
        (c.ar.length >= 6 && (c.ar.includes(ln) || ln.includes(c.ar)))
    );
    if (hits.length > 0) { for (const h of hits) take(h); continue; }

    // 2) Fallback: token overlap — catches re-ordered / slightly reworded names.
    //    Pick the single best product by share of the line's words it covers,
    //    but only if it clears a high bar AND clearly beats the runner-up (so
    //    near-duplicates like "… Pink" vs "… Peach" don't cross-match).
    const lt = [...toks(line)];
    if (lt.length >= 4) {
      let best: (typeof cat)[number] | null = null;
      let bestScore = 0;
      let second = 0;
      for (const c of cat) {
        if (c.t.size === 0) continue;
        let m = 0;
        for (const w of lt) if (c.t.has(w)) m++;
        const score = m / lt.length;
        if (score > bestScore) { second = bestScore; bestScore = score; best = c; }
        else if (score > second) second = score;
      }
      if (best && bestScore >= 0.75 && bestScore - second >= 0.08) { take(best); continue; }
    }

    // 3) Colour/size-tolerant retry: strip the variant suffix from both sides and
    //    re-run containment + a (stricter-margin) token overlap. Lets "… – Gold"
    //    or "… (50ml)" reach a catalog product whose name omits the variant.
    const cl = keyOf(stripVariant(line.replace(/[.…]+$/, "")));
    if (cl.length >= 6) {
      const chits = cat.filter(
        (c) =>
          (c.cen.length >= 6 && (c.cen.includes(cl) || cl.includes(c.cen))) ||
          (c.car.length >= 6 && (c.car.includes(cl) || cl.includes(c.car)))
      );
      if (chits.length > 0) { for (const h of chits) take(h); continue; }

      const clt = [...toks(stripVariant(line))];
      if (clt.length >= 3) {
        let best: (typeof cat)[number] | null = null;
        let bestScore = 0;
        let second = 0;
        for (const c of cat) {
          if (c.ct.size === 0) continue;
          let m = 0;
          for (const w of clt) if (c.ct.has(w)) m++;
          const score = m / clt.length;
          if (score > bestScore) { second = bestScore; bestScore = score; best = c; }
          else if (score > second) second = score;
        }
        if (best && bestScore >= 0.8 && bestScore - second >= 0.12) { take(best); continue; }
      }
    }
    unmatched.push(line);
  }

  const idList = [...ids];

  // Dry run: report what WOULD be marked, write nothing. The UI shows this for
  // review and only calls again with apply=true after the user approves.
  if (!apply) {
    return { applied: false, matched: idList.length, products: matchedList, unmatched };
  }

  const now = new Date().toISOString();
  for (let i = 0; i < idList.length; i += 200) {
    const chunk = idList.slice(i, i + 200);
    await admin.from("inventory").update({ stock_quantity: 0, updated_at: now }).in("product_id", chunk);
    await admin.from("product_variants").update({ stock_quantity: 0 }).in("parent_product_id", chunk);
    await admin.from("products").update({ stock_status: "Out of Stock" }).in("id", chunk);
    await admin.from("channel_products").update({ channel_status: "Not Listed" }).in("product_id", chunk);
  }

  // Best-effort external sync: push 0 stock to Shopify for every matched SKU.
  // The local DB writes above stand on their own — a Shopify hiccup never rolls
  // them back; the returned status lets the UI say whether the store synced too.
  let shopify: (ShopifyStockSyncStatus & { message?: string }) | undefined;
  if (skus.size > 0) {
    shopify = await pushStockToShopify([...skus].map((sku) => ({ sku, quantity: 0 })));
  }

  revalidatePath("/inventory");
  revalidatePath("/inventory/out-of-stock");
  revalidatePath("/products");
  return { applied: true, matched: idList.length, products: matchedList, unmatched, shopify };
}

/**
 * Match every sales channel (Snoonu/Pure Seoul, Talabat, Shopify, Rafeeq) to the
 * Malika's catalog for products that are SOLD OUT: any product whose shared stock
 * pool is 0 but is still "Active" on a channel gets delisted (channel_status →
 * "Not Listed"), and 0 stock is re-pushed to Shopify. Malika's (the catalog) is
 * the source of truth. apply=false is a dry run that only reports the mismatch.
 */
export async function matchChannelsToMalika(apply = false): Promise<{
  error?: string;
  applied: boolean;
  products: { sku: string | null; name: string | null; channels: string[] }[];
  channelRows: number;
  shopify?: ShopifyStockSyncStatus & { message?: string };
}> {
  const unauth = await requireUser();
  if (unauth) return { error: (unauth as any).error ?? "Not signed in.", applied: false, products: [], channelRows: 0 };

  const admin = writableClient();
  const PAGE = 1000;

  // Sum variant stock per parent — a product is "out" only when every option is out.
  const variantSum = new Map<string, number>();
  {
    const probe = await admin.from("product_variants").select("id").limit(1);
    if (!probe.error) {
      for (const v of await fetchAll(admin, "product_variants", "parent_product_id, stock_quantity") as any[]) {
        if (!v.parent_product_id) continue;
        variantSum.set(v.parent_product_id, (variantSum.get(v.parent_product_id) ?? 0) + (v.stock_quantity ?? 0));
      }
    }
  }

  // Out-of-stock product ids: max(inventory total, summed variant stock) <= 0.
  const oos = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from("inventory").select("product_id, stock_quantity").range(from, from + PAGE - 1);
    if (error) return { error: error.message, applied: false, products: [], channelRows: 0 };
    for (const r of (data ?? []) as any[]) {
      if (!r.product_id) continue;
      const effective = Math.max(r.stock_quantity ?? 0, variantSum.get(r.product_id) ?? 0);
      if (effective <= 0) oos.add(r.product_id);
    }
    if (!data || data.length < PAGE) break;
  }

  // Channel id → name.
  const { data: chans } = await admin.from("channels").select("id, name");
  const chanName = new Map<string, string>(((chans ?? []) as any[]).map((c) => [c.id, c.name]));

  // Out-of-stock products still "Active" on a channel = the mismatch to fix.
  const activeChannelsByProduct = new Map<string, Set<string>>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from("channel_products").select("product_id, channel_id, channel_status").range(from, from + PAGE - 1);
    if (error) return { error: error.message, applied: false, products: [], channelRows: 0 };
    for (const r of (data ?? []) as any[]) {
      if ((r.channel_status ?? "") !== "Active") continue;
      if (!oos.has(r.product_id)) continue;
      const nm = chanName.get(r.channel_id);
      if (!nm) continue;
      const set = activeChannelsByProduct.get(r.product_id) ?? new Set<string>();
      set.add(nm);
      activeChannelsByProduct.set(r.product_id, set);
    }
    if (!data || data.length < PAGE) break;
  }

  const productIds = [...activeChannelsByProduct.keys()];
  const channelRows = [...activeChannelsByProduct.values()].reduce((n, s) => n + s.size, 0);

  // Names/SKUs for the preview + Shopify push.
  const meta = new Map<string, { sku: string | null; name: string | null }>();
  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200);
    const { data } = await admin.from("products").select("id, sku, name_en, name_ar").in("id", chunk);
    for (const p of (data ?? []) as any[]) meta.set(p.id, { sku: p.sku ?? null, name: p.name_en ?? p.name_ar ?? null });
  }
  const products = productIds
    .map((id) => ({ sku: meta.get(id)?.sku ?? null, name: meta.get(id)?.name ?? null, channels: [...(activeChannelsByProduct.get(id) ?? [])].sort() }))
    .sort((a, b) => (a.name ?? a.sku ?? "").localeCompare(b.name ?? b.sku ?? ""));

  // Dry run: report the mismatch, write nothing.
  if (!apply) return { applied: false, products, channelRows };

  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200);
    await admin.from("channel_products").update({ channel_status: "Not Listed" }).in("product_id", chunk).eq("channel_status", "Active");
  }

  // Best-effort external sync: re-push 0 stock to Shopify for the affected SKUs.
  // The channel delisting above is committed regardless of the Shopify outcome.
  let shopify: (ShopifyStockSyncStatus & { message?: string }) | undefined;
  const skus = products.map((p) => p.sku).filter((s): s is string => !!s);
  if (skus.length > 0) {
    shopify = await pushStockToShopify(skus.map((sku) => ({ sku, quantity: 0 })));
  }

  revalidatePath("/inventory");
  revalidatePath("/inventory/out-of-stock");
  revalidatePath("/channels");
  return { applied: true, products, channelRows, shopify };
}

// ── System-wide inventory mode (quantities ↔ simple in/out of stock) ──────────

/** Read the current inventory mode (server component / client refresh). */
export async function readInventoryMode(): Promise<InventoryMode> {
  return getInventoryMode();
}

/** Flip the whole system between quantity tracking and simple availability. */
export async function switchInventoryMode(mode: InventoryMode): Promise<{ ok: boolean; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { ok: false, error: unauth.error };
  const res = await setInventoryMode(mode === "simple" ? "simple" : "quantities");
  if (!res.ok) return res;
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  revalidatePath("/products");
  return { ok: true };
}

/**
 * Simple-mode toggle: mark a product In-stock / Out-of-stock without touching a
 * number. Out → stock 0; In → keep the existing quantity if it's already
 * positive, else set it to 1. Fires the same OOS/restock catalog task as a
 * normal movement so the platforms checklist still flows.
 */
export async function setProductAvailability(
  inventoryId: string,
  inStock: boolean
): Promise<{ ok: boolean; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { ok: false, error: unauth.error };
  const admin = writableClient();
  const { data: row, error: readErr } = await admin
    .from("inventory")
    .select("id, product_id, stock_quantity")
    .eq("id", inventoryId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: "الصنف غير موجود." };

  const before = Number((row as any).stock_quantity) || 0;
  const after = inStock ? (before > 0 ? before : 1) : 0;
  if (after === before) return { ok: true };

  const { error } = await admin
    .from("inventory")
    .update({ stock_quantity: after, updated_at: new Date().toISOString() })
    .eq("id", inventoryId);
  if (error) return { ok: false, error: error.message };

  await logStockTransition(admin, {
    productId: (row as any).product_id,
    before,
    after,
    actor: "مدير — متوفر/نفذ",
  });

  revalidatePath("/inventory");
  revalidatePath("/inventory/out-of-stock");
  revalidatePath("/dashboard");
  return { ok: true };
}

/** Bulk simple-mode toggle: mark many products In / Out at once (select-all). */
export async function setManyAvailability(
  inventoryIds: string[],
  inStock: boolean
): Promise<{ ok: boolean; count: number; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { ok: false, count: 0, error: unauth.error };
  const admin = writableClient();
  const ids = Array.from(new Set((inventoryIds ?? []).map((s) => String(s)).filter(Boolean)));
  if (ids.length === 0) return { ok: true, count: 0 };
  const now = new Date().toISOString();
  let count = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    // Out → 0 for all. In → 1 only where it's currently 0/empty (keep real counts).
    let q = admin.from("inventory").update({ stock_quantity: inStock ? 1 : 0, updated_at: now }).in("id", chunk);
    if (inStock) q = q.lte("stock_quantity", 0);
    const { error } = await q;
    if (error) return { ok: false, count, error: error.message };
    count += chunk.length;
  }
  revalidatePath("/inventory");
  revalidatePath("/inventory/out-of-stock");
  revalidatePath("/products");
  revalidatePath("/dashboard");
  return { ok: true, count };
}

/** Simple-mode toggle for ONE option (variant): In / Out without a quantity. */
export async function setVariantAvailability(
  variantId: string,
  inStock: boolean
): Promise<{ ok: boolean; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { ok: false, error: unauth.error };
  const admin = writableClient();
  const { data: v, error: readErr } = await admin
    .from("product_variants")
    .select("id, parent_product_id, variant_name, stock_quantity")
    .eq("id", String(variantId))
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!v) return { ok: false, error: "الخيار غير موجود." };

  const before = Number((v as any).stock_quantity) || 0;
  const after = inStock ? (before > 0 ? before : 1) : 0;
  if (after === before) return { ok: true };
  const { error } = await admin
    .from("product_variants")
    .update({ stock_quantity: after })
    .eq("id", String(variantId));
  if (error) return { ok: false, error: error.message };

  await logVariantStockTransition(admin, {
    productId: (v as any).parent_product_id,
    variantId: String(variantId),
    variantName: (v as any).variant_name ?? "",
    before,
    after,
    actor: "مدير — متوفر/نفذ",
  });
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok: true };
}
