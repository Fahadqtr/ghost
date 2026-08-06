// Pure variant diff planner (Phase UI.3D.0).
//
// Turns "the variants that exist in the database" plus "the variants the form
// submitted" into an explicit plan: which rows keep their UUID and are updated,
// which are inserted, and which are deleted.
//
// This replaces the old delete-everything-then-reinsert strategy, under which
// `product_variants.id` changed on every product save. Anything that stores a
// variant id (today: variant_shelf_stock, which has no foreign key) was
// silently orphaned by that churn.
//
// DB-free, network-free, framework-free: no Supabase, no server-only, no fetch,
// no `any`. Every rule below is a pure function of its two inputs so it can be
// unit-tested exhaustively.
//
// Hard rules:
//   * a submitted non-empty id that is NOT in the authoritative set aborts the
//     whole plan — it is never quietly turned into a new variant, because that
//     would mask both a genuine bug (stale form) and tampering behind a
//     plausible-looking success;
//   * a client-supplied id is never used for an INSERT — new rows always get a
//     database-generated UUID;
//   * the same existing id may not be claimed twice in one submission.

/** A variant row as submitted by the form. Mirrors VariantInput structurally. */
export interface SubmittedVariant {
  id?: string;
  variant_name?: string;
  variant_name_en?: string;
  sku?: string;
  barcode?: string;
  color?: string;
  size?: string;
  price?: string;
  stock_quantity?: string;
}

/** The catalog-safe fields carried into an update or an insert. */
export interface VariantFields {
  variant_name: string;
  variant_name_en: string;
  sku: string;
  barcode: string;
  color: string;
  size: string;
  price: number | null;
  stock_quantity: number | null;
}

export interface VariantUpdate extends VariantFields {
  /** Always an id proven to belong to this product. */
  id: string;
}

export type VariantInsert = VariantFields;

export interface VariantDiffPlan {
  updates: VariantUpdate[];
  inserts: VariantInsert[];
  /** Ids present in the database but absent from the submission. */
  deletes: string[];
}

export type VariantDiffResult =
  | { ok: true; plan: VariantDiffPlan }
  | { ok: false; error: VariantDiffErrorCode };

/** Fixed error codes — the caller maps these to fixed user-facing strings. */
export type VariantDiffErrorCode = "unknown_variant_id" | "duplicate_variant_id";

// ── Field normalization (mirrors the existing toVariantRows behaviour) ───────

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A submitted row is real only if it carries a name or a SKU. */
function isMeaningful(v: SubmittedVariant): boolean {
  return str(v.variant_name).length > 0 || str(v.variant_name_en).length > 0 || str(v.sku).length > 0;
}

function toFields(v: SubmittedVariant): VariantFields {
  return {
    variant_name: str(v.variant_name),
    variant_name_en: str(v.variant_name_en),
    sku: str(v.sku),
    barcode: str(v.barcode),
    color: str(v.color),
    size: str(v.size),
    price: num(v.price),
    stock_quantity: num(v.stock_quantity),
  };
}

/** A usable id: a non-empty trimmed string. Anything else counts as "no id". */
function submittedId(v: SubmittedVariant): string | null {
  const id = str(v.id);
  return id.length > 0 ? id : null;
}

// ── Planner ──────────────────────────────────────────────────────────────────

/**
 * Build the update/insert/delete plan.
 *
 * `existingIds` is the AUTHORITATIVE set, read server-side from
 * `product_variants where parent_product_id = <this product>`. It is the only
 * source of trusted ids; nothing from the client is believed.
 *
 * A submitted row that carries no id, or that is dropped for being empty, never
 * contributes an id to the plan — so a client cannot smuggle one in.
 */
export function planVariantDiff(
  existingIds: readonly string[],
  submitted: readonly SubmittedVariant[],
): VariantDiffResult {
  const authoritative = new Set<string>();
  for (const id of Array.isArray(existingIds) ? existingIds : []) {
    if (typeof id === "string" && id.trim().length > 0) authoritative.add(id.trim());
  }

  const rows = Array.isArray(submitted) ? submitted : [];
  const updates: VariantUpdate[] = [];
  const inserts: VariantInsert[] = [];
  const seen = new Set<string>(); // every id the submission mentions (duplicate check)
  const retained = new Set<string>(); // ids that survive this save

  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const id = submittedId(row);

    // Validate the id BEFORE the emptiness check: a hostile or stale id must be
    // rejected even when the row carries no usable content, otherwise dropping
    // the row would hide the problem.
    if (id !== null) {
      if (!authoritative.has(id)) return { ok: false, error: "unknown_variant_id" };
      if (seen.has(id)) return { ok: false, error: "duplicate_variant_id" };
      seen.add(id);
    }

    // A row the operator blanked out is a removal, not a no-op. This matches the
    // previous behaviour, where such a row was filtered out of the re-insert and
    // therefore disappeared — except now it is a targeted delete of that one id.
    if (!isMeaningful(row)) continue;

    if (id !== null) {
      retained.add(id);
      updates.push({ id, ...toFields(row) });
    } else {
      inserts.push(toFields(row)); // id is never taken from the client
    }
  }

  // Anything the database has that this save no longer retains is removed.
  const deletes: string[] = [];
  for (const id of authoritative) {
    if (!retained.has(id)) deletes.push(id);
  }
  deletes.sort();

  return { ok: true, plan: { updates, inserts, deletes } };
}
