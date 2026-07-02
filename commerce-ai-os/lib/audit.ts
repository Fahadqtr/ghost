// Shared malak_audit insert that heals a legacy schema drift.
//
// Production's malak_audit was renamed from the old `audit_log` table, whose
// product_id column is a LEGACY BIGINT — while products.id is uuid. Writers
// therefore historically avoided the column and kept the product uuid only
// inside details.productId (unindexed JSON).
//
// After running supabase/malak_audit_product_id_uuid.sql the column is uuid and
// this helper writes it directly. On an UNMIGRATED database the first insert
// fails with a type/column error (22P02 uuid-into-bigint, or 42703 missing
// column) and we retry without product_id — exactly the old behavior, with the
// uuid still preserved in details. So code and migration can ship in any order.
//
// Audit writes are best-effort by design: callers log the returned error but
// never fail the underlying business write because of it.

type InsertResult = { error: { message?: string; code?: string } | null };
export type AuditAdmin = {
  from(table: string): { insert(row: Record<string, unknown>): PromiseLike<InsertResult> };
};

// Postgres codes that mean "the product_id column can't take a uuid here":
// 22P02 invalid_text_representation (uuid string into the legacy bigint),
// 42703 undefined_column (very old table without the column at all).
const COLUMN_MISMATCH = /^(22P02|42703)$/;

export async function insertAuditRow(
  admin: AuditAdmin,
  row: Record<string, unknown> & { product_id?: string | null }
): Promise<InsertResult> {
  const { product_id, ...bare } = row;
  if (product_id == null) return admin.from("malak_audit").insert(bare);

  const first = await admin.from("malak_audit").insert({ ...bare, product_id });
  if (first.error && COLUMN_MISMATCH.test(String(first.error.code ?? ""))) {
    return admin.from("malak_audit").insert(bare); // unmigrated DB → legacy shape
  }
  return first;
}
