// createProductsBatchCore — the shared BATCH create path (P7/P8) for the bulk
// platform importers (Snoonu, Pure Seoul). It is the batch sibling of the
// single-product createProductCore: given already-mapped, already-deduped product
// rows, it inserts them in chunks, seeds one inventory row per created product,
// and — the reason it exists — COMPENSATES per chunk if a chunk's inventory seed
// fails, deleting only that chunk's just-created products so no orphan survives.
//
// Rollback boundary is PER CHUNK, deliberately (not per row, not whole-import):
// the importers already insert in atomic chunks of 200 and CONTINUE past a failed
// chunk, so per-chunk compensation adds the missing rollback without changing
// chunk sizing or the partial-success/continuation semantics.
//
// CLIENT-AGNOSTIC: never constructs a client — operates on the injected
// ProductBatchClient (the importers inject their admin client; they have no RLS
// session). The core does NOT generate SKUs/barcodes, dedup, fuzzy-match, map
// rows, revalidate routes, or decide the wrapper's response `ok` — all of that
// stays in the wrapper. No RPC; the only import is the pure inventory-seed sibling.

import { isValidSeedQuantity } from "./inventory-seed.ts";

type WriteError = { code?: string; message: string };

// INV.6B — injected service-role batch initializer (backed by the atomic
// inv_initialize_simple_products RPC). The batch core no longer inserts inventory
// rows directly (impossible after the strict ACL lockdown); it inserts the product
// chunk, then initializes those products' authoritative inventory through this
// callback. All-or-nothing PER CALL (one chunk): every target initializes or none.
export type InitializeSimpleProducts = (
  targets: { productId: string; stockQuantity: number }[],
) => Promise<{ ok: true } | { ok: false }>;

export interface ProductBatchClient {
  from(table: string): {
    insert(values: Record<string, unknown>[]): {
      select(columns: string): PromiseLike<{ data: { id: string }[] | null; error: WriteError | null }>;
    } & PromiseLike<{ error: WriteError | null }>;
    delete(): {
      in(column: string, values: readonly string[]): PromiseLike<{ error: unknown }>;
    };
  };
}

export interface CreateProductsBatchOptions {
  /** Rows per insert statement. Default 200 (matches the importers). */
  chunkSize?: number;
  /** Inventory seed stock for every row. Default: each row's stock_quantity ?? 0. */
  seedQuantity?: number;
}

export interface CreateProductsBatchResult {
  /** Number of product rows successfully created AND inventory-seeded. */
  added: number;
  /** Number of input rows that failed (product-chunk error, or rolled back). */
  failed: number;
  /** Indexes into the input `rows` that failed (product-chunk error or rollback). */
  failedIndexes: number[];
  /**
   * Compensation status across the run:
   *  - "not_needed": no chunk needed a rollback,
   *  - "done": every rollback that ran succeeded,
   *  - "failed": at least one compensating delete failed (possible orphans — the
   *    wrapper should log; never a raw DB error is exposed).
   */
  cleanup: "not_needed" | "done" | "failed";
}

/**
 * Insert product rows in chunks; per chunk: insert products → seed inventory →
 * on inventory failure, delete that chunk's products and mark them failed, then
 * continue. Earlier successful chunks are never touched; the import never aborts.
 * `rows` must already be projected/deduped; the core never mutates them.
 */
export async function createProductsBatchCore(
  client: ProductBatchClient,
  rows: readonly Record<string, unknown>[],
  initializeSimple: InitializeSimpleProducts,
  opts?: CreateProductsBatchOptions,
): Promise<CreateProductsBatchResult> {
  const chunkSize = opts?.chunkSize && opts.chunkSize > 0 ? opts.chunkSize : 200;
  let added = 0;
  let failed = 0;
  const failedIndexes: number[] = [];
  let cleanup: "not_needed" | "done" | "failed" = "not_needed";

  const markChunkFailed = (start: number, count: number) => {
    failed += count;
    for (let i = 0; i < count; i++) failedIndexes.push(start + i);
  };

  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);

    // INV.4E/6B — the products.stock_quantity mirror is RETIRED. Capture each row's
    // requested starting stock (a FORM field) for the authoritative inventory seed
    // BEFORE the insert, then strip stock_quantity from every product row. `chunk`
    // (a slice of the caller's rows) is not mutated; fresh objects are inserted.
    const seedQtys = chunk.map((r) => opts?.seedQuantity ?? ((r.stock_quantity as number | null) ?? 0));

    // INV.6B — validate every seed BEFORE inserting any product row. A malformed
    // seed (negative / fractional / NaN / Infinity / int4-overflow) fails the whole
    // chunk before insert (nothing written; per-chunk continuation preserved).
    if (!seedQtys.every((q) => isValidSeedQuantity(q))) {
      markChunkFailed(start, chunk.length);
      continue;
    }

    const productRows = chunk.map((r) => {
      const { stock_quantity: _mirrorOmit, ...rest } = r as Record<string, unknown>;
      return rest;
    });

    // 1. Insert the chunk's product rows in one atomic statement.
    const { data, error } = await client.from("products").insert(productRows).select("id");
    if (error || !data) {
      // Product chunk failed → nothing was written, nothing to compensate.
      markChunkFailed(start, chunk.length);
      continue;
    }

    // 2. Collect the newly-created ids.
    const ids = data.map((d) => d.id).filter((id): id is string => typeof id === "string");
    if (ids.length === 0) {
      markChunkFailed(start, chunk.length);
      continue;
    }

    // 3. Initialize authoritative inventory for the created products via the atomic
    //    service-role RPC (positional: ids[i] ↔ chunk[i]). No direct inventory insert.
    const targets = ids.map((productId, i) => ({ productId, stockQuantity: seedQtys[i] ?? 0 }));
    const init = await initializeSimple(targets);

    if (init.ok) {
      // 4. Initialization succeeded → count the chunk as added.
      added += ids.length;
      continue;
    }

    // 5. Initialization failed → compensating delete of ONLY this chunk's products
    //    (FK cascade removes any auto-seed inventory rows).
    let delOk = true;
    try {
      const r = await client.from("products").delete().in("id", ids);
      if (r.error) delOk = false;
    } catch {
      delOk = false;
    }
    if (!delOk) cleanup = "failed";
    else if (cleanup !== "failed") cleanup = "done";
    markChunkFailed(start, chunk.length);
  }

  return { added, failed, failedIndexes, cleanup };
}
