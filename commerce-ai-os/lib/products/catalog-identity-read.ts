// Identity snapshot reader for the AI product creator (Phase UI.5).
//
// ONE paged read of the columns needed by all three checks — the next-mk scan
// (products.sku AND product_variants.sku, unlike the legacy nextProductSku
// which scans products only), the barcode uniqueness set, and duplicate
// detection. Injected session client, whitelisted columns, page size and hard
// caps in the style of lib/catalog-v2/master-catalog-read.ts. server-only.

import "server-only";

import type { IdentityRow } from "./duplicate-detect";

const PAGE = 1000;
const PRODUCT_CAP = 20000;
const VARIANT_CAP = 40000;

const PRODUCT_COLUMNS = "id, sku, barcode, name_en, name_ar, size, color";
const VARIANT_COLUMNS = "id, sku, barcode, variant_name, variant_name_en, size, color";

interface IdentityReadClient {
  from(table: string): {
    select(columns: string): {
      order(
        column: string,
        opts: { ascending: boolean },
      ): {
        range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
      };
    };
  };
}

export interface IdentitySnapshot {
  rows: IdentityRow[];
  skus: string[];
  barcodes: Set<string>;
  partial: boolean;
}

export type IdentitySnapshotResult =
  | { status: "ok"; snapshot: IdentitySnapshot }
  | { status: "error" };

function fieldStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

async function readAll(
  client: IdentityReadClient,
  table: string,
  columns: string,
  cap: number,
): Promise<Record<string, unknown>[] | null> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return null;
    for (const r of data ?? []) {
      if (typeof r === "object" && r !== null) out.push(r as Record<string, unknown>);
    }
    if ((data ?? []).length < PAGE) return out;
  }
  return out; // cap reached; caller marks partial
}

/** Load the full identity snapshot. status:"error" on ANY read failure. */
export async function loadIdentitySnapshot(
  client: IdentityReadClient,
): Promise<IdentitySnapshotResult> {
  try {
    const products = await readAll(client, "products", PRODUCT_COLUMNS, PRODUCT_CAP);
    if (products === null) return { status: "error" };
    const variants = await readAll(client, "product_variants", VARIANT_COLUMNS, VARIANT_CAP);
    if (variants === null) return { status: "error" };

    const rows: IdentityRow[] = [];
    const skus: string[] = [];
    const barcodes = new Set<string>();

    for (const p of products) {
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) continue;
      const sku = fieldStr(p.sku);
      const barcode = fieldStr(p.barcode);
      if (sku) skus.push(sku);
      if (barcode) barcodes.add(barcode.trim());
      rows.push({
        id,
        kind: "product",
        sku,
        barcode,
        nameEn: fieldStr(p.name_en),
        nameAr: fieldStr(p.name_ar),
        size: fieldStr(p.size),
        color: fieldStr(p.color),
      });
    }
    for (const v of variants) {
      const id = typeof v.id === "string" ? v.id : null;
      if (!id) continue;
      const sku = fieldStr(v.sku);
      const barcode = fieldStr(v.barcode);
      if (sku) skus.push(sku);
      if (barcode) barcodes.add(barcode.trim());
      rows.push({
        id,
        kind: "variant",
        sku,
        barcode,
        nameEn: fieldStr(v.variant_name_en),
        nameAr: fieldStr(v.variant_name),
        size: fieldStr(v.size),
        color: fieldStr(v.color),
      });
    }

    return {
      status: "ok",
      snapshot: {
        rows,
        skus,
        barcodes,
        partial: products.length >= PRODUCT_CAP || variants.length >= VARIANT_CAP,
      },
    };
  } catch {
    return { status: "error" };
  }
}
