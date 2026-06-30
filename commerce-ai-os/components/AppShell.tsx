"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import BottomNav from "./BottomNav";

// Client shell. The static desktop sidebar vs. mobile drawer decision is made in
// JS (not CSS media queries) because some in-app browser webviews mis-report the
// CSS viewport width — so width-only breakpoints can wrongly show the desktop
// sidebar on a phone. We treat a device as "desktop" only when it is BOTH wide
// AND has a fine pointer (a mouse); phones/tablets (coarse/touch pointer) always
// get the slide-in drawer regardless of the reported width.
export default function AppShell({
  userEmail,
  locale = "ar",
  children,
}: {
  userEmail?: string | null;
  locale?: import("@/lib/i18n").Locale;
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
      // Use HARDWARE signals an in-app webview can't easily fake (touch points,
      // physical screen size, UA) — not just the CSS viewport width, which some
      // webviews mis-report. Treat as desktop ONLY when there's no touch, a fine
      // pointer, a real wide screen, and a non-mobile UA.
      const ua = navigator.userAgent || "";
      const uaMobile = /Mobi|Android|iPhone|iPad|iPod|Tablet|BlackBerry|Windows Phone/i.test(ua);
      const touch = (navigator.maxTouchPoints ?? 0) > 0 || "ontouchstart" in window;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      const screenW = window.screen?.width ?? 9999;
      const smallScreen = Math.min(screenW, window.innerWidth) < 1024;
      const mobile = uaMobile || touch || coarse || smallScreen;
      setDesktop(!mobile);
    };
    compute();
    const mq = window.matchMedia("(pointer: coarse)");
    mq.addEventListener?.("change", compute);
    window.addEventListener("resize", compute);
    window.addEventListener("orientationchange", compute);
    return () => {
      mq.removeEventListener?.("change", compute);
      window.removeEventListener("resize", compute);
      window.removeEventListener("orientationchange", compute);
    };
  }, []);

  // Close the drawer if we switch to desktop.
  useEffect(() => { if (desktop) setOpen(false); }, [desktop]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar (static) — only on a real wide, mouse-driven screen. */}
      {desktop ? (
        <div className="flex">
          <Sidebar locale={locale} />
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
            <Sidebar onNavigate={close} locale={locale} />
          </div>
        </div>
      ) : null}

      {/* Main column. min-w-0 lets this flex item shrink to the viewport instead
          of being pushed wider by a wide child (e.g. a min-w table), and
          overflow-x-hidden on <main> stops the horizontal scroll/zoom that a
          plain overflow-y-auto otherwise allows (overflow-x computes to auto).
          Wide tables keep their own inner overflow-x-auto scroll. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar userEmail={userEmail} locale={locale} onMenuClick={() => setOpen(true)} showMenu={!desktop} />
        <main className={`min-w-0 flex-1 overflow-x-hidden overflow-y-auto ${isMalak ? "" : "p-4 sm:p-6"}`}>{children}</main>
        {/* Native-app-style bottom tabs (mobile/tablet only) */}
        {!desktop ? <BottomNav locale={locale} /> : null}
      </div>
    </div>
  );
}
