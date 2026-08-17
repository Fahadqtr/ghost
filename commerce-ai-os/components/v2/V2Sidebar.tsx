"use client";
// Malikas V2 sidebar (Phase NAV.1 — Unified Navigation Refresh). The link list
// and the active-link / active-group rules live in the pure, unit-tested
// lib/v2/nav model; this file is purely presentational. It renders each grouped
// link, highlights the current page AND its group heading, and supports a
// collapsed (icon-only) desktop mode with hover tooltips. On mobile it lives in
// the drawer and closing is handled by the caller via onNavigate.
//
// No data client, no writes, no timers/polling/subscriptions — navigation only.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeNavHref, activeNavSection, groupNavLinks, type V2NavIcon } from "@/lib/v2/nav";

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

// Activity — Operations Center.
function OperationsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M3 13h4l2 5 4-12 2 7h6" />
    </svg>
  );
}

// Image — Media Center.
function MediaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.6" />
      <path d="m5 18 5-5 4 4 2-2 3 3" />
    </svg>
  );
}

// Network — Channels Center.
function ChannelsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="5" r="2.4" />
      <circle cx="5" cy="19" r="2.4" />
      <circle cx="19" cy="19" r="2.4" />
      <path d="M12 7.4v4.6m0 0L6.4 17m5.6-5 5.6 5" />
    </svg>
  );
}

// Sparkles — AI Center.
function AiIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
    </svg>
  );
}

// ShieldCheck — Platform Health.
function HealthIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 9.5C8 19.2 5 15.5 5 11V6l7-3Z" />
      <path d="m9 11.5 2 2 4-4" />
    </svg>
  );
}

// BarChart — Analytics / Executive Dashboard.
function AnalyticsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <rect x="7" y="12" width="3" height="5" rx="0.5" />
      <rect x="12" y="8" width="3" height="9" rx="0.5" />
      <rect x="17" y="5" width="3" height="12" rx="0.5" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

function NavIcon({ icon }: { icon: V2NavIcon }) {
  switch (icon) {
    case "shopify":
      return <ShopifyIcon />;
    case "export":
      return <ExportIcon />;
    case "rewards":
      return <RewardsIcon />;
    case "operations":
      return <OperationsIcon />;
    case "media":
      return <MediaIcon />;
    case "channels":
      return <ChannelsIcon />;
    case "ai":
      return <AiIcon />;
    case "health":
      return <HealthIcon />;
    case "analytics":
      return <AnalyticsIcon />;
    default:
      return <CatalogIcon />;
  }
}

export default function V2Sidebar({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  /** Desktop icon-only mode. Labels are hidden; each link exposes a tooltip. */
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  // Exactly one href can win, so a parent never lights up alongside its child.
  const activeHref = activeNavHref(pathname);
  const activeSection = activeNavSection(pathname);

  return (
    <nav
      className={"flex h-full flex-col gap-1 " + (collapsed ? "items-center p-2" : "p-2.5")}
      aria-label="التنقّل"
    >
      {groupNavLinks().map((section) => {
        const sectionActive = activeSection === section.title;
        return (
          <div key={section.title} className="flex w-full flex-col gap-1">
            {collapsed ? (
              // Icon-only mode: a thin divider stands in for the heading so the
              // groups stay visually separated without the text label.
              <div className="my-1 h-px w-6 self-center bg-[#efe3d6]" aria-hidden="true" />
            ) : (
              <div
                className={
                  "px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider " +
                  (sectionActive ? "text-brand" : "text-muted")
                }
              >
                {section.title}
              </div>
            )}
            {section.links.map((link) => {
              const active = activeHref === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  aria-label={link.label}
                  // Native tooltip — the label on hover, always available and
                  // essential in collapsed (icon-only) mode.
                  title={link.label}
                  className={
                    "flex items-center rounded-xl text-sm font-medium transition-colors " +
                    (collapsed ? "h-10 w-10 justify-center" : "gap-2.5 px-3 py-2") +
                    " " +
                    (active ? "bg-brand-light text-brand" : "text-ink hover:bg-[#faf3ec]")
                  }
                >
                  <NavIcon icon={link.icon} />
                  {collapsed ? null : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{link.label}</span>
                      {/* These pages live in the previous interface — say so rather
                          than letting the shell change without warning. */}
                      {link.external ? (
                        <span
                          className="shrink-0 text-[11px] text-muted"
                          title="يفتح في الواجهة السابقة"
                          aria-label="يفتح في الواجهة السابقة"
                        >
                          ↗
                        </span>
                      ) : null}
                    </>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
