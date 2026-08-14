// Shared product-save core (Phase UI.4).
//
// Extracted from app/(app)/products/actions.ts so the legacy editor and the V2
// product editor share ONE write path instead of two drifting copies. The
// behaviour here is the legacy behaviour, verbatim: same write order (product
// row → inventory sync → variant sync), same failure strings for the legacy
// caller, same RPC contract. V2 maps the returned failure to its own fixed
// Arabic messages (lib/products/edit-validation.ts) — the raw legacy strings
// never reach a V2 page.
//
// Deliberately NOT a "use server" module: every export of a "use server" file
// becomes a callable endpoint, and this is an internal core, not an action.
//
// Import discipline: this module has NO top-level runtime imports, so node:test
// can load it directly. Production defaults for the text cleaners, the category
// list and the diff planner resolve through lazy import() and are injectable
// for tests — the same pattern as lib/catalog-v2/shopify-catalog-read.ts.

// --- input shapes (sent from the client form) -----------------------------

export interface VariantInput {
  id?: string;
  variant_name: string;
  variant_name_en: string;
  sku: string;
  barcode: string;
  color: string;
  size: string;
  price: string;
  stock_quantity: string;
  /**
   * Validation-only (UX.4E-3 grandfathering): the persisted SKU/barcode this
   * existing variant loaded with. Set by withPersistedIdentity for the V2 edit
   * payload so the shared validator can grandfather an UNCHANGED legacy identity.
   * NEVER persisted — toVariantPayload/the RPC ignore these fields.
   */
  original_sku?: string;
  original_barcode?: string;
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
  /**
   * Validation-only (UX.4E-3 grandfathering): the persisted main SKU/barcode
   * this product loaded with. Set by withPersistedIdentity for the V2 edit
   * payload so the shared validator can grandfather an UNCHANGED legacy main
   * identity. NEVER persisted — toProductRow ignores these fields.
   */
  original_sku?: string;
  original_barcode?: string;
}

// --- pure helpers ----------------------------------------------------------

export const str = (v: string) => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

