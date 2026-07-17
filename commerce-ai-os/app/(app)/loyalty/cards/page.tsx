import Link from "next/link";
import { headers } from "next/headers";
import QRCode from "qrcode";
import PrintButton from "../qr/PrintButton";
import BrandLogo from "@/components/BrandLogo";

export const dynamic = "force-dynamic";

// Printable insert cards for customer orders — Malika's Universe brand look
// (gold frame + rose accents + MU logo + QR), business-card sized, laid out on
// A4 with cut lines. Print → cut → include with the order. Any quantity via ?n=.
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
  const count = Math.min(Math.max(parseInt(n || "10", 10) || 10, 1), 200);

  const url = await rewardsUrl();
  const qr = await QRCode.toString(url, {
    type: "svg",
    margin: 0,
    width: 200,
    color: { dark: "#5b3a44", light: "#ffffff" },
  });

  const cards = Array.from({ length: count });

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      {/* controls — hidden when printing */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3" data-no-print>
        <div>
          <Link href="/loyalty" className="text-sm text-slate-500 hover:text-slate-700">
            ← رجوع
          </Link>
          <h1 className="mt-1 text-lg font-bold text-slate-800">بطاقات للطباعة مع الطلبات</h1>
          <p className="text-sm text-slate-500">
            اطبعي على A4، قصّي على الخطوط المتقطّعة، وحطّي بطاقة مع كل طلب.
          </p>
        </div>
        <form action="/loyalty/cards" method="get" className="flex items-end gap-2">
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
              <div className="rw-frame">
                <span className="rose r-tl">🌸</span>
                <span className="rose r-br">🌸</span>
                <div className="rw-qr" dangerouslySetInnerHTML={{ __html: qr }} />
                <div className="rw-body">
                  <BrandLogo className="rw-logo" title="Malika's Universe" />
                  <p className="rw-brand">MALIKA&apos;S UNIVERSE</p>
                  <p className="rw-title">بطاقة مكافآت الجمال</p>
                  <p className="rw-sub">تقييمك في سنونو · اجمعي ٦ ختمات = منتج مجاني 🎁</p>
                  <p className="rw-scan">📷 امسحي الباركود للتسجيل</p>
                </div>
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
          width: 85mm;
          height: 55mm;
          padding: 2mm;
          box-sizing: border-box;
          border: 1px dashed #e2c9a0;
          border-radius: 3mm;
          background: #fffdfb;
        }
        .rw-frame {
          position: relative;
          width: 100%;
          height: 100%;
          box-sizing: border-box;
          border: 0.6mm solid #d9b45f;
          border-radius: 2.5mm;
          display: flex;
          align-items: center;
          gap: 3mm;
          padding: 3mm 4mm;
          direction: rtl;
          overflow: hidden;
        }
        .rose { position: absolute; font-size: 7mm; opacity: 0.35; line-height: 1; }
        .rose.r-tl { top: -1mm; right: -1mm; }
        .rose.r-br { bottom: -1mm; left: -1mm; }
        .rw-qr { width: 30mm; height: 30mm; flex: 0 0 auto; }
        .rw-qr svg { width: 100%; height: 100%; display: block; }
        .rw-body { flex: 1 1 auto; text-align: center; color: #1f1a17; }
        .rw-logo { height: 8mm; width: auto; margin: 0 auto 0.5mm; display: block; color: #b9973f; }
        .rw-brand { font-size: 2mm; letter-spacing: 1mm; color: #c9a24b; margin: 0 0 1mm; font-weight: 600; }
        .rw-title { font-family: Georgia, serif; font-size: 4.4mm; font-weight: 700; color: #d17c93; margin: 0 0 1mm; }
        .rw-sub { font-size: 2.5mm; line-height: 1.5; color: #6b5b4b; margin: 0 0 1mm; }
        .rw-scan { font-size: 2.4mm; font-weight: 700; color: #c98aa0; margin: 0; }
        @media print {
          @page { size: A4; margin: 8mm; }
          .cards-grid { gap: 3mm; }
        }
      `}</style>
    </div>
  );
}
