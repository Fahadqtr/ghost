"use client";
// Malikas V2 sidebar (Phase UI.3C). Two catalog links — no future or empty
// sections. Highlights the active route with an EXACT match so the Malikas link
// does not stay lit while the Shopify page is open; on mobile it lives in the
// drawer and closing is handled by the caller via onNavigate.

import Link from "next/link";
import { usePathname } from "next/navigation";

function CatalogIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function ShopifyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M3 7h18l-1.5 12.5a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5L3 7Z" />
      <path d="M8.5 7V5.5a3.5 3.5 0 0 1 7 0V7" />
    </svg>
  );
}

const LINKS: readonly { href: string; label: string; icon: "catalog" | "shopify" }[] = [
  { href: "/v2/catalog", label: "كتالوج ماليكاس", icon: "catalog" },
  { href: "/v2/catalog/shopify", label: "كتالوج Shopify", icon: "shopify" },
];

export default function V2Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex h-full flex-col gap-1 p-2.5" aria-label="التنقّل">
      <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">الكتالوج</div>
      {LINKS.map((link) => {
        // Exact match only: /v2/catalog must not stay active on /v2/catalog/shopify.
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={
              "flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors " +
              (active ? "bg-brand-light text-brand" : "text-ink hover:bg-[#faf3ec]")
            }
          >
            {link.icon === "shopify" ? <ShopifyIcon /> : <CatalogIcon />}
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
