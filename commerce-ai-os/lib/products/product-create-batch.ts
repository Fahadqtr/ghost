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

import { inventorySeed } from "./inventory-seed.ts";

type WriteError = { code?: string; message: string };

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

    // 1. Insert the chunk's product rows in one atomic statement.
    const { data, error } = await client.from("products").insert(chunk as Record<string, unknown>[]).select("id");
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

    // 3. Seed one inventory row per created product.
    const invRows = ids.map((product_id, i) => ({
      product_id,
      ...inventorySeed(opts?.seedQuantity ?? ((chunk[i]?.stock_quantity as number | null) ?? 0)),
    }));
    const invErr = (await client.from("inventory").insert(invRows)).error;

    if (!invErr) {
      // 4. Inventory succeeded → count the chunk as added.
      added += ids.length;
      continue;
    }

    // 5. Inventory failed → compensating delete of ONLY this chunk's products.
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
