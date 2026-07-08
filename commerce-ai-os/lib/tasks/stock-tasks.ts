import "server-only";
import { logCatalogTask } from "./catalog-log";

// Auto-open a platforms task when a product's TOTAL stock crosses zero:
//   >0 → 0 : "oos"     — mark it unavailable on the manual platforms
//   0 → >0 : "restock" — re-enable it there
// Wired into every stock write path (movements, movement edit/delete, the
// manager's product editor, Shopify order deduction). Strictly best-effort —
// a task failure must never block the stock write it describes.

const s = (v: unknown) => String(v ?? "").trim();

/** TOTAL sellable stock of a product = its inventory rows + its variant rows. */
export async function totalStock(admin: any, productId: string): Promise<number> {
  let total = 0;
  const { data: inv } = await admin.from("inventory").select("stock_quantity").eq("product_id", productId);
  for (const r of (inv ?? []) as { stock_quantity: number | null }[]) total += Number(r.stock_quantity) || 0;
  try {
    const { data: vars } = await admin.from("product_variants").select("stock_quantity").eq("parent_product_id", productId);
    for (const r of (vars ?? []) as { stock_quantity: number | null }[]) total += Number(r.stock_quantity) || 0;
  } catch { /* variants table optional */ }
  return total;
}

/**
 * Open an oos/restock task for the product unless an OPEN one of the same
 * action already exists. Only Approved products get tasks — the platforms
 * don't list the rest. Returns what happened (for the supervisor UI).
 */
export async function openStockTask(
  admin: any,
  productId: string,
  action: "oos" | "restock",
  actor?: string,
): Promise<"opened" | "duplicate" | "skipped"> {
  const { data: existing } = await admin
    .from("staff_tasks")
    .select("id, payload")
    .eq("kind", "catalog")
    .eq("product_id", productId)
    .neq("status", "done")
    .limit(25);
  if (((existing ?? []) as { payload?: { action?: string } }[]).some((t) => t?.payload?.action === action)) {
    return "duplicate";
  }

  const { data: prod } = await admin
    .from("products")
    .select("name_en, name_ar, sku, barcode, image_url, price, discount_price, approval")
    .eq("id", productId)
    .maybeSingle();
  if (!prod) return "skipped";
  if (s(prod.approval) !== "Approved") return "skipped"; // not sellable anywhere

  await logCatalogTask({
    action,
    productId,
    snapshot: prod as Record<string, unknown>,
    note: action === "oos"
      ? "⚠️ المخزون خلص — علّمه «غير متوفر» في المنصات اليدوية."
      : "✅ المخزون رجع — فعّله من جديد في المنصات اليدوية.",
    actor,
  });
  return "opened";
}

/**
 * Option-scoped task: one specific variant ran out (or came back) while the
 * parent product still has other stock. Deduped per variant + action.
 */
export async function openVariantStockTask(
  admin: any,
  productId: string,
  variant: { id: string; name: string },
  action: "oos" | "restock",
  actor?: string,
): Promise<"opened" | "duplicate" | "skipped"> {
  const { data: existing } = await admin
    .from("staff_tasks")
    .select("id, payload")
    .eq("kind", "catalog")
    .eq("product_id", productId)
    .neq("status", "done")
    .limit(25);
  if (((existing ?? []) as { payload?: { action?: string; variantId?: string } }[])
    .some((t) => t?.payload?.action === action && t?.payload?.variantId === variant.id)) {
    return "duplicate";
  }

  const { data: prod } = await admin
    .from("products")
    .select("name_en, name_ar, sku, barcode, image_url, price, discount_price, approval")
    .eq("id", productId)
    .maybeSingle();
  if (!prod) return "skipped";
  if (s(prod.approval) !== "Approved") return "skipped";

  await logCatalogTask({
    action,
    productId,
    snapshot: prod as Record<string, unknown>,
    note: action === "oos"
      ? `🎚️ الخيار «${variant.name}» فقط خلص — علّمه «غير متوفر» في المنصات اليدوية (باقي الخيارات متوفرة).`
      : `🎚️ الخيار «${variant.name}» رجع له مخزون — فعّله من جديد في المنصات اليدوية.`,
    actor,
    extraPayload: { variantId: variant.id, variantName: variant.name },
  });
  return "opened";
}

/**
 * Called after ONE variant row changed (before → after). If the PRODUCT total
 * crossed zero the product-level task opens; otherwise, if just this option
 * crossed zero, the option-scoped task opens.
 */
export async function logVariantStockTransition(admin: any, opts: {
  productId: string | null | undefined;
  variantId: string;
  variantName: string;
  before: number;
  after: number;
  actor?: string;
}): Promise<void> {
  try {
    const productId = opts.productId ? String(opts.productId) : "";
    if (!productId) return;
    const before = Number(opts.before) || 0;
    const after = Number(opts.after) || 0;
    const delta = after - before;
    if (!delta) return;

    const totalNow = await totalStock(admin, productId);
    const totalBefore = totalNow - delta;
    if ((totalBefore <= 0) !== (totalNow <= 0)) {
      // The whole product crossed zero — the product-level task says it all.
      await openStockTask(admin, productId, totalNow <= 0 ? "oos" : "restock", opts.actor);
      return;
    }
    if ((before <= 0) !== (after <= 0)) {
      await openVariantStockTask(
        admin, productId,
        { id: opts.variantId, name: opts.variantName },
        after <= 0 ? "oos" : "restock",
        opts.actor,
      );
    }
  } catch (e) {
    console.error("[variant-stock-task]", e instanceof Error ? e.message : e);
  }
}

/**
 * Called after ONE inventory row changed (before → after). Recomputes the
 * product's total (variants included) and opens the task only when the TOTAL
 * actually crossed zero — a row hitting 0 while a variant still has stock is
 * not out of stock.
 */
export async function logStockTransition(admin: any, opts: {
  productId: string | null | undefined;
  before: number;
  after: number;
  actor?: string;
}): Promise<void> {
  try {
    const productId = opts.productId ? String(opts.productId) : "";
    if (!productId) return;
    const delta = (Number(opts.after) || 0) - (Number(opts.before) || 0);
    if (!delta) return;

    const totalNow = await totalStock(admin, productId);
    const totalBefore = totalNow - delta;
    const wasOut = totalBefore <= 0;
    const isOut = totalNow <= 0;
    if (wasOut === isOut) return; // no zero crossing

    await openStockTask(admin, productId, isOut ? "oos" : "restock", opts.actor);
  } catch (e) {
    console.error("[stock-task]", e instanceof Error ? e.message : e);
  }
}
