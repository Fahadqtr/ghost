import Link from "next/link";
import { BRAND_INFO, LOYALTY_BRANDS, withBrand, type LoyaltyBrand } from "@/lib/loyalty/brand";

// Store switcher for the Beauty Rewards admin pages. Each store (Malika's /
// Pure Seoul) has its own customers, review queue, prizes and QR; the choice is
// carried in `?brand=` so every page and link stays on the same store.
export default function BrandSwitch({ path, brand }: { path: string; brand: LoyaltyBrand }) {
  return (
    <div className="mb-4 inline-flex rounded-xl border border-slate-200 bg-white p-1 text-sm" data-no-print>
      {LOYALTY_BRANDS.map((b) => (
        <Link
          key={b}
          href={withBrand(path, b)}
          className={`rounded-lg px-3 py-1.5 font-semibold ${
            b === brand ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          {BRAND_INFO[b].storeName}
        </Link>
      ))}
    </div>
  );
}
