import { listCustomers } from "./actions";
import CrmClient from "./CrmClient";
import CrmInsights from "./CrmInsights";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // paging Shopify customers can take a moment

export default async function CrmPage() {
  const { locale } = await getT();
  const { error, rows, counts, shopifyNote, stats } = await listCustomers();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <>
          {stats.buyers > 0 ? <CrmInsights stats={stats} locale={locale} /> : null}
          <CrmClient rows={rows} counts={counts} shopifyNote={shopifyNote} locale={locale} />
        </>
      )}
    </div>
  );
}
