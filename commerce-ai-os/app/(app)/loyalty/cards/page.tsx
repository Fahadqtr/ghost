import Link from "next/link";
import { headers } from "next/headers";
import QRCode from "qrcode";
import PrintButton from "../qr/PrintButton";
import BrandLogo from "@/components/BrandLogo";

export const dynamic = "force-dynamic";

// Printable insert cards to drop into customer orders. A grid of business-card
// sized cards (logo + QR + short pitch) laid out to fill an A4 sheet, with
// dashed cut lines. Print → cut → include with the order. Count via ?n=.
async function rewardsUrl(): Promise<string> {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return `${env.replace(/\/$/, "")}/rewards`;
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}/rewards`;
}

export default async function LoyaltyCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ n?: string }>;
}) {
  const { n } = await searchParams;
  const count = Math.min(Math.max(parseInt(n || "10", 10) || 10, 1), 60);

  const url = await rewardsUrl();
  const qr = await QRCode.toString(url, {
    type: "svg",
    margin: 0,
    width: 200,
    color: { dark: "#1f1a17", light: "#ffffff" },
  });

  const cards = Array.from({ length: count });

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      {/* controls — hidden when printing */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2" data-no-print>
        <div>
          <Link href="/loyalty" className="text-sm text-slate-500 hover:text-slate-700">
            ← رجوع
          </Link>
          <h1 className="mt-1 text-lg font-bold text-slate-800">بطاقات للطباعة مع الطلبات</h1>
          <p className="text-sm text-slate-500">
            اطبعي على A4، قصّي على الخطوط المتقطّعة، وحطّي بطاقة مع كل طلب.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[10, 20, 30].map((c) => (
            <Link
              key={c}
              href={`/loyalty/cards?n=${c}`}
              className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                count === c
                  ? "border-pink-300 bg-pink-50 text-pink-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {c}
            </Link>
          ))}
          <PrintButton />
        </div>
      </div>

      {/* print sheet */}
      <div className="qr-print">
        <div className="cards-grid">
          {cards.map((_, i) => (
            <div key={i} className="rw-card">
              <div className="rw-qr" dangerouslySetInnerHTML={{ __html: qr }} />
              <div className="rw-body">
                <BrandLogo className="rw-logo" title="Malika's Universe" />
                <p className="rw-title">بطاقة مكافآت الجمال</p>
                <p className="rw-sub">امسحي الباركود، سجّلي تقييمك في سنونو، واجمعي ٦ ختمات = هدية 🎁</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* card + print styling (mm units so the print size is exact) */}
      <style>{`
        .cards-grid {
          display: grid;
          grid-template-columns: repeat(2, 85mm);
          gap: 4mm;
          justify-content: center;
        }
        .rw-card {
          display: flex;
          align-items: center;
          gap: 3mm;
          width: 85mm;
          height: 55mm;
          padding: 4mm;
          box-sizing: border-box;
          border: 1px dashed #d9b45f;
          border-radius: 4mm;
          background: #fff;
          direction: rtl;
        }
        .rw-qr { width: 34mm; height: 34mm; flex: 0 0 auto; }
        .rw-qr svg { width: 100%; height: 100%; display: block; }
        .rw-body { flex: 1 1 auto; text-align: center; color: #1f1a17; }
        .rw-logo { height: 9mm; width: auto; margin: 0 auto 1mm; display: block; }
        .rw-title { font-size: 4mm; font-weight: 700; color: #d17c93; margin: 0 0 1mm; }
        .rw-sub { font-size: 2.7mm; line-height: 1.5; color: #6b5b4b; margin: 0; }
        @media print {
          @page { size: A4; margin: 8mm; }
          .cards-grid { gap: 3mm; }
        }
      `}</style>
    </div>
  );
}
