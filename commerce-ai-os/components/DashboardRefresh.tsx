"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Live "last updated" indicator + silent auto-refresh, so an open dashboard
// reflects new data without a manual reload. The server passes the ISO time the
// snapshot was computed; we re-fetch the server component on an interval.
const INTERVAL_MS = 60_000; // 60s

export default function DashboardRefresh({ generatedAt }: { generatedAt: string }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);

  // tick the "x ago" label every second
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // silent auto-refresh of server data
  useEffect(() => {
    const t = setInterval(() => {
      setRefreshing(true);
      router.refresh();
    }, INTERVAL_MS);
    return () => clearInterval(t);
  }, [router]);

  // when fresh server data arrives, generatedAt changes → clear the spinner
  useEffect(() => {
    setRefreshing(false);
    setNow(Date.now());
  }, [generatedAt]);

  const ts = new Date(generatedAt).getTime();
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  const ago = secs < 5 ? "just now" : secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ${secs % 60}s ago`;
  const clock = new Date(generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${refreshing ? "animate-pulse bg-amber-400" : "bg-green-500"}`} />
        Updated {clock} · {ago}
      </span>
      <button
        type="button"
        onClick={() => { setRefreshing(true); router.refresh(); }}
        className="rounded-md border border-slate-200 px-2 py-1 font-medium text-slate-600 hover:bg-slate-50"
      >
        {refreshing ? "Refreshing…" : "Refresh now"}
      </button>
      <span className="hidden text-slate-400 sm:inline">auto every 60s</span>
    </div>
  );
}
