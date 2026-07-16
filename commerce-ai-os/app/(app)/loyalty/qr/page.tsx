import Link from "next/link";
import { headers } from "next/headers";
import QRCode from "qrcode";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";

// Printable QR poster the owner sticks on orders / in the shop. Scanning it
// opens the public /rewards card. The URL is built from the request host so it
// works on whatever domain the app is deployed to (override with
// NEXT_PUBLIC_SITE_URL if the public link should differ from the admin host).
async function rewardsUrl(): Promise<string> {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return `${env.replace(/\/$/, "")}/rewards`;
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}/rewards`;
}

export default async function RewardsQrPage() {
  const url = await rewardsUrl();
  const svg = await QRCode.toString(url, {
    type: "svg",
    margin: 1,
    width: 320,
    color: { dark: "#d17c93", light: "#ffffff" },
  });

  return (
    <div className="mx-auto max-w-xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-2" data-no-print>
        <Link href="/loyalty" className="text-sm text-slate-500 hover:text-slate-700">
          ← رجوع
        </Link>
        <PrintButton />
      </div>

      <div className="qr-print rounded-3xl border-2 border-[#d9b45f] bg-white p-8 text-center shadow-sm">
        <p className="text-[11px] font-semibold tracking-[0.35em] text-[#c9a24b]">
          MALIKA&apos;S UNIVERSE
        </p>
        <h1 className="mt-2 text-2xl font-bold text-[#d17c93]">بطاقة مكافآت الجمال</h1>
        <p className="mt-1 text-sm text-[#8a7a6a]">
          امسحي الباركود، سجّلي تقييمك في سنونو، واجمعي ٥ ختمات = منتج مجاني 🎁
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
