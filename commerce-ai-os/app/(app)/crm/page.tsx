import { listCustomers } from "./actions";
import CrmClient from "./CrmClient";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // paging Shopify customers can take a moment

export default async function CrmPage() {
  const { error, rows, counts, shopifyNote } = await listCustomers();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <CrmClient rows={rows} counts={counts} shopifyNote={shopifyNote} />
      )}
    </div>
  );
}
