"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { fetchNotifications } from "@/app/(app)/notifications-actions";
import type { Notification } from "@/lib/notifications";
import type { Locale } from "@/lib/i18n";
import PushToggle from "@/components/PushToggle";

const SEEN_KEY = "malak_notif_seen";
const REFRESH_MS = 120_000; // refresh the feed every 2 minutes while the app is open

function loadSeen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); } catch { return new Set(); }
}
function saveSeen(keys: string[]) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(keys.slice(-200))); } catch { /* ignore */ }
}

// Topbar bell: aggregated alerts (stock, approvals, staff products, tasks) with
// an unseen badge. "Seen" is a client-side watermark of item keys, so the badge
// clears per device once the owner opens the panel.
export default function NotificationsBell({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [items, setItems] = useState<Notification[]>([]);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const unseen = items.filter((i) => !seen.has(i.key)).length;

  useEffect(() => {
    setSeen(loadSeen());
    let alive = true;
    const load = async () => {
      try {
        const r = await fetchNotifications();
        if (alive) setItems(r.items);
      } catch { /* keep last */ }
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && items.length) {
      // opening marks everything currently listed as seen
      const keys = Array.from(new Set([...Array.from(seen), ...items.map((i) => i.key)]));
      setSeen(new Set(keys));
      saveSeen(keys);
    }
  };

  const sevCls = (s: Notification["severity"]) =>
    s === "high" ? "bg-red-50 border-red-100" : s === "med" ? "bg-amber-50 border-amber-100" : "bg-white border-[#efe3d6]";

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={L("الإشعارات", "Notifications")}
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-lg text-[#6b5344] hover:bg-violet-50"
      >
        <span className="text-xl leading-none">🔔</span>
        {unseen > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unseen > 9 ? "9+" : unseen}
          </span>
        ) : null}
      </button>

      {open ? (
        <div dir={en ? "ltr" : "rtl"} className="fixed inset-x-3 top-16 z-50 overflow-hidden rounded-2xl border border-[#efe3d6] bg-white shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-80">
          <div className="flex items-center justify-between border-b border-[#efe3d6] px-3 py-2.5">
            <p className="font-serif text-sm font-bold text-ink">🔔 {L("الإشعارات", "Notifications")}</p>
            <span className="text-[11px] text-muted">{items.length ? L(`${items.length} تنبيه`, `${items.length} alert${items.length === 1 ? "" : "s"}`) : ""}</span>
          </div>
          <div className="max-h-96 overflow-y-auto p-2">
            {items.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">{L("ما فيه تنبيهات — كل شي تمام 🎉", "No alerts — all clear 🎉")}</p>
            ) : (
              <div className="space-y-1.5">
                {items.map((n) => (
                  <Link key={n.key} href={n.href} onClick={() => setOpen(false)}
                    className={`flex items-center gap-2.5 rounded-xl border p-2.5 text-sm text-ink hover:brightness-[0.98] ${sevCls(n.severity)}`}>
                    <span className="text-lg">{n.icon}</span>
                    <span className="min-w-0 flex-1">{en ? n.en : n.ar}</span>
                    <span className="text-xs text-muted">{en ? "→" : "←"}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          <PushToggle locale={locale} />
        </div>
      ) : null}
    </div>
  );
}
