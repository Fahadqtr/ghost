"use client";
// Malikas V2 application shell (Phase UI.1) — fully independent of the legacy
// AppShell. RTL, responsive: a fixed sidebar on desktop and a drawer on mobile
// (opened from the top bar). Drawer state is the only interactivity — no timers,
// intervals, polling, subscriptions, or live counters.

import { useState } from "react";
import V2Sidebar from "./V2Sidebar";
import V2Topbar from "./V2Topbar";

export default function V2Shell({
  userEmail,
  children,
}: {
  userEmail?: string | null;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div dir="rtl" className="min-h-screen bg-[#fffaf4] text-ink">
      <V2Topbar userEmail={userEmail} onMenu={() => setOpen(true)} />

      <div className="mx-auto flex w-full max-w-[92rem]">
        {/* Desktop sidebar — deliberately narrow so the catalog tables get the width */}
        <aside className="hidden w-52 shrink-0 border-l border-[#efe3d6] md:block">
          <div className="sticky top-[57px] h-[calc(100vh-57px)] overflow-y-auto">
            <V2Sidebar />
          </div>
        </aside>

        {/* Mobile drawer */}
        {open ? (
          <div className="fixed inset-0 z-30 md:hidden">
            <button
              type="button"
              aria-label="إغلاق القائمة"
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-black/30"
            />
            <div className="absolute right-0 top-0 h-full w-64 border-l border-[#efe3d6] bg-[#fffaf4] shadow-xl">
              <V2Sidebar onNavigate={() => setOpen(false)} />
            </div>
          </div>
        ) : null}

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
