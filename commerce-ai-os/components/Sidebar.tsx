"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NAV_GROUPS, APP_NAME, APP_OWNER } from "@/lib/constants";
import { dmNeedsHumanCount } from "@/app/(app)/inbox/actions";
import type { Locale } from "@/lib/i18n";

export default function Sidebar({ onNavigate, locale = "ar" }: { onNavigate?: () => void; locale?: Locale }) {
  const pathname = usePathname();
  const en = locale === "en";

  // Live badge on «الوارد»: how many DMs are waiting on a human right now.
  const [dmWaiting, setDmWaiting] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => dmNeedsHumanCount().then((n) => { if (alive) setDmWaiting(n); }).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [pathname]);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-[#efe3d6] bg-white">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white">
          M
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-ink">{APP_NAME}</p>
          <p className="text-xs text-muted">{APP_OWNER}</p>
        </div>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="space-y-1">
            <p className="px-3 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {en ? group.titleEn : group.title}
            </p>
            {group.items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-brand-light text-brand-dark"
                      : "text-[#6b5344] hover:bg-violet-50"
                  }`}
                >
                  <span className="text-base">{item.icon}</span>
                  <span className="flex-1">{en ? item.en : item.label}</span>
                  {item.href === "/inbox" && dmWaiting > 0 ? (
                    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white" title={en ? "Awaiting a human reply" : "تنتظر رد بشري"}>
                      {dmWaiting}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-[#efe3d6] px-5 py-3">
        <p className="text-xs text-muted">Phase 1 · MVP</p>
      </div>
    </aside>
  );
}
