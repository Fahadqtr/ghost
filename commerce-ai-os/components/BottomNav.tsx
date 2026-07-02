"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Locale } from "@/lib/i18n";

// Native-app-style bottom tab bar (mobile only). Quick access to the main
// destinations; the full menu stays in the hamburger drawer.
const TABS = [
  { href: "/dashboard", label: "الرئيسية", en: "Home", icon: "📊" },
  { href: "/products", label: "الكتالوج", en: "Catalog", icon: "📦" },
  { href: "/malak", label: "ملاك", en: "Malak", icon: "✨" },
  { href: "/platforms", label: "المنصات", en: "Channels", icon: "🏬" },
  { href: "/inventory", label: "المخزون", en: "Inventory", icon: "🏷️" },
] as const;

export default function BottomNav({ locale = "ar" }: { locale?: Locale }) {
  const pathname = usePathname();
  const en = locale === "en";
  return (
    <nav
      className="flex shrink-0 items-stretch justify-around border-t border-slate-200 bg-white/95 backdrop-blur-sm"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        const malak = t.href === "/malak";
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition ${
              active ? "text-brand-dark" : "text-slate-500"
            }`}
          >
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-full text-lg transition ${
                malak
                  ? "bg-linear-to-br from-blue-500 to-purple-600 text-white shadow-sm"
                  : active
                  ? "bg-brand-light"
                  : ""
              }`}
            >
              {t.icon}
            </span>
            {en ? t.en : t.label}
          </Link>
        );
      })}
    </nav>
  );
}
