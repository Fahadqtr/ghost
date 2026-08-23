"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyMovement } from "@/lib/inventory/movements";
// INV.4A — product-grain stock writes go through the Inventory Engine (atomic
// RPC), never a direct inventory.stock_quantity write.
import {
  setAbsolute, setVariantAbsolute, adjustVariantMovement,
  placeOnShelf, removeShelf, replaceShelfDistribution, assignFullShelf, moveShelf,
  type EngineResult, type ShelfRow,
} from "@/lib/inventory/engine";
import {
  logStockTransition, logAuthoritativeVariantTransition, logAuthoritativeStockTransition,
} from "@/lib/inventory/transition";
// SEC.INV.1 — mutations are writer/owner-gated; requireUser remains only for
// non-mutating helpers (recognizeProduct). Gates keep requireUser's contract.
import { requireUser, requireWriterGate, requireOwnerGate } from "@/lib/auth/requireUser";
import { insertAuditRow } from "@/lib/audit";
import { getInventoryMode, setInventoryMode, type InventoryMode } from "@/lib/settings";
import { pushInventoryStockToShopify } from "@/lib/shopify/admin";
import { summarizeStockSync, type ShopifyStockSyncStatus } from "@/lib/shopify/stock-push";
import { setProductAvailabilityState, writeProductAvailability, setVariantAvailabilityState } from "@/lib/availability/engine";
import { availabilityFromInStock, isAvailable } from "@/lib/availability/read";
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

// INV.4A — map an Inventory Engine failure to a clear operator message. The
// product-grain RPC deliberately rejects variant / shelf-tracked products
// (those grains move in INV.4B / INV.4C), so those reasons get a helpful hint.
function stockEngineMessage(r: Extract<EngineResult, { ok: false }>): string {
  switch (r.reason) {
    case "product_has_variants":
      return "هذا المنتج له خيارات (variants) — تُعدَّل كمية كل خيار على حدة، لا الإجمالي.";
    case "product_has_shelf_rows":
      return "هذا المنتج موزّع على رفوف — استخدم جرد الرفوف لتعديل الكمية.";
    case "invalid_quantity":
      return "كمية غير صالحة (لازم رقم صحيح ≥ 0).";
    case "missing_inventory":
      return "صف المخزون غير موجود.";
    case "inventory_inconsistent":
      return "حالة المخزون غير متسقة — راجع المنتج.";
    default:
      return "تعذّر تحديث المخزون.";
  }
}

// INV.4B — map a VARIANT Inventory Engine failure (inv_adjust_variant_movement /
// inv_set_variant_absolute) to a clear operator message. Shelf-tracked variants
// (and variant products carrying a product-level shelf) are rejected fail-closed —
// their quantity is managed from the shelves (INV.4C), never a bare stock write.
function variantStockEngineMessage(r: Extract<EngineResult, { ok: false }>): string {
  switch (r.reason) {
    case "variant_has_shelf_rows":
      return "هذا الخيار مُدار من الرفوف — استخدم جرد رفوف الخيار (shelf) لتعديل كميته.";
    case "parent_has_shelf_rows":
      return "المنتج موزّع على رفوف — استخدم جرد الرفوف لتعديل الكمية.";
    case "insufficient_stock":
      return "الكمية المطلوب إخراجها أكبر من مخزون الخيار المتاح.";
    case "missing_variant":
      return "الخيار غير موجود.";
    case "missing_parent":
      return "الخيار غير مرتبط بمنتج.";
    case "invalid_quantity":
    case "invalid_delta":
      return "كمية غير صالحة (لازم رقم صحيح ≥ 0).";
    case "sold_delta_mismatch":
      return "خلل في احتساب المبيعات مع الحركة — أعد المحاولة.";
    case "sold_inconsistent":
      return "حالة مبيعات المنتج غير متسقة — راجع المنتج.";
    case "inventory_inconsistent":
      return "حالة المخزون غير متسقة — راجع المنتج.";
    default:
      return "تعذّر تحديث مخزون الخيار.";
  }
}

// INV.4C — map a shelf Inventory Engine failure to a clear operator message.
function shelfEngineMessage(r: Extract<EngineResult, { ok: false }>): string {
  switch (r.reason) {
    case "product_has_variants":
      return "هذا المنتج له خيارات (variants) — تُدار رفوف كل خيار على حدة.";
    case "parent_has_shelf_rows":
      return "حالة رفوف غير متوقعة على المنتج الأب — راجع المنتج.";
    case "missing_inventory":
      return "صف المخزون غير موجود.";
    case "missing_variant":
      return "الخيار غير موجود.";
    case "placement_not_found":
      return "لا يوجد مخزون في هذا الرف لنقله.";
    case "invalid_location":
      return "رمز الرف غير صالح.";
    case "same_location":
      return "الرف المصدر والهدف متطابقان.";
    case "invalid_quantity":
    case "invalid_rows":
      return "كمية أو توزيع رفوف غير صالح.";
    case "overflow":
      return "الكمية كبيرة جدًا.";
    case "inventory_inconsistent":
      return "حالة المخزون غير متسقة — راجع المنتج.";
    default:
      return "تعذّر تحديث الرفوف.";
  }
}

