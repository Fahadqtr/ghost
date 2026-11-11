import Link from "next/link";
import { listCustomers, STAMPS_REQUIRED } from "@/lib/loyalty/rewards";
import CustomersTable from "./CustomersTable";

export const dynamic = "force-dynamic";

// Owner view of every Beauty Rewards customer: name, phone, current hearts,
// and how many free products they've earned over time. Read-only, with a simple
// name/phone search.
export default async function LoyaltyCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  let rows: Awaited<ReturnType<typeof listCustomers>> = [];
  let error: string | null = null;
  try {
    rows = await listCustomers(q);
  } catch (e: any) {
    error = e?.message ?? "تعذّر تحميل البيانات.";
  }

  const totalHearts = rows.reduce((s, r) => s + r.stamps, 0);
  const totalRewards = rows.reduce((s, r) => s + r.cyclesCompleted, 0);

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">زبائن مكافآت الجمال</h1>
          <p className="text-sm text-slate-500">
            {rows.length} زبونة · {totalHearts} ختمة حالية · {totalRewards} هدية مُستبدَلة
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          <a
            href="/api/loyalty/customers/export"
            className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"
          >
            ⬇️ تصدير Excel
          </a>
          <Link
            href="/v2/loyalty"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            ← المراجعة
          </Link>
        </div>
      </div>

      {/* search (plain GET form — no client JS needed) */}
      <form className="mb-4 flex gap-2" action="/v2/loyalty/customers" method="get">
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="بحث بالاسم أو رقم الجوال…"
          className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm outline-none focus:border-pink-300"
        />
        <button className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
          بحث
        </button>
        {q ? (
          <Link
            href="/v2/loyalty/customers"
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-500 hover:bg-slate-50"
          >
            مسح
          </Link>
        ) : null}
      </form>

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {error}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
          {q ? "لا نتائج مطابقة." : "لا يوجد زبائن بعد."}
        </p>
      ) : (
        <CustomersTable rows={rows} required={STAMPS_REQUIRED} />
      )}
    </div>
  );
}
