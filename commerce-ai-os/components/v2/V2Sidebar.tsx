"use client";
// Malikas V2 sidebar (Phase UI.3C). Two catalog links — no future or empty
// sections. The highlighted link comes from the pure longest-match rule in
// lib/v2/nav, so a parent link stays active on its own sub-pages
// (/v2/catalog/<id> → كتالوج ماليكاس) while a more specific link
// (/v2/catalog/shopify) claims its own subtree. On mobile it lives in the
// drawer and closing is handled by the caller via onNavigate.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeNavHref, groupNavLinks } from "@/lib/v2/nav";

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

function RewardsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M12 20s-7-4.35-7-9a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 4.65-7 9-7 9Z" />
    </svg>
  );
}

function OperationsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M3 13h4l2 5 4-12 2 7h6" />
    </svg>
  );
}

function NavIcon({ icon }: { icon: "catalog" | "shopify" | "rewards" | "operations" }) {
  if (icon === "shopify") return <ShopifyIcon />;
  if (icon === "rewards") return <RewardsIcon />;
  if (icon === "operations") return <OperationsIcon />;
  return <CatalogIcon />;
}

export default function V2Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  // Exactly one href can win, so a parent never lights up alongside its child.
  const activeHref = activeNavHref(pathname);

  return (
    <nav className="flex h-full flex-col gap-1 p-2.5" aria-label="التنقّل">
      {groupNavLinks().map((section) => (
        <div key={section.title} className="flex flex-col gap-1">
          <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {section.title}
          </div>
          {section.links.map((link) => {
            const active = activeHref === link.href;
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
                <NavIcon icon={link.icon} />
                <span className="min-w-0 flex-1 truncate">{link.label}</span>
                {/* These pages live in the previous interface — say so rather
                    than letting the shell change without warning. */}
                {link.external ? (
                  <span className="shrink-0 text-[11px] text-muted" title="يفتح في الواجهة السابقة" aria-label="يفتح في الواجهة السابقة">
                    ↗
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