// Build a normalized, positive-only shelf distribution for the RPC. The RPC is the
// final validator/merger; this keeps the existing user-facing normalization (upper,
// merge duplicates, drop empty/zero). An empty result means "explicit UNTRACK".
function normalizeShelfRows(rows: { location: string; quantity: number }[]): ShelfRow[] {
  const merged = new Map<string, number>();
  for (const r of rows ?? []) {
    const code = (r.location ?? "").trim().toUpperCase();
    const q = Math.max(0, Math.floor(Number(r.quantity) || 0));
    if (!code || q <= 0) continue;
    merged.set(code, (merged.get(code) ?? 0) + q);
  }
  return Array.from(merged.entries()).map(([location, quantity]) => ({ location, quantity }));
}

// INV.4A — after a successful engine.setAbsolute: best-effort audit + zero-crossing
// transition. Both are best-effort and never undo the stock write (which already
// succeeded atomically in the RPC). Uses the engine's real before/after/productId.
async function afterStockSet(
  admin: any,
  res: Extract<EngineResult, { ok: true }>,
  ctx: { action: string; actor?: string; sku?: string | null; details?: Record<string, unknown> },
): Promise<void> {
  const before = Number(res.data.before);
  const after = Number(res.data.after);
  const productId = (res.data.productId as string | null) ?? null;
  try {
    await insertAuditRow(admin, {
      agent: ctx.actor ?? "inventory",
      action: ctx.action,
      action_type: ctx.action,
      sku: ctx.sku ?? null,
      product_id: productId,
      field: "stock_quantity",
      old_value: String(before),
      new_value: String(after),
      status: "done",
      details: { productId, before, after, ...(ctx.details ?? {}) },
    });
  } catch (e) {
    console.error("[inv4a audit]", e instanceof Error ? e.message : e);
  }
  await logStockTransition(admin, { productId, before, after, actor: ctx.actor });
}

