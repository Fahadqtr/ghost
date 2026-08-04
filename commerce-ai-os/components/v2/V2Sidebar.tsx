"use client";
// Malikas V2 sidebar (Phase UI.1). A single catalog link for now — no future or
// empty sections. Highlights the active route; on mobile it lives in the drawer
// and closing is handled by the caller via onNavigate.

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

export default function V2Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = pathname === "/v2/catalog" || pathname?.startsWith("/v2/catalog");

  return (
    <nav className="flex h-full flex-col gap-1 p-3" aria-label="التنقّل">
      <div className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">الكتالوج</div>
      <Link
        href="/v2/catalog"
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={
          "flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors " +
          (active ? "bg-brand-light text-brand" : "text-ink hover:bg-[#faf3ec]")
        }
      >
        <CatalogIcon />
        كتالوج ماليكاس
      </Link>
    </nav>
  );
}
