// FULL CATALOG EXCEL EXPORT — secure server route.
//
// Streams the COMPLETE canonical catalog as a four-sheet .xlsx. Nothing is
// filtered: the catalog page's search/filter/sort state never reaches here, so
// the download is always whole-database truth, not the current result page.
//
// SECURITY: gated by the existing Malak writer gate (signed in AND on the
// writer allow-list) and read through the CALLER'S Supabase session, so RLS
// applies exactly as it does on the page. No service-role key is used, and none
// of this runs on the client.
//
// READ-ONLY: only .select() is issued — no insert/update/delete/RPC, and no
// external channel call.

import { createRequire } from "node:module";
import { createClient } from "@/lib/supabase/server";
import { requireWriterGate } from "@/lib/auth/requireUser";
import { freezeTopRow } from "@/lib/net/xlsx-freeze";
import {
  buildFullCatalogSheets,
  columnWidths,
  fullCatalogFilename,
  FULL_CATALOG_SHEET_NAMES,
  type ExportImageRow,
  type ExportListingRow,
  type ExportLookupRow,
  type ExportProductRow,
  type ExportVariantRow,
} from "@/lib/catalog-v2/full-catalog-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE = 1000;
/** Hard ceiling per table so a runaway read can never exhaust memory. */
const MAX_ROWS = 200_000;

const LOAD_ERROR = "تعذر إنشاء ملف الكتالوج.";

type Client = ReturnType<typeof createClient>;

/**
 * Read an ENTIRE table through the caller's session, 1000 rows at a time.
 * Ordered by id so the pages tile deterministically and no row is skipped or
 * repeated. Throws on the first error — a partial catalog must never be
 * presented as a complete export.
 */
async function readAll<T>(client: Client, table: string, columns: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`read ${table} failed`);
    const page = (data ?? []) as unknown as T[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

const PRODUCT_COLUMNS =
  "id, sku, barcode, name_en, name_ar, description_en, description_ar, brand_id, main_category, sub_category," +
  " price, discount_price, cost, lifecycle_state, approval, rejection_reason, stock_status, stock_quantity," +
  " image_url, image_filename, product_type, color, size, keywords_en, keywords_ar, is_featured, is_promoted," +
  " has_buy1get1, notes, snoonu_id, pure_seoul_id, pure_seoul_status, rafeeq_product_id, platform_status," +
  " created_at, updated_at";

const IMAGE_COLUMNS = "id, product_id, url, filename, is_primary, sort_order, created_at";

const VARIANT_COLUMNS =
  "id, parent_product_id, variant_name, variant_name_en, sku, barcode, color, size, price," +
  " stock_quantity, stock_status, created_at";

const LISTING_COLUMNS =
  "id, product_id, channel_key, storefront_key, external_product_id, external_variant_id, identity_type," +
  " mapping_status, exported_sku, exported_barcode, variant_id, variant_sku, metadata, created_at, updated_at";

export async function GET() {
  const denied = await requireWriterGate();
  if (denied) return new Response(denied.error, { status: 403 });

  try {
    const client = createClient();
    const [products, images, variants, listings, brands, categories] = await Promise.all([
      readAll<ExportProductRow>(client, "products", PRODUCT_COLUMNS),
      readAll<ExportImageRow>(client, "product_images", IMAGE_COLUMNS),
      readAll<ExportVariantRow>(client, "product_variants", VARIANT_COLUMNS),
      readAll<ExportListingRow>(client, "external_channel_listings", LISTING_COLUMNS),
      readAll<ExportLookupRow>(client, "brands", "id, name"),
      readAll<ExportLookupRow>(client, "product_categories", "id, name"),
    ]);

    const sheets = buildFullCatalogSheets({ products, images, variants, listings, brands, categories });
    const ordered = [sheets.products, sheets.images, sheets.variants, sheets.listings];

    const require = createRequire(import.meta.url);
    const XLSX = require("xlsx");
    const wb = XLSX.utils.book_new();

    ordered.forEach((rows, i) => {
      // Every cell is written as an explicit TEXT cell. This is what stops Excel
      // from turning a 13-digit barcode into 8.19149E+12 or eating the leading
      // zero of `0429766714844`, and it keeps SPIs / GIDs / uuids byte-exact.
      const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: false });
      const ref = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
      for (let r = ref.s.r; r <= ref.e.r; r += 1) {
        for (let c = ref.s.c; c <= ref.e.c; c += 1) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = ws[addr];
          if (cell) {
            cell.t = "s";
            cell.z = "@";
          }
        }
      }
      ws["!cols"] = columnWidths(rows);
      ws["!autofilter"] = { ref: ws["!ref"] };
      XLSX.utils.book_append_sheet(wb, ws, FULL_CATALOG_SHEET_NAMES[i]);
    });

    // compression:false stores every part verbatim so freezeTopRow can rewrite
    // the sheet XML; it falls back to these bytes untouched if anything is off.
    const raw: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: false });
    const out = freezeTopRow(new Uint8Array(raw));
    // Hand the body over as a plain ArrayBuffer slice — an exact copy of the
    // workbook bytes, and a BodyInit the Response type accepts directly.
    const body = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;

    return new Response(body, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fullCatalogFilename(new Date())}"`,
        "Cache-Control": "no-store",
        "X-Catalog-Products": String(products.length),
        "X-Catalog-Images": String(images.length),
        "X-Catalog-Variants": String(variants.length),
        "X-Catalog-Listings": String(listings.length),
      },
    });
  } catch {
    // Never surface a raw database error, message, code or stack.
    return new Response(LOAD_ERROR, { status: 500 });
  }
}
