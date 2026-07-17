import Link from "next/link";
import { listPending, listRewardReady, STAMPS_REQUIRED } from "@/lib/loyalty/rewards";
import LoyaltyClient from "./LoyaltyClient";

export const dynamic = "force-dynamic";

// Owner/staff view of the Beauty Rewards program: review the Snoonu-review
// screenshots customers uploaded (approve = stamp a heart, reject = no heart),
// and redeem completed cards. The customer-facing card + QR target live at the
// public /rewards route.
export default async function LoyaltyAdminPage() {
  let pending: Awaited<ReturnType<typeof listPending>> = [];
  let ready: Awaited<ReturnType<typeof listRewardReady>> = [];
  let error: string | null = null;
  try {
    [pending, ready] = await Promise.all([listPending(), listRewardReady()]);
  } catch (e: any) {
    error = e?.message ?? "تعذّر تحميل البيانات.";
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-800">مكافآت الجمال</h1>
          <p className="text-sm text-slate-500">
            راجعي صور تقييمات سنونو — كل اعتماد يختم ختمة. تكتمل {STAMPS_REQUIRED} = هدية.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Link
            href="/loyalty/prizes"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            🎁 الجوائز
          </Link>
          <Link
            href="/loyalty/customers"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            👥 الزبائن
          </Link>
          <Link
            href="/loyalty/cards"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            🖨️ بطاقات الطلبات
          </Link>
          <Link
            href="/loyalty/qr"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            🔳 باركود الطباعة
          </Link>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {error}
          <p className="mt-2 text-xs text-amber-700">
            تأكدي من تنفيذ ملف <code>supabase/loyalty_rewards.sql</code> وإعداد مفتاح الخدمة.
          </p>
        </div>
      ) : (
        <LoyaltyClient pending={pending} ready={ready} required={STAMPS_REQUIRED} />
      )}
    </div>
  );
}
