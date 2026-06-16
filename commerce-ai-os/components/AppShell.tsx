"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

// Client shell: holds the mobile drawer state shared by the Topbar hamburger
// and the slide-in Sidebar. Desktop (md+) shows the static sidebar.
export default function AppShell({
  userEmail,
  children,
}: {
  userEmail?: string | null;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const pathname = usePathname();
  // Malak provides its own dark full-bleed background, so drop the main padding
  // for it (avoids the negative-margin trick that broke mobile width).
  const isMalak = pathname === "/malak" || pathname.startsWith("/malak/");

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar (static) */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      {/* Mobile drawer (always mounted for smooth transitions) */}
      <div
        className={`fixed inset-0 z-40 md:hidden ${open ? "" : "pointer-events-none"}`}
        aria-hidden={!open}
      >
        {/* Backdrop */}
        <div
          onClick={close}
          className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
            open ? "opacity-100" : "opacity-0"
          }`}
        />
        {/* Panel */}
        <div
          className={`absolute left-0 top-0 h-full transform transition-transform duration-200 ease-out ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <Sidebar onNavigate={close} />
        </div>
      </div>

      {/* Main column */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar userEmail={userEmail} onMenuClick={() => setOpen(true)} />
        <main className={`flex-1 overflow-y-auto ${isMalak ? "" : "p-4 sm:p-6"}`}>{children}</main>
      </div>
    </div>
  );
}
