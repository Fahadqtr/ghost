import Link from "next/link";
import { getVoucher } from "@/lib/loyalty/rewards";
import BrandLogo from "@/components/BrandLogo";
import VoucherActions from "./VoucherActions";

export const dynamic = "force-dynamic";

// Printable prize voucher for a customer who completed their card ("won").
// Shows the prize, the customer, and a voucher code — the owner prints it to
// include with the order, and can fire the WhatsApp confirmation from here.
export default async function VoucherPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let voucher: Awaited<ReturnType<typeof getVoucher>> | null = null;
  let error: string | null = null;
  try {
    voucher = await getVoucher(id);
  } catch (e: any) {
    error = e?.message ?? "تعذّر تحميل القسيمة.";
  }

  if (error || !voucher) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <Link href="/loyalty" className="text-sm text-slate-500 hover:text-slate-700">
          ← رجوع
        </Link>
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {error ?? "غير موجودة."}
        </div>
      </div>
    );
  }

  const issued = voucher.issuedAt.slice(0, 10);

  return (
    <div className="mx-auto max-w-lg p-4 sm:p-6">
      <div data-no-print className="mb-2">
        <Link href="/loyalty" className="text-sm text-slate-500 hover:text-slate-700">
          ← رجوع
        </Link>
      </div>

      <VoucherActions customerId={voucher.customerId} />

      {!voucher.ready && (
        <p data-no-print className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
          ⚠️ هذه الزبونة لم تكمل الختمات بعد — القسيمة للعرض فقط.
        </p>
      )}

      {/* printable voucher */}
      <div
        className="qr-print rounded-3xl border-2 border-[#d9b45f] bg-white p-8 text-center"
        style={{ boxShadow: "0 20px 50px -20px rgba(180,120,90,.4)" }}
      >
        <BrandLogo className="mx-auto h-14 w-auto text-[#1f1a17]" />
        <p className="mt-1 text-[11px] font-semibold tracking-[0.35em] text-[#c9a24b]">
          MALIKA&apos;S UNIVERSE
        </p>

        <h1 className="mt-4 text-2xl font-bold text-[#d17c93]">🎁 قسيمة جائزة</h1>
        <p className="mt-1 text-sm text-[#6b5b4b]">
          مبروك <b className="text-[#d17c93]">{voucher.name}</b> — أكملتِ بطاقة مكافآت الجمال!
        </p>

        {voucher.prizeImage ? (
          <div className="mx-auto mt-5 w-48 overflow-hidden rounded-2xl border border-[#f0dcc6]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={voucher.prizeImage}
              alt={voucher.prizeName ?? "الجائزة"}
              className="aspect-square w-full object-cover"
            />
          </div>
        ) : (
          <p className="mt-5 text-sm text-[#8a7a6a]">أي منتج من المتجر مجاناً</p>
        )}

        {voucher.prizeName && (
          <p className="mt-3 text-lg font-bold text-[#1f1a17]">{voucher.prizeName}</p>
        )}

        <div className="mx-auto mt-5 w-fit rounded-xl bg-[#fbeef0] px-5 py-2">
          <p className="text-[11px] text-[#8a7a6a]">رقم القسيمة</p>
          <p dir="ltr" className="text-lg font-bold tracking-wider text-[#d17c93]">
            {voucher.code}
          </p>
        </div>

        <p className="mt-4 text-xs text-[#b58aa0]">
          التاريخ: {issued} · أبرزي هذه القسيمة عند الاستلام
        </p>
      </div>
    </div>
  );
}
