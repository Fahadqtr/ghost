import "server-only";
import { reconcileProduct, classifyRepairs, type ReconcileInput, type ReconcileResult, type ReconcileIssueCode, type RepairItem } from "./reconcile-compute.ts";

// Production-Reconciliation — GLOBAL read-only reconciliation scanner.
//
// Scans ALL products in pages (bulk reads, no N+1), reconciles each product with
// the pure reconcile-compute model, and aggregates the verdict. Also runs GLOBAL
// orphan checks (shelf rows pointing at a missing inventory / variant). Performs
// NO writes, never reads products.stock_quantity, never touches availability.
//
// completeness: if ANY read fails the scan is marked incomplete — the caller must
// NOT interpret an incomplete scan as "zero drift".
//
// Dependency-injected `admin` client (service-role or RLS) so it is testable with
// a fake; the real caller passes the Supabase admin client.

export interface ScanIssue {
  productId: string;
  code: ReconcileIssueCode;
  variantId?: string;
  got?: number | string | null;
  want?: number | string | null;
}

export interface ReconciliationScanResult {
  complete: boolean;
  productsTotal: number;
  cleanProducts: number;
  driftProducts: number;
  inconsistentProducts: number;
  issueCounts: Record<string, number>;
  issues: ScanIssue[];
  repairs: RepairItem[];
  orphanShelfStock: number;
  orphanVariantShelfStock: number;
  error?: string;
}

interface InvRow { id: string; product_id: string; stock_quantity: number | null; sold_quantity: number | null; location: string | null }
interface VarRow { id: string; parent_product_id: string; stock_quantity: number | null }
interface ShelfRow { id: string; inventory_id: string; location: string | null; quantity: number | null }
interface VShelfRow { id: string; variant_id: string; location: string | null; quantity: number | null }

const PAGE = 500;