/** Single-row inline save (kept for backward compatibility). */
export async function updateInventory(
  id: string,
  values: { stock_quantity: string; low_stock_threshold: string }
) {
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  if (!id) return { error: "Missing inventory row." };
  const admin = writableClient();

  // Stock quantity (when provided) goes through the Inventory Engine — never a
  // direct inventory.stock_quantity write. Blank/null/negative/fractional is a
  // hard error, never a silent write.
  const rawStock = values.stock_quantity;
  if (rawStock !== undefined && String(rawStock).trim() !== "") {
    const stock = toNum(rawStock);
    if (stock === null || !Number.isInteger(stock) || stock < 0) {
      return { error: "كمية مخزون غير صالحة (لازم رقم صحيح ≥ 0)." };
    }
    const res = await setAbsolute(admin, id, stock);
    if (!res.ok) return { error: stockEngineMessage(res) };
    await afterStockSet(admin, res, { action: "stock_set", sku: await skuForInventory(admin, id), details: { via: "manual" } });
  }

  // low_stock_threshold is NOT a quantity mutation — update it independently
  // (only when provided) without ever touching stock_quantity.
  if (values.low_stock_threshold !== undefined && String(values.low_stock_threshold).trim() !== "") {
    const { error } = await admin
      .from("inventory")
      .update({ low_stock_threshold: toNum(values.low_stock_threshold), updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { error: error.message };
  }

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
  const unauth = await requireOwnerGate();
  if (unauth) return { ok: 0, failed: updates.length, errors: [unauth.error] };
  const admin = writableClient();
  const now = new Date().toISOString();
  let ok = 0;
  const errors: string[] = [];

  for (const u of updates) {
    if (!u.id) { errors.push("missing row id"); continue; }
    // Stock quantity (when provided) → Inventory Engine, per row, atomically.
    if (u.stock_quantity !== undefined && String(u.stock_quantity).trim() !== "") {
      const stock = toNum(u.stock_quantity);
      if (stock === null || !Number.isInteger(stock) || stock < 0) { errors.push(`${u.id}: كمية غير صالحة`); continue; }
      const res = await setAbsolute(admin, u.id, stock);
      if (!res.ok) { errors.push(`${u.id}: ${stockEngineMessage(res)}`); continue; }
      await afterStockSet(admin, res, { action: "stock_set", sku: await skuForInventory(admin, u.id), details: { via: "bulk" } });
    }
    // Threshold-only path (never touches stock_quantity).
    if (u.low_stock_threshold !== undefined && String(u.low_stock_threshold).trim() !== "") {
      const { error } = await admin.from("inventory").update({ low_stock_threshold: toNum(u.low_stock_threshold), updated_at: now }).eq("id", u.id);
      if (error) { errors.push(`${u.id}: ${error.message}`); continue; }
    }
    ok++;
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
  const unauth = await requireWriterGate();
  if (unauth) return { ok: 0, failed: counts.length, errors: [unauth.error] };
  const admin = writableClient();
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

    // Stock quantity → Inventory Engine (atomic; rejects variant / shelf-tracked
    // products fail-closed — those grains move in INV.4B / INV.4C).
    const res = await setAbsolute(admin, c.inventoryId, counted);
    if (!res.ok) {
      errors.push(`${c.sku ?? c.inventoryId}: ${stockEngineMessage(res)}`);
      continue;
    }
    const before = Number(res.data.before);
    const after = Number(res.data.after);
    const productId = (res.data.productId as string | null) ?? null;

    // SINGLE stocktake audit (variance) using the engine's real before/after —
    // recorded only on an actual change (mirrors the prior no-op-skip behavior).
    if (after !== before) {
      try {
        await insertAuditRow(admin, {
          agent: "stocktake",
          action: "stocktake",
          action_type: "stocktake",
          sku: c.sku ?? null,
          product_id: productId,
          field: "stock_quantity",
          old_value: String(before),
          new_value: String(after),
          status: "done",
          details: { productId, counted: after, previous: before, variance: after - before },
        });
      } catch (e) {
        console.error("[stocktake audit]", e instanceof Error ? e.message : e);
      }
      // Zero-crossing transition (best-effort).
      await logStockTransition(admin, { productId, before, after });
    }

    // Location is a SEPARATE path — INV.4C routes it through the shelf Engine
    // instead of a direct inventory.location write. The stock write already
    // succeeded (setAbsolute only accepts a non-shelf, non-variant product), so a
    // location failure is a PARTIAL failure and never rolls the stock back.
    const newLoc = c.location != null ? c.location.trim().toUpperCase() : null;
    if (newLoc != null) {
      // Place the whole (just-set) stock at the slot atomically (quantity read
      // under lock). No direct inventory.location / shelf write.
      const asg = await assignFullShelf(admin, { scope: "product", targetId: c.inventoryId, location: newLoc, quantity: null });
      if (!asg.ok) {
        errors.push(`${c.sku ?? c.inventoryId}: تم تحديث الكمية لكن فشل حفظ الموقع (${shelfEngineMessage(asg)})`);
        continue;
      }
    }
    ok++;
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
  const unauth = await requireWriterGate();
  if (unauth) return { ok: 0, failed: counts.length, errors: [unauth.error] };
  const admin = writableClient();
  let ok = 0;
  const errors: string[] = [];

  for (const c of counts) {
    const rawCounted = Number(c.counted);
    if (!c.variantId || Number.isNaN(rawCounted)) {
      errors.push(`${c.sku ?? c.variantId}: invalid count`);
      continue;
    }
    const counted = Math.max(0, Math.floor(rawCounted));

    // Variant stock + parent rollup → Inventory Engine (atomic). Shelf-tracked
    // variants (and variant products with a product-level shelf) are rejected
    // fail-closed by the RPC — no direct product_variants write, no manual parent
    // sibling re-total here. The RPC owns the rollup.
    const res = await setVariantAbsolute(admin, c.variantId, counted);
    if (!res.ok) {
      errors.push(`${c.sku ?? c.variantId}: ${variantStockEngineMessage(res)}`);
      continue;
    }
    const before = Number(res.data.before);
    const after = Number(res.data.after);
    const parentStock = Number(res.data.parentStock);
    const parentBefore = Number(res.data.parentBefore);
    const productId = (res.data.parentProductId as string | null) ?? null;

    // SINGLE stocktake audit per variant that actually changed (no double audit,
    // no audit on a no-op), old/new from the engine's real before/after.
    if (after !== before) {
      try {
        await insertAuditRow(admin, {
          agent: "stocktake",
          action: "stocktake",
          action_type: "stocktake",
          sku: c.sku ?? null,
          product_id: productId,
          field: "variant_stock_quantity",
          old_value: String(before),
          new_value: String(after),
          status: "done",
          details: { variantId: c.variantId, productId, counted: after, previous: before, variance: after - before },
        });
      } catch (e) {
        console.error("[variant stocktake audit]", e instanceof Error ? e.message : e);
      }
      // Authoritative zero-crossing transition (best-effort) using the engine's
      // parentBefore/parentStock — never the double-counting totalStock helper.
      await logAuthoritativeVariantTransition(admin, {
        productId,
        variantId: c.variantId,
        variantName: "خيار",
        variantBefore: before,
        variantAfter: after,
        parentBefore,
        parentAfter: parentStock,
      });
    }
    ok++;
  }

  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok, failed: errors.length, errors: errors.slice(0, 5) };
}

// ── Shelf / bin locations ──────────────────────────────────────────────────

/** Set (or clear) a product's physical shelf location, e.g. "A1". */
export async function setLocation(inventoryId: string, location: string) {
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  if (!inventoryId) return { error: "Missing inventory row." };
  const admin = writableClient();
  const value = location.trim().toUpperCase() || null; // null → explicit UNTRACK

  // Read-only metadata for the audit (old location + sku). NOT used to compute the
  // mutation — the RPC reads the authoritative stock under its own lock.
  const { data: prev } = await admin.from("inventory").select("location, products(sku)").eq("id", inventoryId).single();

  // Valid slot → place the whole current stock at that slot (atomic; stock read
  // under lock inside the RPC). Empty → explicit UNTRACK (clear shelf rows,
  // location=null, PRESERVE stock). No direct inventory.location / shelf write.
  const res = await assignFullShelf(admin, { scope: "product", targetId: inventoryId, location: value, quantity: null });
  if (!res.ok) return { error: shelfEngineMessage(res) };

  await logAudit(admin, {
    action: "shelf_move",
    sku: (prev as any)?.products?.sku ?? null,
    field: "location",
    oldVal: (prev as any)?.location ?? null,
    newVal: (res.data.primaryLocation as string | null) ?? null,
    details: { inventoryId, untracked: res.data.untracked === true },
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
  const unauth = await requireWriterGate();
  if (unauth) return { ok: 0, failed: counts.length, errors: [unauth.error] };
  const admin = writableClient();
  const slot = (location ?? "").trim().toUpperCase();
  if (!slot) return { ok: 0, failed: counts.length, errors: ["No shelf selected."] };
  let ok = 0;
  const errors: string[] = [];
  for (const c of counts) {
    if (!c.inventoryId) { errors.push("missing row"); continue; }
    const qty = Math.max(0, Math.floor(Number(c.counted) || 0));
    // Each count is an atomic single-slot placement (type A distribution edit):
    // the RPC sets/removes the slot and re-derives stock = Σ shelves + primary.
    // No direct shelf_stock upsert/delete, no manual master re-total.
    const res = await placeOnShelf(admin, { scope: "product", targetId: c.inventoryId, location: slot, quantity: qty });
    if (!res.ok) { errors.push(shelfEngineMessage(res)); continue; }
    const before = Number(res.data.stockBefore);
    const after = Number(res.data.stock);
    if (before !== after) {
      await logAuthoritativeStockTransition(admin, { productId: (res.data.productId as string | null) ?? null, before, after });
    }
    ok++;
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
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  if (!variantId) return { error: "Missing variant." };
  const admin = writableClient();

  // Replace the whole variant distribution atomically (variant stock = Σ rows,
  // parent = Σ variants). Empty rows = explicit UNTRACK (drop overlay, preserve
  // variant stock). No direct variant_shelf_stock / product_variants / inventory
  // write, no sibling sum. The RPC owns the rollup.
  const clean = normalizeShelfRows(rows);
  const res = await replaceShelfDistribution(admin, { scope: "variant", targetId: variantId, rows: clean });
  if (!res.ok) return { error: variantStockEngineMessage(res) };

  // Authoritative variant zero-crossing transition (best-effort) on a real change.
  const before = Number(res.data.variantBefore);
  const after = Number(res.data.variantStock);
  if (before !== after) {
    await logAuthoritativeVariantTransition(admin, {
      productId: (res.data.parentProductId as string | null) ?? null,
      variantId,
      variantName: "خيار",
      variantBefore: before,
      variantAfter: after,
      parentBefore: Number(res.data.parentBefore),
      parentAfter: Number(res.data.parentStock),
    });
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
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  if (!inventoryId) return { error: "Missing inventory row." };
  const admin = writableClient();

  // Replace the product's placements wholesale (atomic): stock = Σ rows, location =
  // primary. An empty distribution = explicit UNTRACK (drop overlay, location=null,
  // PRESERVE stock). No direct shelf_stock / inventory write in JS — the RPC owns it.
  const clean = normalizeShelfRows(rows);
  const res = await replaceShelfDistribution(admin, { scope: "product", targetId: inventoryId, rows: clean });
  if (!res.ok) return { error: shelfEngineMessage(res) };

  await logAudit(admin, {
    action: "shelf_assign",
    sku: await skuForInventory(admin, inventoryId),
    field: "location",
    oldVal: null,
    newVal: clean.map((c) => `${c.location}×${c.quantity}`).join(", ") || null,
    details: { inventoryId, placements: clean, primaryLocation: (res.data.primaryLocation as string | null) ?? null, untracked: res.data.untracked === true },
  });

  // Authoritative product zero-crossing transition (best-effort) on a real change.
  const before = Number(res.data.stockBefore);
  const after = Number(res.data.stock);
  if (before !== after) {
    await logAuthoritativeStockTransition(admin, { productId: (res.data.productId as string | null) ?? null, before, after });
  }

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
  const unauth = await requireWriterGate();
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
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  if (!parentProductId) return { error: "Missing product." };
  const admin = writableClient();
  for (const r of rows) {
    const bc = r.barcode && r.barcode.trim() !== "" ? r.barcode.trim() : null;
    const name = r.variant_name && r.variant_name.trim() !== "" ? r.variant_name.trim() : null;
    if (r.id) {
      // Metadata-only update (name / barcode) — never stock. Safe here.
      const { error } = await admin
        .from("product_variants")
        .update({ variant_name: name, barcode: bc })
        .eq("id", r.id);
      if (error) return { error: error.message };
    } else {
      // Skip empty new rows (no name and no barcode).
      if (!name && !bc) continue;
      // INV.6A — adding a NEW option is a STRUCTURAL change to the product's stock
      // authority: it converts the parent's rollup and could strand a simple
      // product's stock. It is NOT allowed through this metadata path. Require the
      // full product editor, whose atomic sync_product_variants recomputes the
      // parent rollup (inventory.stock = Σ variants) in one transaction.
      return { error: "لإضافة خيار جديد استخدم محرّر المنتج الكامل — لا يمكن إضافته من هنا." };
    }
  }
  revalidatePath("/catalog/health");
  revalidatePath("/inventory");
  return { ok: true };
}

/** Remove a product from a single shelf slot (type A distribution edit). */
export async function removeFromShelf(inventoryId: string, location: string): Promise<{ error: string } | { ok: true }> {
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  const slot = (location ?? "").trim().toUpperCase();
  if (!inventoryId || !slot) return { error: "Missing inventory row or slot." };
  const admin = writableClient();

  // Drop the slot and re-derive stock from Σ remaining shelves (atomic). No direct
  // shelf delete, no JS resync. This is a distribution edit: removing the last
  // placement re-derives stock to 0 (use setLocation("") to UNTRACK + preserve).
  const res = await removeShelf(admin, { scope: "product", targetId: inventoryId, location: slot });
  if (!res.ok) return { error: shelfEngineMessage(res) };

  await logAudit(admin, {
    action: "shelf_remove",
    sku: await skuForInventory(admin, inventoryId),
    field: "location",
    oldVal: slot,
    newVal: (res.data.primaryLocation as string | null) ?? null,
    details: { inventoryId },
  });

  const before = Number(res.data.stockBefore);
  const after = Number(res.data.stock);
  if (before !== after) {
    await logAuthoritativeStockTransition(admin, { productId: (res.data.productId as string | null) ?? null, before, after });
  }
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  revalidatePath("/inventory/movements");
  return { ok: true };
}

/** Move a product's placement from one slot to another (merges if the target
 *  already holds units of the same product). Total stock is invariant. */
export async function moveShelfStock(inventoryId: string, fromLocation: string, toLocation: string): Promise<{ error: string } | { ok: true }> {
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  const from = (fromLocation ?? "").trim().toUpperCase();
  const to = (toLocation ?? "").trim().toUpperCase();
  if (!inventoryId || !from || !to) return { error: "Missing inventory row or slot." };
  if (from === to) return { ok: true };
  const admin = writableClient();

  // Atomic move (merge if `to` exists); the RPC keeps total stock invariant and
  // recomputes the primary. No JS read + delete/upsert sequence.
  const res = await moveShelf(admin, { scope: "product", targetId: inventoryId, fromLocation: from, toLocation: to });
  if (!res.ok) return { error: shelfEngineMessage(res) };

  await logAudit(admin, {
    action: "shelf_move",
    sku: await skuForInventory(admin, inventoryId),
    field: "location",
    oldVal: from,
    newVal: to,
    details: { inventoryId, quantity: Number(res.data.quantity) || 0 },
  });
  // Total stock does not change on a move → no zero-crossing transition.
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
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  const slot = (location ?? "").trim().toUpperCase();
  const ids = (inventoryIds ?? []).filter(Boolean);
  if (!slot || ids.length === 0) return { error: "اختر رفّاً ومنتجاً واحداً على الأقل." };
  // When provided, the placed quantity is forced to this value (and the row's
  // total stock is updated to match) — lets "set qty + assign shelf" be one step.
  const forced = setQty == null ? null : Math.max(0, Math.floor(setQty));
  const admin = writableClient();

  let done = 0;
  const errors: string[] = [];
  for (const id of ids) {
    // Read-only metadata (sku + old location) for the audit only.
    const { data: inv } = await admin
      .from("inventory")
      .select("location, products(sku)")
      .eq("id", id)
      .single();
    const before = (inv as any)?.location ?? null;

    // Put the full stock (forced null → current stock read under lock) at the slot,
    // atomically (stock + shelf + primary). No JS current-stock read for the
    // mutation, no direct shelf/inventory writes.
    const res = await assignFullShelf(admin, { scope: "product", targetId: id, location: slot, quantity: forced });
    if (!res.ok) { errors.push(shelfEngineMessage(res)); continue; }

    await logAudit(admin, {
      action: "shelf_assign",
      sku: (inv as any)?.products?.sku ?? null,
      field: "location",
      oldVal: before,
      newVal: (res.data.primaryLocation as string | null) ?? null,
      details: { inventoryId: id, quantity: Number(res.data.stock) || 0 },
    });
    // A forced quantity can cross zero → authoritative transition (best-effort).
    if (forced != null) {
      const b = Number(res.data.stockBefore);
      const a = Number(res.data.stock);
      if (b !== a) await logAuthoritativeStockTransition(admin, { productId: (res.data.productId as string | null) ?? null, before: b, after: a });
    }
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
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  const slot = (location ?? "").trim().toUpperCase();
  const ids = (variantIds ?? []).filter(Boolean);
  if (!slot || ids.length === 0) return { error: "اختر رفّاً وخياراً واحداً على الأقل." };
  // When provided, force each option's placed quantity (and its stock) to this.
  const forced = setQty == null ? null : Math.max(0, Math.floor(setQty));
  const admin = writableClient();

  let done = 0;
  const errors: string[] = [];
  for (const id of ids) {
    // Read-only metadata (sku + name) for the audit only.
    const { data: v } = await admin
      .from("product_variants")
      .select("variant_name, sku")
      .eq("id", id)
      .single();

    // Put the full variant stock (forced null → current under lock) at the slot;
    // variant stock + variant shelf + parent rollup are atomic inside the RPC.
    // No direct variant_shelf_stock / product_variants write, no parent re-total loop.
    const res = await assignFullShelf(admin, { scope: "variant", targetId: id, location: slot, quantity: forced });
    if (!res.ok) { errors.push(variantStockEngineMessage(res)); continue; }

    await logAudit(admin, {
      action: "shelf_assign",
      sku: (v as any)?.sku ?? null,
      field: "location",
      oldVal: null,
      newVal: (res.data.location as string | null) ?? null,
      details: { variantId: id, variantName: (v as any)?.variant_name ?? null, quantity: Number(res.data.variantStock) || 0 },
    });
    // A forced quantity can cross zero → authoritative variant transition.
    if (forced != null) {
      const b = Number(res.data.variantBefore);
      const a = Number(res.data.variantStock);
      if (b !== a) {
        await logAuthoritativeVariantTransition(admin, {
          productId: (res.data.parentProductId as string | null) ?? null,
          variantId: id,
          variantName: String((v as any)?.variant_name ?? "خيار"),
          variantBefore: b,
          variantAfter: a,
          parentBefore: Number(res.data.parentBefore),
          parentAfter: Number(res.data.parentStock),
        });
      }
    }
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
 * Create a shelf and its slots in one go: shelf "A" with count 5 makes
 * A1..A5. Existing slots are left untouched (idempotent upsert).
 */
export async function createShelf(shelf: string, count: number) {
  const unauth = await requireWriterGate();
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
  const unauth = await requireWriterGate();
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

/**
 * Delete one EMPTY slot (topology only). INV.4C is fail-closed: if any product OR
 * variant placement still lives at this slot, the deletion is REFUSED — we never
 * auto-delete placements (the old behavior stranded stock as drift). Move/remove
 * the products first. No quantity mutation happens here.
 */
export async function deleteSlot(code: string) {
  const unauth = await requireOwnerGate();
  if (unauth) return unauth;
  const admin = writableClient();
  const slot = code.trim().toUpperCase();
  if (!slot) return { error: "رمز الرف غير صالح." };

  // Fail-closed occupancy check on BOTH shelf overlays.
  const ps = await admin.from("shelf_stock").select("inventory_id").eq("location", slot).limit(1);
  if (!ps.error && (ps.data ?? []).length > 0) {
    return { error: "لا يمكن حذف الرف — فيه منتجات. انقل/أزل المنتجات من هذا الرف أولًا." };
  }
  const vs = await admin.from("variant_shelf_stock").select("variant_id").eq("location", slot).limit(1);
  if (!vs.error && (vs.data ?? []).length > 0) {
    return { error: "لا يمكن حذف الرف — فيه خيارات منتجات. انقل/أزل الخيارات من هذا الرف أولًا." };
  }

  const { error } = await admin.from("shelf_slots").delete().eq("code", code);
  if (error) return { error: error.message };
  revalidatePath("/inventory");
  revalidatePath("/inventory/shelves");
  revalidatePath("/inventory/shelves/labels");
  return { ok: true };
}

/**
 * Delete a whole shelf (all its slots) — topology only, fail-closed. If ANY of its
 * slots holds a product OR variant placement, the WHOLE operation is refused (no
 * partial delete, no auto-unplacement). Clear the shelf first.
 */
export async function deleteShelf(shelf: string) {
  const unauth = await requireOwnerGate();
  if (unauth) return unauth;
  const admin = writableClient();
  const sh = shelf.trim().toUpperCase();
  if (!sh) return { error: "رمز الرف غير صالح." };

  const { data: slots } = await admin.from("shelf_slots").select("code").eq("shelf", sh);
  const codes = ((slots ?? []) as any[]).map((s) => String(s.code).toUpperCase());
  if (codes.length) {
    const ps = await admin.from("shelf_stock").select("inventory_id").in("location", codes).limit(1);
    if (!ps.error && (ps.data ?? []).length > 0) {
      return { error: "لا يمكن حذف الرف — فيه منتجات. انقل/أزل المنتجات من رفوف هذا الرف أولًا." };
    }
    const vs = await admin.from("variant_shelf_stock").select("variant_id").in("location", codes).limit(1);
    if (!vs.error && (vs.data ?? []).length > 0) {
      return { error: "لا يمكن حذف الرف — فيه خيارات منتجات. انقل/أزل الخيارات أولًا." };
    }
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
  const unauth = await requireOwnerGate();
  if (unauth) return { updated: 0, notFound: 0, failed: 0, missing: [] as string[], error: unauth.error };
  const admin = writableClient();
  const clean = rows
    .map((r) => ({ ...r, sku: String(r.sku ?? "").trim() }))
    .filter((r) => r.sku);
  if (clean.length === 0) return { updated: 0, notFound: 0, failed: 0, missing: [] as string[] };

  const skus = Array.from(new Set(clean.map((r) => r.sku)));

  // sku -> inventory.id (inventory joined to products via product_id)
  const skuToInv = new Map<string, string>();
  for (let i = 0; i < skus.length; i += 300) {
    const chunk = skus.slice(i, i + 300);
    const { data } = await admin
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
    const wantsStock = r.stock_quantity !== undefined && String(r.stock_quantity).trim() !== "";
    if (wantsStock) {
      const stock = toNum(r.stock_quantity);
      if (stock === null || !Number.isInteger(stock) || stock < 0) { failed++; continue; }
      // Stock quantity → Inventory Engine. A variant / shelf-tracked product is
      // rejected fail-closed and counts as FAILED (never a manual parent write).
      const res = await setAbsolute(admin, id, stock);
      if (!res.ok) { failed++; continue; }
      await afterStockSet(admin, res, { action: "stock_set", sku: r.sku, details: { via: "csv_import" } });
      // Optional threshold alongside a stock row (non-quantity path).
      if (r.low_stock_threshold !== undefined && String(r.low_stock_threshold).trim() !== "") {
        await admin.from("inventory").update({ low_stock_threshold: toNum(r.low_stock_threshold), updated_at: now }).eq("id", id);
      }
      updated++;
    } else if (r.low_stock_threshold !== undefined && String(r.low_stock_threshold).trim() !== "") {
      // Threshold-only CSV row (never touches stock_quantity).
      const { error } = await admin.from("inventory").update({ low_stock_threshold: toNum(r.low_stock_threshold), updated_at: now }).eq("id", id);
      if (error) failed++;
      else updated++;
    } else {
      updated++; // nothing to change for this row
    }
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
  const unauth = await requireWriterGate();
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
  const unauth = await requireWriterGate();
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
  const unauth = await requireWriterGate();
  if (unauth) return unauth;
  const admin = writableClient();
  const qty = Math.floor(Math.abs(Number(input.quantity)));
  if (!input.variantId || !qty || Number.isNaN(qty)) {
    return { error: "Pick a variant and a quantity greater than 0." };
  }
  if (input.type !== "in" && input.type !== "out") return { error: "Invalid movement type." };

  // Variant stock ± parent rollup ± (sale-out only) sold_quantity → Inventory
  // Engine, ALL atomic in one RPC. No read-modify-write, no sibling sum, no
  // inventory/sold update outside the RPC. A read-only metadata lookup (barcode /
  // name) is allowed for the audit/UI, but NEVER used to compute the mutation.
  const isSale = input.type === "out" && (input.reason ?? "").trim().toLowerCase() === "sale";
  const delta = input.type === "in" ? qty : -qty;
  const soldDelta = isSale ? qty : 0;

  const res = await adjustVariantMovement(admin, { variantId: input.variantId, delta, soldDelta });
  if (!res.ok) return { error: variantStockEngineMessage(res) };

  // Authoritative before/after/parent/sold come from the Engine result — never a
  // local read.
  const before = Number(res.data.before);
  const after = Number(res.data.after);
  const parentBefore = Number(res.data.parentBefore);
  const parentAfter = Number(res.data.parentStock);
  const parentId = (res.data.productId as string | null) ?? null;

  // Best-effort ledger row (see note in recordMovement). old/new from the engine.
  const { error: logErr } = await insertAuditRow(admin, {
    agent: input.by || "inventory",
    action: input.type === "in" ? "stock_in" : "stock_out",
    action_type: input.type === "in" ? "stock_in" : "stock_out",
    sku: input.sku ?? null,
    product_id: parentId,
    field: "variant_stock_quantity",
    old_value: String(before),
    new_value: String(after),
    status: "done",
    details: {
      variantId: input.variantId,
      productId: parentId,
      quantity: qty,
      direction: input.type,
      reason: input.reason ?? null,
      note: input.note ?? null,
    },
  });
  if (logErr) console.error("[recordVariantMovement] audit insert failed:", logErr.message);

  // Authoritative zero-crossing transition (best-effort) — engine parentBefore/
  // parentStock, not the double-counting totalStock helper.
  await logAuthoritativeVariantTransition(admin, {
    productId: parentId,
    variantId: input.variantId,
    variantName: "خيار",
    variantBefore: before,
    variantAfter: after,
    parentBefore,
    parentAfter,
    actor: input.by || "inventory",
  });

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
  const unauth = await requireWriterGate();
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

  // INV.2D — availability only: mark the matched products Out of Stock via the
  // Availability Engine (products.stock_status). NO local quantity writes
  // (inventory/variant stock is never zeroed). Delisting the channels stays an
  // explicit, separate propagation policy — availability and listing are distinct.
  await writeProductAvailability(admin, idList, "Out of Stock");
  for (let i = 0; i < idList.length; i += 200) {
    const chunk = idList.slice(i, i + 200);
    await admin.from("channel_products").update({ channel_status: "Not Listed" }).in("product_id", chunk);
  }

  // Best-effort external sync: push 0 stock to Shopify for every matched SKU.
  // The local availability/listing writes above stand on their own — a Shopify
  // hiccup never rolls them back; the returned status lets the UI say whether the
  // store synced too.
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
  const unauth = await requireWriterGate();
  if (unauth) return { error: (unauth as any).error ?? "Not signed in.", applied: false, products: [], channelRows: 0 };

  const admin = writableClient();
  const PAGE = 1000;

  // INV.2D — a product is out-of-stock per its EXPLICIT availability
  // (products.stock_status), never derived from quantity.
  const oos = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from("products").select("id, stock_status").range(from, from + PAGE - 1);
    if (error) return { error: error.message, applied: false, products: [], channelRows: 0 };
    for (const r of (data ?? []) as any[]) {
      if (!r.id) continue;
      if (!isAvailable(r.stock_status)) oos.add(r.id);
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
  const unauth = await requireWriterGate();
  if (unauth) return { ok: false, error: unauth.error };
  const res = await setInventoryMode(mode === "simple" ? "simple" : "quantities");
  if (!res.ok) return res;
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  revalidatePath("/products");
  return { ok: true };
}

/**
 * INV.2C — Simple-mode availability toggle. Availability is an EXPLICIT
 * product-level state written to products.stock_status through the Availability
 * Engine. It NEVER mutates quantity (inventory/variant stock, shelves, sold) —
 * the reconciled counts stay byte-identical. Keyed by product id. Channel
 * propagation (Shopify/Talabat/overlay) is INV.2D.
 */
export async function setProductAvailability(
  productId: string,
  inStock: boolean
): Promise<{ ok: boolean; error?: string }> {
  const unauth = await requireWriterGate();
  if (unauth) return { ok: false, error: unauth.error };
  const admin = writableClient();
  const res = await setProductAvailabilityState(admin, String(productId), inStock);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/inventory");
  revalidatePath("/inventory/out-of-stock");
  revalidatePath("/dashboard");
  revalidatePath("/products");
  return { ok: true };
}

/**
 * Bulk simple-mode toggle: mark many products In / Out at once (select-all).
 * INV.2C — writes products.stock_status via the engine; no quantity writes.
 * Keyed by product id.
 */
export async function setManyAvailability(
  productIds: string[],
  inStock: boolean
): Promise<{ ok: boolean; count: number; error?: string }> {
  const unauth = await requireWriterGate();
  if (unauth) return { ok: false, count: 0, error: unauth.error };
  const admin = writableClient();
  const res = await writeProductAvailability(admin, productIds ?? [], availabilityFromInStock(inStock));
  if (!res.ok) return { ok: false, count: res.count, error: res.error };

  revalidatePath("/inventory");
  revalidatePath("/inventory/out-of-stock");
  revalidatePath("/products");
  revalidatePath("/dashboard");
  return { ok: true, count: res.count };
}

/**
 * INV.2E — Simple-mode availability toggle for ONE option (variant). Writes the
 * explicit product_variants.stock_status through the Availability Engine; NEVER
 * mutates variant quantity, and never touches the parent product. Keyed by
 * variant id.
 */
export async function setVariantAvailability(
  variantId: string,
  inStock: boolean
): Promise<{ ok: boolean; error?: string }> {
  const unauth = await requireWriterGate();
  if (unauth) return { ok: false, error: unauth.error };
  const admin = writableClient();
  const res = await setVariantAvailabilityState(admin, String(variantId), inStock);
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  return { ok: true };
}
