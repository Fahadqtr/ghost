"use client";

import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/lib/constants";
import { signOut } from "@/app/(app)/actions";

export default function Topbar({ userEmail }: { userEmail?: string | null }) {
  const pathname = usePathname();
  const current = NAV_ITEMS.find(
    (i) => pathname === i.href || pathname.startsWith(i.href + "/")
  );
  const title = current?.label ?? "Commerce AI OS";

  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
      <h1 className="text-lg font-semibold text-ink">{title}</h1>
      <div className="flex items-center gap-3">
        {userEmail ? (
          <span className="hidden text-sm text-muted sm:inline">{userEmail}</span>
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
