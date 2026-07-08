import "server-only";

// Talabat gets new products by EMAIL, not by dashboard entry — so instead of a
// staff task, an approved product waits in talabat_queue until the owner sends
// the sheet+images email from /import-export/talabat-sync. Strictly
// best-effort: a queue failure must never block the approval that caused it.

export async function queueForTalabat(admin: any, productId: string): Promise<void> {
  try {
    const { error } = await admin
      .from("talabat_queue")
      .upsert({ product_id: productId }, { onConflict: "product_id", ignoreDuplicates: true });
    // Table not created yet → stay silent; the Talabat page shows the SQL hint.
    if (error && !/talabat_queue/i.test(error.message)) {
      console.error("[talabat-queue]", error.message);
    }
  } catch (e) {
    console.error("[talabat-queue]", e instanceof Error ? e.message : e);
  }
}
