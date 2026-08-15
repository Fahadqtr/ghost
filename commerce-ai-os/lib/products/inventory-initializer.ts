import "server-only";
import type { CreateVariantRow, InitializeInventoryState } from "./product-create.ts";
import type { InitializeSimpleProducts } from "./product-create-batch.ts";

// INV.6B — server-only inventory-initialization adapter. Binds a SERVICE-ROLE
// admin client to the atomic inv_initialize_product_state RPC and returns the
// InitializeInventoryState callback createProductCore injects. This is how a
// just-created product's authoritative inventory (+ variants) is set up after the
// strict lockdown makes direct inventory/variant writes impossible for every role.
//
// Fail-closed: transport error / malformed body / status != 'applied' is a
// FAILURE; the RPC's classified reason is surfaced verbatim so the core can map
// invalid_seed / invalid_variant_stock to its stages. Never a direct-write fallback.
//
// Never exposed to the browser/session client — a server action authorizes at its
// boundary, then calls createProductCore with THIS adapter built from the admin client.
export function makeInventoryInitializer(admin: {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}): InitializeInventoryState {
  return async ({ productId, simpleStock, variants }) => {
    const { data, error } = await admin.rpc("inv_initialize_product_state", {
      p_product_id: productId,
      p_simple_stock: simpleStock,
      // Plain jsonb array (metadata + normalized stock) — the RPC validates + inserts.
      p_variants: variants.map((v: CreateVariantRow) => ({
        variant_name: v.variant_name,
        variant_name_en: v.variant_name_en,
        sku: v.sku,
        barcode: v.barcode,
        color: v.color,
        size: v.size,
        price: v.price,
        stock_quantity: v.stock_quantity,
      })),
    });
    if (error) {
      // A variant SKU/barcode collision surfaces as an uncaught unique_violation
      // (SQLSTATE 23505); classify it so the create caller can show the
      // "identity already taken" copy instead of a generic structural failure.
      const code = (error as { code?: string } | null)?.code;
      const duplicate = code === "23505";
      return { ok: false, reason: duplicate ? "duplicate_variant" : "rpc_transport_error", duplicateIdentity: duplicate };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "malformed_result" };
    const res = data as Record<string, unknown>;
    if (res.status !== "applied") {
      return { ok: false, reason: typeof res.reason === "string" ? res.reason : "init_failed" };
    }
    return { ok: true };
  };
}

// INV.6B — batch sibling: binds a service-role admin client to the atomic
// inv_initialize_simple_products RPC for the importers' createProductsBatchCore.
// All-or-nothing per chunk; fail-closed on any transport/malformed/status failure.
export function makeSimpleProductsInitializer(admin: {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}): InitializeSimpleProducts {
  return async (targets) => {
    const { data, error } = await admin.rpc("inv_initialize_simple_products", {
      p_rows: targets.map((t) => ({ productId: t.productId, stockQuantity: t.stockQuantity })),
    });
    if (error) return { ok: false };
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false };
    return (data as Record<string, unknown>).status === "applied" ? { ok: true } : { ok: false };
  };
}
