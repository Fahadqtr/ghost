import "server-only";
// CH.6F — controlled Catalog import boundary (SERVER-ONLY).
//
// Imports an external-only listing into the internal Catalog ONLY through the
// approved create core (§11): createProductCore + the RPC-protected inventory
// initializer. It NEVER inserts into products/product_variants/inventory
// directly, NEVER writes stock/quantity, and NEVER copies channel quantity —
// the inventory seed is fixed at 0 (Catalog/Inventory policy). New products are
// created unapproved and channel-invisible (approval:"", platform_status:"").
//
// The internal category is OPERATOR-SUPPLIED (never fabricated); an internal SKU
// / barcode is assigned by the house generators (the same identifiers the AI
// creator mints) — the external SKU/barcode are preserved on the ECL row, not
// invented catalog facts. Duplicate protection is the caller's fresh snapshot.

import { createProductCore } from "@/lib/products/product-create";
import { makeInventoryInitializer } from "@/lib/products/inventory-initializer";
import { toProductRow, type ProductInput } from "@/lib/products/product-save";
import { nextMkSku, isValidMkSku, normalizeMkSku } from "@/lib/products/sku-generate";
import { generateUniqueEan13Batch } from "@/lib/products/barcode-ean13";
import { isValidBarcode, normalizeBarcode } from "./discovery-match.ts";

export interface ImportCandidate {
  title: string | null;
  sku: string | null;
  barcode: string | null;
  externalId: string | null;
  price: string | null;
}

export interface ImportContext {
  /** operator-supplied category (validated against CATEGORIES by the caller) */
  category: string;
  subCategory: string;
  /** fresh identity snapshot for duplicate protection + id generation */
  existingSkus: string[];
  existingBarcodes: ReadonlySet<string>;
}

export type ImportOne =
  | { ok: true; productId: string; sku: string; barcode: string }
  | { ok: false; error: string; duplicate?: boolean };

interface SessionClient {
  // opaque — passed straight to createProductCore
  from: unknown;
}
interface AdminClient {
  from: unknown;
}

/**
 * Build the products row for a minimally valid internal product from authoritative
 * external evidence + an operator category. Pure except for the async cleaners
 * inside toProductRow. Assigns an internal mk-SKU / EAN-13 when the external ones
 * are unusable as internal identifiers.
 */
export function buildImportInput(candidate: ImportCandidate, ctx: ImportContext): { input: ProductInput; sku: string; barcode: string } | { error: string } {
  const title = (candidate.title ?? "").trim();
  if (title.length < 2) return { error: "missing title" };
  if (!ctx.category) return { error: "missing category" };

  // internal SKU: reuse the external one only if it is already the house form
  const extSku = candidate.sku ?? "";
  const sku = isValidMkSku(extSku) ? normalizeMkSku(extSku) : nextMkSku(ctx.existingSkus);

  // internal barcode: reuse a valid external EAN-13, else mint one
  const extBc = isValidBarcode(candidate.barcode) ? normalizeBarcode(candidate.barcode)! : null;
  const barcode = extBc ?? generateUniqueEan13Batch(1, ctx.existingBarcodes, Math.random)[0];

  const price = (candidate.price ?? "").trim();
  const input: ProductInput = {
    sku,
    barcode,
    name_en: title,
    name_ar: title,
    brand_id: "",
    main_category: ctx.category,
    sub_category: ctx.subCategory ?? "",
    product_type: "",
    color: "",
    size: "",
    price: /^\d+(\.\d+)?$/.test(price) ? price : "0",
    discount_price: "",
    cost: "",
    stock_quantity: "0", // policy seed — never channel quantity (§2/§11)
    stock_status: "",
    platform_status: "", // channel-invisible until a separate publish flow
    approval: "", //        unapproved on creation
    rejection_reason: "",
    image_filename: "",
    image_url: "",
    description_en: "",
    description_ar: "",
    keywords_en: "",
    keywords_ar: "",
    notes: "",
    variants: [],
  };
  return { input, sku, barcode };
}

/**
 * Create ONE internal product from an external-only candidate through the approved
 * create core + inventory initializer. seedQuantity is fixed at 0.
 */
export async function importOneProduct(
  session: SessionClient,
  admin: AdminClient,
  candidate: ImportCandidate,
  ctx: ImportContext,
): Promise<ImportOne> {
  const built = buildImportInput(candidate, ctx);
  if ("error" in built) return { ok: false, error: built.error };

  let row: Record<string, unknown>;
  try {
    row = await toProductRow(built.input);
  } catch {
    return { ok: false, error: "invalid category or product shape" };
  }

  const core = await createProductCore(
    session as never,
    row,
    [], // simple product only — external-only imports carry no variant structure
    makeInventoryInitializer(admin as never),
    { seedQuantity: 0 },
  );
  if (!core.ok) {
    return { ok: false, error: core.stage ?? "create_failed", duplicate: core.duplicateIdentity === true };
  }
  return { ok: true, productId: core.productId, sku: built.sku, barcode: built.barcode };
}
