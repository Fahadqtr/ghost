"use client";
// Malikas V2 application shell (Phase NAV.1 — Unified Navigation Refresh). Fully
// independent of the legacy AppShell. RTL, responsive: a fixed sidebar on desktop
// (collapsible to an icon-only rail) and a drawer on mobile (opened from the top
// bar, closes after navigation). Interactivity is limited to the drawer + the
// desktop collapse toggle — no timers, intervals, polling, subscriptions, or
// live counters, and no data access. Navigation only.

import { useState, useSyncExternalStore } from "react";
import V2Sidebar from "./V2Sidebar";
import V2Topbar from "./V2Topbar";

// Desktop collapse preference, persisted in localStorage so a browser refresh
// keeps the chosen state. Read through useSyncExternalStore: the server snapshot
// is always "expanded" (matching SSR — no hydration mismatch) and the client
// snapshot reflects the stored value after hydration. Toggling writes the store
// and notifies subscribers; the `storage` event keeps other tabs in sync.
const COLLAPSE_KEY = "malikas.v2.nav.collapsed";
const collapseListeners = new Set<() => void>();

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false; // private mode / storage disabled — default to expanded
  }
}

function writeCollapsed(next: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
  } catch {
    /* ignore persistence failures */
  }
  for (const notify of collapseListeners) notify();
}

function subscribeCollapsed(onChange: () => void): () => void {
  collapseListeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === COLLAPSE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    collapseListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  // Chevrons point the way the rail will move. RTL: the sidebar sits on the
  // right, so "collapse" (»») points right and "expand" («») points left.
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {collapsed ? (
        <path d="m14 6-6 6 6 6M20 6l-6 6 6 6" />
      ) : (
        <path d="m10 6 6 6-6 6M4 6l6 6-6 6" />
      )}
    </svg>
  );
}

export default function V2Shell({
  userEmail,
  children,
}: {
  userEmail?: string | null;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Desktop collapse — expanded on the server, restored from localStorage after
  // hydration (see the store above). No hydration mismatch, no setState-in-effect.
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const toggleCollapsed = () => writeCollapsed(!collapsed);

  return (
    <div dir="rtl" className="min-h-screen bg-[#fffaf4] text-ink">
      <V2Topbar userEmail={userEmail} onMenu={() => setOpen(true)} />

      <div className="mx-auto flex w-full max-w-[92rem]">
        {/* Desktop sidebar — collapsible. Narrow by default so the catalog
            tables get the width; an icon-only rail when collapsed. */}
        <aside
          className={
            "hidden shrink-0 border-l border-[#efe3d6] transition-[width] duration-200 md:block " +
            (collapsed ? "w-16" : "w-52")
          }
        >
          <div className="sticky top-[57px] flex h-[calc(100vh-57px)] flex-col overflow-y-auto">
            <div className={"flex py-1.5 " + (collapsed ? "justify-center px-1" : "justify-start px-2.5")}>
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-expanded={!collapsed}
                aria-label={collapsed ? "توسيع القائمة الجانبية" : "طيّ القائمة الجانبية"}
                title={collapsed ? "توسيع القائمة الجانبية" : "طيّ القائمة الجانبية"}
                className="rounded-lg border border-[#e7d9c9] bg-white p-1.5 text-muted transition-colors hover:bg-[#faf3ec] hover:text-ink"
              >
                <CollapseIcon collapsed={collapsed} />
              </button>
            </div>
            <V2Sidebar collapsed={collapsed} />
          </div>
        </aside>

        {/* Mobile drawer — groups always expanded, closes after navigation. */}
        {open ? (
          <div className="fixed inset-0 z-30 md:hidden">
            <button
              type="button"
              aria-label="إغلاق القائمة"
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-black/30"
            />
            <div className="absolute right-0 top-0 h-full w-64 overflow-y-auto border-l border-[#efe3d6] bg-[#fffaf4] shadow-xl">
              <V2Sidebar onNavigate={() => setOpen(false)} />
            </div>
          </div>
        ) : null}

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
