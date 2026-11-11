import Link from "next/link";
import { listAllPrizes } from "@/lib/loyalty/rewards";
import PrizesClient from "./PrizesClient";

export const dynamic = "force-dynamic";

// Owner manages the prizes customers can win: add (image + name), show/hide,
// delete. Active prizes appear on the public /rewards card.
export default async function LoyaltyPrizesPage() {
  let prizes: Awaited<ReturnType<typeof listAllPrizes>> = [];
  let error: string | null = null;
  try {
    prizes = await listAllPrizes();
  } catch (e: any) {
    error = e?.message ?? "تعذّر تحميل الجوائز.";
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">جوائز مكافآت الجمال</h1>
          <p className="text-sm text-slate-500">
            الجوائز المُفعّلة تظهر للزبائن، وتختار الزبونة وحدة منها بعد إكمال البطاقة.
          </p>
        </div>
        <Link
          href="/v2/loyalty"
          className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          ← المراجعة
        </Link>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {error}
          <p className="mt-2 text-xs text-amber-700">
            نفّذي ملف <code>supabase/loyalty_prizes.sql</code> مرة واحدة لتفعيل الجوائز.
          </p>
        </div>
      ) : (
        <PrizesClient prizes={prizes} />
      )}
    </div>
  );
}