export const num = (v: string) => {
  const t = (v ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return isNaN(n) ? null : n;
};

// Turn a raw Postgres write error into something a human can act on. The most
// common one is a duplicate SKU/barcode (unique violation, code 23505) which
// otherwise surfaces as "duplicate key value violates unique constraint …".
export function friendlyWriteError(
  error: { code?: string; message: string } | null,
  fallback: string
): string {
  if (!error) return fallback;
  if (error.code === "23505") {
    return "A product with this SKU or barcode already exists. Please use a unique value.";
  }
  return error.message || fallback;
}

// Fixed, user-safe messages for every variant-sync failure. They never contain
// a uuid, a constraint name, SQL, a table name, or a raw database message.
export const VARIANT_SYNC_MESSAGES: Record<string, string> = {
  unknown_variant_id: "تعذّر حفظ الخيارات — حدّث الصفحة وحاول مجددًا.",
  duplicate_variant_id: "تعذّر حفظ الخيارات — حدّث الصفحة وحاول مجددًا.",
  variant_has_shelf_stock: "لا يمكن حذف خيار لا تزال عليه كمية في الرفوف — أفرغ الكمية أولًا ثم احذفه.",
  variant_has_channel_mapping: "لا يمكن حذف خيار مرتبط بمنصة بيع — عالِج ارتباط المنصة أولًا ثم احذفه.",
  // INV.4D additions:
  variant_invalid_quantity: "كمية خيار غير صالحة — يجب أن تكون رقمًا صحيحًا غير سالب.",
  variant_stock_managed_by_shelves: "مخزون هذا الخيار يُدار من الرفوف؛ عدّل الكمية من إدارة الرفوف بدل هذه الصفحة.",
  variant_parent_shelf_conflict: "حالة رفوف غير متسقة على المنتج الأب — عالِج رفوف المنتج قبل تعديل الخيارات.",
  variant_sync_failed: "تعذّر حفظ الخيارات — حدّث الصفحة وحاول مجددًا.",
};

/** Prototype-safe fixed-message lookup; unknown codes fall back to the generic. */
export function variantSyncMessage(code: unknown): string {
  const fallback = VARIANT_SYNC_MESSAGES.variant_sync_failed;
  if (typeof code !== "string") return fallback;
  if (!Object.hasOwn(VARIANT_SYNC_MESSAGES, code)) return fallback;
  const msg = VARIANT_SYNC_MESSAGES[code];
  return typeof msg === "string" ? msg : fallback;
}

/**
 * The payload shape the sync RPC expects: trimmed text, real JSON numbers.
 * A retained variant's id passes through VERBATIM; a row without an id (or
 * with a blank one) is sent as id:null so the DATABASE generates the uuid —
 * a client-supplied id is never used for an insert.
 */
export function toVariantPayload(variants: VariantInput[]) {
  return (Array.isArray(variants) ? variants : []).map((v) => ({
    id: typeof v.id === "string" && v.id.trim().length > 0 ? v.id.trim() : null,
    variant_name: str(v.variant_name),
    variant_name_en: str(v.variant_name_en),
    sku: str(v.sku),
    barcode: str(v.barcode),
    color: str(v.color),
    size: str(v.size),
    price: num(v.price),
    stock_quantity: num(v.stock_quantity),
  }));
}

// --- injectable production defaults ----------------------------------------

type PlanVariantDiffFn = (
  existingIds: readonly string[],
  submitted: readonly VariantInput[],
) => { ok: true } | { ok: false; error: string };

export interface ProductSaveDeps {
  /** Emoji/decoration stripper for names (default: lib/malak clean()). */
  cleanText?: (v: string) => string;
  /** Description cleaner that keeps house bullets (default: cleanDescription()). */
  cleanDescriptionText?: (v: string) => string;
  /** The locked category list (default: CATEGORIES from lib/constants). */
  categories?: readonly string[];
  /** The pure diff planner (default: planVariantDiff from ./variant-diff). */
  planVariantDiff?: PlanVariantDiffFn;
}

// INV.4D — injected numeric-stock port. The editor NEVER writes inventory
// quantities directly; a simple product's stock change goes through this adapter,
// which the V2 action backs with the service-role Inventory Engine (setAbsolute).
// Injected (not a top-level engine import) so product-save stays unit-testable.
export type InventorySetAbsoluteResult =
  | { ok: true; before: number; after: number; productId: string | null }
  | { ok: false; reason: string };

export interface InventoryAdapter {
  setAbsolute(inventoryId: string, quantity: number): Promise<InventorySetAbsoluteResult>;
}

export interface UpdateProductCoreOptions extends ProductSaveDeps {
  /** Service-role-backed numeric-stock port (Inventory Engine setAbsolute). */
  inventory: InventoryAdapter;
}

/** One variant's before/after as reported by the atomic sync RPC (for audit). */
export interface VariantChange {
  variantId: string;
  variantName: string | null;
  kind: "updated" | "inserted" | "deleted";
  before: number;
  after: number;
}

export type SyncVariantsResult =
  | {
      ok: true;
      hasVariants: boolean;
      parentBefore: number;
      /** Σ variants when the product has variants; null when it has none. */
      parentStock: number | null;
      variantChanges: VariantChange[];
    }
  | { ok: false; message: string };

async function resolveCleaners(deps?: ProductSaveDeps) {
  if (deps?.cleanText && deps?.cleanDescriptionText) {
    return { clean: deps.cleanText, cleanDescription: deps.cleanDescriptionText };
  }
  const m = await import("../malak/talabat-export.mjs");
  return {
    clean: deps?.cleanText ?? (m.clean as (v: string) => string),
    cleanDescription: deps?.cleanDescriptionText ?? (m.cleanDescription as (v: string) => string),
  };
}

async function resolveCategories(deps?: ProductSaveDeps): Promise<readonly string[]> {
  if (deps?.categories) return deps.categories;
  const m = await import("../constants");
  return m.CATEGORIES;
}

async function resolvePlanner(deps?: ProductSaveDeps): Promise<PlanVariantDiffFn> {
  if (deps?.planVariantDiff) return deps.planVariantDiff;
  const m = await import("./variant-diff");
  return m.planVariantDiff as PlanVariantDiffFn;
}

// --- row projection ----------------------------------------------------------

/**
 * Project the string-based form input into a products row. Throws on a
 * category outside the locked list (defence in depth; the UI restricts it too).
 */
export async function toProductRow(input: ProductInput, deps?: ProductSaveDeps) {
  const { clean, cleanDescription } = await resolveCleaners(deps);
  const categories = await resolveCategories(deps);
  const cleanStr = (v: string) => {
    const t = clean(v);
    return t === "" ? null : t;
  };
  const cleanDesc = (v: string) => {
    const t = cleanDescription(v);
    return t === "" ? null : t;
  };

  const category = str(input.main_category);
  if (category && !categories.includes(category)) {
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

// --- minimal structural client ----------------------------------------------

// PostgREST's generic `.filter(col, op, value)` is used rather than `.eq`,
// for the same reason as lib/products/shelf-cleanup.ts: `.eq` derives its value
// type from the row generic, which makes the real Supabase client's structural
// assignment to this interface instantiate too deeply (TS2589).
type WriteError = { code?: string; message: string };

interface SelectFilterChain extends PromiseLike<{ data: unknown[] | null; error: unknown }> {
  maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
}

export interface ProductSaveClient {
  from(table: string): {
    select(columns: string): {
      filter(column: string, operator: string, value: string): SelectFilterChain;
    };
    update(values: Record<string, unknown>): {
      filter(column: string, operator: string, value: string): PromiseLike<{ error: WriteError | null }>;
    };
    insert(values: Record<string, unknown>): PromiseLike<{ error: WriteError | null }>;
  };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

// --- variant sync -------------------------------------------------------------

/**
 * Sync a product's variants without changing the id of any retained row.
 *
 * Two layers on purpose. First a pure server-side pre-check against the
 * authoritative id set, so a stale or foreign id is rejected before ANY variant
 * write is attempted. Then one atomic RPC that re-validates and performs
 * update/insert/delete in a single transaction — the database, not the client,
 * is the authority, and a partial failure cannot leave the product with fewer
 * variants than it started with.
 *
 * Returns a fixed user-facing message on failure, or null on success.
 */
export async function syncProductVariants(
  client: ProductSaveClient,
  productId: string,
  variants: VariantInput[],
  deps?: ProductSaveDeps,
): Promise<SyncVariantsResult> {
  const { data: existing, error: readErr } = await client
    .from("product_variants")
    .select("id")
    .filter("parent_product_id", "eq", productId);
  if (readErr) return { ok: false, message: variantSyncMessage("variant_sync_failed") };

  const existingIds = (existing ?? [])
    .map((r) => (r as { id?: unknown }).id)
    .filter((v): v is string => typeof v === "string");

  // Fail fast, before touching anything.
  const planVariantDiff = await resolvePlanner(deps);
  const plan = planVariantDiff(existingIds, variants);
  if (!plan.ok) return { ok: false, message: variantSyncMessage(plan.error) };

  const { data, error } = await client.rpc("sync_product_variants", {
    p_product_id: productId,
    p_variants: toVariantPayload(variants),
  });
  if (error) return { ok: false, message: variantSyncMessage("variant_sync_failed") };

  const result = data as {
    ok?: unknown; error?: unknown;
    hasVariants?: unknown; parentBefore?: unknown; parentStock?: unknown; variantChanges?: unknown;
  } | null;
  if (result === null || typeof result !== "object" || result.ok !== true) {
    return { ok: false, message: variantSyncMessage(result?.error) };
  }
  return {
    ok: true,
    hasVariants: result.hasVariants === true,
    parentBefore: Number(result.parentBefore) || 0,
    parentStock: result.parentStock == null ? null : Number(result.parentStock),
    variantChanges: Array.isArray(result.variantChanges) ? (result.variantChanges as VariantChange[]) : [],
  };
}

// --- update core ---------------------------------------------------------------

/**
 * Discriminated result. `message` carries the LEGACY string for that stage
 * (English, possibly derived from the database error) so the legacy caller
 * keeps returning exactly what it returned before this extraction. V2 callers
 * must NOT surface `message` for stages other than variant_sync — they map the
 * stage (+ duplicateIdentity) to a fixed Arabic message instead. variant_sync
 * messages are already the fixed Arabic constants and safe for both callers.
 */
export type UpdateProductCoreResult =
  | {
      ok: true;
      before: Record<string, unknown> | null;
      row: Record<string, unknown>;
      /** Final grain after the variant sync. */
      hasVariants: boolean;
      /** Authoritative parent/product stock before → after this save. */
      stockBefore: number;
      stockAfter: number;
      /** Whether a numeric stock mutation actually happened (drives transition/audit). */
      stockChanged: boolean;
      /** Per-variant before/after from the atomic sync (for variant audit). */
      variantChanges: VariantChange[];
    }
  | {
      ok: false;
      stage: "invalid_input" | "product_update" | "inventory_sync" | "variant_sync";
      message: string;
      duplicateIdentity?: boolean;
      /** INV.4D: the Engine/inventory reason code, for a precise V2 message. */
      reason?: string;
    };

const BEFORE_COLUMNS =
  "name_en, name_ar, sku, barcode, price, discount_price, description_en, description_ar, main_category, sub_category, image_url, approval";

/** Fixed English fallbacks (V2 maps the stage/reason to Arabic; legacy would show these). */
export const INVENTORY_MISSING_MESSAGE =
  "Product saved, but its inventory row is missing — stock was not changed.";

/**
 * The shared save path for editing an existing product (INV.4D authoritative order):
 *
 *   1. validate + project the form input
 *   2. update the product METADATA only (never stock_quantity in this write)
 *   3. verify EXACTLY the existing inventory row (read-only) — FAIL CLOSED if it
 *      is missing (no lazy seed from the editor; fresh seeds live in create cores)
 *   4. sync variants atomically (the RPC rolls the parent inventory up to Σ
 *      variants inside its own transaction for a variant product)
 *   5. determine the final grain from the sync result:
 *        · variant  → parent stock is the RPC's Σ-variants rollup (NEVER the
 *          top-level form field)
 *        · simple   → the top-level field is the requested stock; call the
 *          Inventory Engine setAbsolute ONLY when it actually changed (so a
 *          metadata-only save never trips the shelf-tracked guard)
 *   6. write the TEMPORARY products.stock_quantity mirror = authoritative final
 *      stock (compatibility only, retired in INV.4E — never read as authority)
 *
 * Session-scoped client for product metadata + the SECURITY INVOKER variant RPC
 * (RLS applies). Numeric inventory quantities go ONLY through the injected
 * `inventory` adapter (service-role Inventory Engine) — this core never writes an
 * inventory quantity or seeds an inventory row directly.
 */
export async function updateProductCore(
  client: ProductSaveClient,
  id: string,
  input: ProductInput,
  opts: UpdateProductCoreOptions,
): Promise<UpdateProductCoreResult> {
  const deps = opts;
  const inventory = opts.inventory;

  let row: Record<string, unknown>;
  try {
    row = await toProductRow(input, deps);
  } catch (e) {
    return {
      ok: false,
      stage: "invalid_input",
      message: e instanceof Error ? e.message : "Invalid product data.",
    };
  }
  const requestedStock = row.stock_quantity as number | null;

  // Snapshot BEFORE the write so the caller's auto-task can show old -> new.
  const { data: before } = await client
    .from("products")
    .select(BEFORE_COLUMNS)
    .filter("id", "eq", id)
    .maybeSingle();

  // METADATA ONLY — stock_quantity is deliberately excluded here. The mirror is
  // written later (step 6) from the authoritative final stock. stock_status stays
  // an explicit, user-owned field (Availability), never derived from quantity.
  const { stock_quantity: _stockOmit, ...metadataPatch } = row;
  const { error } = await client.from("products").update(metadataPatch).filter("id", "eq", id);
  if (error) {
    return {
      ok: false,
      stage: "product_update",
      message: friendlyWriteError(error, "Could not update product."),
      duplicateIdentity: error.code === "23505",
    };
  }

  // Inventory row must already exist — FAIL CLOSED, no lazy seed from the editor.
  const { data: invRow } = await client
    .from("inventory")
    .select("id, stock_quantity")
    .filter("product_id", "eq", id)
    .maybeSingle();
  if (!invRow || typeof (invRow as { id?: unknown }).id !== "string") {
    return { ok: false, stage: "inventory_sync", message: INVENTORY_MISSING_MESSAGE, reason: "inventory_missing" };
  }
  const invId = (invRow as { id: string }).id;
  const invStockBefore = Number((invRow as { stock_quantity?: unknown }).stock_quantity) || 0;

  // Variants sync atomically; for a variant product the RPC also rolls the parent
  // inventory up to Σ variants inside the same transaction.
  const sync = await syncProductVariants(client, id, input.variants, deps);
  if (!sync.ok) {
    return { ok: false, stage: "variant_sync", message: sync.message };
  }

  let stockBefore: number;
  let stockAfter: number;
  let stockChanged: boolean;

  if (sync.hasVariants) {
    // Parent pool is authoritative from the atomic rollup — NEVER the form field.
    stockBefore = sync.parentBefore;
    stockAfter = sync.parentStock ?? sync.parentBefore;
    stockChanged = stockBefore !== stockAfter;
  } else if (requestedStock != null && requestedStock !== invStockBefore) {
    // Simple product with a real stock change → Inventory Engine (atomic).
    const res = await inventory.setAbsolute(invId, requestedStock);
    if (!res.ok) {
      return { ok: false, stage: "inventory_sync", message: INVENTORY_MISSING_MESSAGE, reason: res.reason };
    }
    stockBefore = res.before;
    stockAfter = res.after;
    stockChanged = true;
  } else {
    // Metadata-only (unchanged stock): no Engine call — never trips the
    // shelf-tracked guard just because shelf rows exist.
    stockBefore = invStockBefore;
    stockAfter = invStockBefore;
    stockChanged = false;
  }

  // TEMPORARY products.stock_quantity mirror = authoritative final stock. Best
  // effort: the authoritative inventory is already correct; the mirror is retired
  // in INV.4E and is never read as authority.
  await client.from("products").update({ stock_quantity: stockAfter }).filter("id", "eq", id);

  return {
    ok: true,
    before: before ?? null,
    row,
    hasVariants: sync.hasVariants,
    stockBefore,
    stockAfter,
    stockChanged,
    variantChanges: sync.variantChanges,
  };
}
