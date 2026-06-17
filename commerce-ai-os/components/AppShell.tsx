"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";

// Client shell. The static desktop sidebar vs. mobile drawer decision is made in
// JS (not CSS media queries) because some in-app browser webviews mis-report the
// CSS viewport width — so width-only breakpoints can wrongly show the desktop
// sidebar on a phone. We treat a device as "desktop" only when it is BOTH wide
// AND has a fine pointer (a mouse); phones/tablets (coarse/touch pointer) always
// get the slide-in drawer regardless of the reported width.
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
  const isMalak = pathname === "/malak" || pathname.startsWith("/malak/");

  // Default to mobile (drawer) until measured, so phones never flash the sidebar.
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const compute = () => {
      const wide = window.matchMedia("(min-width: 1024px)").matches;
      const finePointer = window.matchMedia("(pointer: fine)").matches;
      const noHover = window.matchMedia("(hover: none)").matches; // touch devices
      setDesktop(wide && finePointer && !noHover);
    };
    compute();
    const mqs = [
      window.matchMedia("(min-width: 1024px)"),
      window.matchMedia("(pointer: fine)"),
      window.matchMedia("(hover: none)"),
    ];
    mqs.forEach((m) => m.addEventListener?.("change", compute));
    window.addEventListener("resize", compute);
    return () => {
      mqs.forEach((m) => m.removeEventListener?.("change", compute));
      window.removeEventListener("resize", compute);
    };
  }, []);

  // Close the drawer if we switch to desktop.
  useEffect(() => { if (desktop) setOpen(false); }, [desktop]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar (static) — only on a real wide, mouse-driven screen. */}
      {desktop ? (
        <div className="flex">
          <Sidebar />
        </div>
      ) : null}

      {/* Mobile/tablet drawer (only mounted when not desktop) */}
      {!desktop ? (
        <div
          className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`}
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
      ) : null}

      {/* Main column */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar userEmail={userEmail} onMenuClick={() => setOpen(true)} showMenu={!desktop} />
        <main className={`flex-1 overflow-y-auto ${isMalak ? "" : "p-4 sm:p-6"}`}>{children}</main>
      </div>
    </div>
  );
}
