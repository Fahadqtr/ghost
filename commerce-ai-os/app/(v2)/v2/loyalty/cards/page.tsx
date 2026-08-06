import Link from "next/link";
import PrintButton from "../qr/PrintButton";

export const dynamic = "force-dynamic";

// Printable insert cards for customer orders — prints the store's OWN designed
// Beauty Rewards card artwork (public/loyalty/beauty-card.png) at an exact
// business-card size (85×55mm), 2-up on A4 with cut lines. Print → cut →
// include with the order. Any quantity via ?n=. The logo, florals, QR and copy
// are baked into the image, so this page just tiles it.
const CARD_SRC = "/loyalty/beauty-card.png";

export default async function LoyaltyCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ n?: string }>;
}) {
  const { n } = await searchParams;
  const count = Math.min(Math.max(parseInt(n || "10", 10) || 10, 1), 200);
  const cards = Array.from({ length: count });

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      {/* controls — hidden when printing */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3" data-no-print>
        <div>
          <Link href="/v2/loyalty" className="text-sm text-slate-500 hover:text-slate-700">
            ← رجوع
          </Link>
          <h1 className="mt-1 text-lg font-bold text-slate-800">بطاقات للطباعة مع الطلبات</h1>
          <p className="text-sm text-slate-500">
            بطاقة مكافآت الجمال بتصميم المتجر — اطبعي على A4 بمقياس 100%، قصّي على الخطوط المتقطّعة، وحطّي بطاقة مع كل طلب.
          </p>
        </div>
        <form action="/v2/loyalty/cards" method="get" className="flex items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold text-slate-500">الكمية</span>
            <input
              name="n"
              type="number"
              min={1}
              max={200}
              defaultValue={count}
              className="w-24 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-pink-300"
            />
          </label>
          <button className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
            تحديث
          </button>
          <PrintButton />
        </form>
      </div>

      {/* print sheet */}
      <div className="qr-print">
        <div className="cards-grid">
          {cards.map((_, i) => (
            <div key={i} className="rw-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={CARD_SRC} alt="بطاقة مكافآت الجمال" className="rw-img" />
            </div>
          ))}
        </div>
      </div>

      {/* On SCREEN the sheet is responsive (1 col on phones, so it never
          overflows the viewport). On PRINT it is forced to an exact 85×55mm
          two-up A4 layout regardless of screen size. */}
      <style>{`
        .cards-grid {
          display: grid;
          grid-template-columns: 1fr;   /* phones: single column */
          gap: 4mm;
          justify-content: center;
        }
        .rw-card {
          width: 100%;
          max-width: 85mm;
          aspect-ratio: 85 / 55;         /* keep the exact card shape on screen */
          margin: 0 auto;
          box-sizing: border-box;
          border: 1px dashed #e2c9a0;
          background: #ffffff;
          overflow: hidden;
        }
        .rw-img {
          width: 100%;
          height: 100%;
          object-fit: contain;   /* full artwork, never distorted */
          display: block;
        }
        @media (min-width: 640px) {
          .cards-grid { grid-template-columns: repeat(2, 85mm); }
          .rw-card { width: 85mm; height: 55mm; max-width: none; aspect-ratio: auto; }
        }
        @media print {
          @page { size: A4; margin: 8mm; }
          .cards-grid { grid-template-columns: repeat(2, 85mm); gap: 3mm; }
          .rw-card { width: 85mm; height: 55mm; max-width: none; aspect-ratio: auto; border-color: #d8d8d8; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}
