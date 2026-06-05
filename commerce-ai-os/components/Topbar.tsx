"use client";

import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/lib/constants";
import { signOut } from "@/app/(app)/actions";

export default function Topbar({
  userEmail,
  onMenuClick,
}: {
  userEmail?: string | null;
  onMenuClick?: () => void;
}) {
  const pathname = usePathname();
  const current = NAV_ITEMS.find(
    (i) => pathname === i.href || pathname.startsWith(i.href + "/")
  );
  const title = current?.label ?? "Commerce AI OS";

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only */}
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open menu"
          className="-ml-1 inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 md:hidden"
        >
          <span className="text-xl leading-none">☰</span>
        </button>
        <h1 className="truncate text-base font-semibold text-ink sm:text-lg">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {userEmail ? (
          <span className="hidden text-sm text-muted lg:inline">{userEmail}</span>
        ) : null}
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-light text-sm font-semibold text-brand-dark">
          {(userEmail?.[0] ?? "U").toUpperCase()}
        </div>
        {userEmail ? (
          <form action={signOut}>
            <button type="submit" className="btn-ghost px-3 py-1.5 text-xs">
              Sign out
            </button>
          </form>
        ) : null}
      </div>
    </header>
  );
}
