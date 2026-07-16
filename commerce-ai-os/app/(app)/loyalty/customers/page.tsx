import Link from "next/link";
import { listCustomers, STAMPS_REQUIRED } from "@/lib/loyalty/rewards";

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
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-800">زبائن مكافآت الجمال</h1>
          <p className="text-sm text-slate-500">
            {rows.length} زبونة · {totalHearts} ختمة حالية · {totalRewards} هدية مُستبدَلة
          </p>
        </div>
        <Link
          href="/loyalty"
          className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          ← المراجعة
        </Link>
      </div>

      {/* search (plain GET form — no client JS needed) */}
      <form className="mb-4 flex gap-2" action="/loyalty/customers" method="get">
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
            href="/loyalty/customers"
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
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full text-right text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">الاسم</th>
                <th className="px-4 py-3 font-semibold">رقم الجوال</th>
                <th className="px-4 py-3 font-semibold">القلوب</th>
                <th className="px-4 py-3 font-semibold">الهدايا</th>
                <th className="px-4 py-3 font-semibold">آخر نشاط</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-4 py-3 font-semibold text-slate-800">
                    {r.name}
                    {r.rewardReady && (
                      <span className="mr-2 rounded-full bg-pink-100 px-2 py-0.5 text-[10px] font-bold text-pink-700">
                        🎁 جاهزة
                      </span>
                    )}
                  </td>
                  <td dir="ltr" className="px-4 py-3 text-right text-slate-500">{r.phone}</td>
                  <td className="px-4 py-3">
                    <span className="whitespace-nowrap" title={`${r.stamps} من ${STAMPS_REQUIRED}`}>
                      {"❤".repeat(r.stamps)}
                      <span className="text-slate-200">{"❤".repeat(STAMPS_REQUIRED - r.stamps)}</span>
                      <span className="ms-1 text-xs text-slate-400">
                        {r.stamps}/{STAMPS_REQUIRED}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.cyclesCompleted}</td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {new Date(r.updatedAt).toLocaleDateString("ar")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