/** Fetch every row of a table for a set of ids, chunked by an `in` filter. */
async function fetchIn<T>(admin: any, table: string, cols: string, col: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await admin.from(table).select(cols).in(col, ids.slice(i, i + 300));
    if (error) throw new Error(`${table}: ${error.message ?? "read failed"}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export async function scanReconciliation(admin: any, opts?: { pageSize?: number }): Promise<ReconciliationScanResult> {
  const pageSize = opts?.pageSize && opts.pageSize > 0 ? opts.pageSize : PAGE;
  const issueCounts: Record<string, number> = {};
  const issues: ScanIssue[] = [];
  const repairs: RepairItem[] = [];
  let productsTotal = 0, cleanProducts = 0, driftProducts = 0, inconsistentProducts = 0;

  try {
    // ── paginate products, bulk-read the four stock tables per page ────────────
    for (let from = 0; ; from += pageSize) {
      const { data: prods, error } = await admin
        .from("products").select("id").order("id", { ascending: true }).range(from, from + pageSize - 1);
      if (error) return incomplete(`products: ${error.message ?? "read failed"}`);
      const rows = (prods ?? []) as { id: string }[];
      if (rows.length === 0) break;
      const pids = rows.map((r) => r.id);

      const inv = await fetchIn<InvRow>(admin, "inventory", "id, product_id, stock_quantity, sold_quantity, location", "product_id", pids);
      const vars = await fetchIn<VarRow>(admin, "product_variants", "id, parent_product_id, stock_quantity", "parent_product_id", pids);
      const invIds = inv.map((r) => r.id);
      const varIds = vars.map((r) => r.id);
      const pshelf = invIds.length ? await fetchIn<ShelfRow>(admin, "shelf_stock", "id, inventory_id, location, quantity", "inventory_id", invIds) : [];
      const vshelf = varIds.length ? await fetchIn<VShelfRow>(admin, "variant_shelf_stock", "id, variant_id, location, quantity", "variant_id", varIds) : [];

      // group
      const invByProd = new Map<string, InvRow[]>();
      for (const r of inv) (invByProd.get(r.product_id) ?? invByProd.set(r.product_id, []).get(r.product_id)!).push(r);
      const varByProd = new Map<string, VarRow[]>();
      for (const r of vars) (varByProd.get(r.parent_product_id) ?? varByProd.set(r.parent_product_id, []).get(r.parent_product_id)!).push(r);
      const invIdToProd = new Map(inv.map((r) => [r.id, r.product_id]));
      const varIdToProd = new Map(vars.map((r) => [r.id, r.parent_product_id]));
      const shelfByProd = new Map<string, ShelfRow[]>();
      for (const r of pshelf) { const p = invIdToProd.get(r.inventory_id); if (p) (shelfByProd.get(p) ?? shelfByProd.set(p, []).get(p)!).push(r); }
      const vshelfByProd = new Map<string, VShelfRow[]>();
      for (const r of vshelf) { const p = varIdToProd.get(r.variant_id); if (p) (vshelfByProd.get(p) ?? vshelfByProd.set(p, []).get(p)!).push(r); }

      for (const p of pids) {
        productsTotal++;
        const input: ReconcileInput = {
          productId: p,
          inventoryRows: (invByProd.get(p) ?? []).map((r) => ({ id: r.id, stock_quantity: r.stock_quantity, sold_quantity: r.sold_quantity, location: r.location })),
          variants: (varByProd.get(p) ?? []).map((r) => ({ id: r.id, stock_quantity: r.stock_quantity })),
          shelfStock: (shelfByProd.get(p) ?? []).map((r) => ({ id: r.id, location: r.location, quantity: r.quantity })),
          variantShelfStock: (vshelfByProd.get(p) ?? []).map((r) => ({ id: r.id, variant_id: r.variant_id, location: r.location, quantity: r.quantity })),
        };
        const res: ReconcileResult = reconcileProduct(input);
        if (res.status === "clean") cleanProducts++;
        else if (res.status === "drift") driftProducts++;
        else inconsistentProducts++;
        for (const iss of res.issues) {
          issueCounts[iss.code] = (issueCounts[iss.code] ?? 0) + 1;
          issues.push({ productId: p, code: iss.code, variantId: iss.variantId, got: iss.got, want: iss.want });
        }
        if (res.issues.length) repairs.push(...classifyRepairs(res, input));
      }

      if (rows.length < pageSize) break;
    }

    // ── GLOBAL orphan checks (best a small count; FK usually prevents them) ─────
    const orphanShelfStock = await countOrphans(admin, "shelf_stock", "inventory_id", "inventory");
    const orphanVariantShelfStock = await countOrphans(admin, "variant_shelf_stock", "variant_id", "product_variants");
    if (orphanShelfStock === null || orphanVariantShelfStock === null) return incomplete("orphan scan failed");
    issueCounts["orphan_shelf_stock"] = orphanShelfStock;
    issueCounts["orphan_variant_shelf_stock"] = orphanVariantShelfStock;

    return {
      complete: true, productsTotal, cleanProducts, driftProducts, inconsistentProducts,
      issueCounts, issues, repairs, orphanShelfStock, orphanVariantShelfStock,
    };
  } catch (e) {
    return incomplete(e instanceof Error ? e.message : "scan failed");
  }

  function incomplete(error: string): ReconciliationScanResult {
    return {
      complete: false, productsTotal, cleanProducts, driftProducts, inconsistentProducts,
      issueCounts, issues, repairs, orphanShelfStock: 0, orphanVariantShelfStock: 0, error,
    };
  }
}

/** Count child rows whose parent id is absent. Returns null on read failure. */
async function countOrphans(admin: any, childTable: string, fkCol: string, parentTable: string): Promise<number | null> {
  try {
    let orphans = 0;
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from(childTable).select(`id, ${fkCol}`).range(from, from + 999);
      if (error) return null;
      const rows = (data ?? []) as Record<string, string>[];
      if (rows.length === 0) break;
      const ids = Array.from(new Set(rows.map((r) => r[fkCol]).filter(Boolean)));
      const present = new Set<string>();
      for (let i = 0; i < ids.length; i += 300) {
        const { data: p, error: e2 } = await admin.from(parentTable).select("id").in("id", ids.slice(i, i + 300));
        if (e2) return null;
        for (const x of (p ?? []) as { id: string }[]) present.add(x.id);
      }
      for (const r of rows) if (r[fkCol] && !present.has(r[fkCol])) orphans++;
      if (rows.length < 1000) break;
    }
    return orphans;
  } catch {
    return null;
  }
}
