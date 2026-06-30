"use client";

import { usePathname } from "next/navigation";
import { NAV_GROUPS } from "@/lib/constants";
import { signOut } from "@/app/(app)/actions";
import { makeT, type Locale } from "@/lib/i18n";
import LanguageToggle from "./LanguageToggle";

export default function Topbar({
  userEmail,
  locale = "ar",
  onMenuClick,
  showMenu = true,
}: {
  userEmail?: string | null;
  locale?: Locale;
  onMenuClick?: () => void;
  showMenu?: boolean;
}) {
  const pathname = usePathname();
  const t = makeT(locale);
  const en = locale === "en";
  type NavItem = { href: string; label: string; en: string; icon: string };
  const items: NavItem[] = NAV_GROUPS.flatMap((g) => g.items as readonly NavItem[]);
  const current = items.find((i) => pathname === i.href || pathname.startsWith(i.href + "/"));
  const title = current ? (en ? current.en : current.label) : "Commerce AI OS";

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — shown whenever the static sidebar is hidden */}
        {showMenu ? (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label={t("app.openMenu")}
            className="-ml-1 inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
          >
            <span className="text-xl leading-none">☰</span>
          </button>
        ) : null}
        <h1 className="truncate text-base font-semibold text-ink sm:text-lg">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <LanguageToggle locale={locale} />
        {userEmail ? (
          <span className="hidden text-sm text-muted lg:inline">{userEmail}</span>
        ) : null}
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-sm font-semibold text-brand-dark">
          {(userEmail?.[0] ?? "U").toUpperCase()}
        </div>
        {userEmail ? (
          <form action={signOut}>
            <button type="submit" className="btn-ghost px-3 py-1.5 text-xs">
              {t("app.signOut")}
            </button>
          </form>
        ) : null}
      </div>
    </header>
  );
}
