import Link from "next/link";
import QRCode from "qrcode";
import PrintButton from "./PrintButton";
import BrandLogo from "@/components/BrandLogo";
import BrandSwitch from "../BrandSwitch";
import { publicRewardsUrl } from "@/lib/loyalty/public-url";
import { BRAND_INFO, DEFAULT_BRAND, parseBrand, withBrand } from "@/lib/loyalty/brand";

export const dynamic = "force-dynamic";

// Printable QR poster the owner sticks on orders / in the shop. Scanning it
// opens the store's public rewards card (/rewards for Malika's,
// /rewards/pureseoul for Pure Seoul) — see lib/loyalty/public-url.
export default async function RewardsQrPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string }>;
}) {
  const brand = parseBrand((await searchParams).brand);
  const info = BRAND_INFO[brand];
  const url = await publicRewardsUrl(brand);
  const svg = await QRCode.toString(url, {
    type: "svg",
    margin: 1,
    width: 320,
    color: { dark: "#d17c93", light: "#ffffff" },
  });

  return (
    <div className="mx-auto max-w-xl p-4 sm:p-6">
      <BrandSwitch path="/v2/loyalty/qr" brand={brand} />
      <div className="mb-4 flex items-center justify-between gap-2" data-no-print>
        <Link href={withBrand("/v2/loyalty", brand)} className="text-sm text-slate-500 hover:text-slate-700">
          ← رجوع
        </Link>
        <PrintButton />
      </div>

      <div className="qr-print rounded-3xl border-2 border-[#d9b45f] bg-white p-8 text-center shadow-sm">
        {brand === DEFAULT_BRAND ? (
          <BrandLogo className="mx-auto h-16 w-auto text-[#1f1a17]" />
        ) : (
          <p className="font-serif text-4xl font-bold tracking-[0.12em] text-[#1f1a17]">
            {info.storeName}
          </p>
        )}
        {brand === DEFAULT_BRAND && (
          <p className="mt-1 text-[11px] font-semibold tracking-[0.35em] text-[#c9a24b]">
            {info.wordmark}
          </p>
        )}
        <h1 className="mt-2 text-2xl font-bold text-[#d17c93]">بطاقة مكافآت الجمال</h1>
        <p className="mt-1 text-sm text-[#8a7a6a]">
          امسحي الباركود، سجّلي تقييمك لمتجر {info.storeName} في سنونو، واجمعي ٦ ختمات = منتج مجاني 🎁
        </p>

        <div
          className="mx-auto mt-6 w-fit rounded-2xl border border-[#f0dcc6] p-3"
          // trusted: SVG generated server-side by the qrcode library from our URL
          dangerouslySetInnerHTML={{ __html: svg }}
        />

        <p dir="ltr" className="mt-4 break-all text-xs text-slate-400">
          {url}
        </p>
      </div>
    </div>
  );
}
