"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_GROUPS, APP_NAME, APP_OWNER } from "@/lib/constants";

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-lg font-bold text-white">
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
              {group.title}
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
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <span className="text-base">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-200 px-5 py-3">
        <p className="text-xs text-muted">Phase 1 · MVP</p>
      </div>
    </aside>
  );
}
