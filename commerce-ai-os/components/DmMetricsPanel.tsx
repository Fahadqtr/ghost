"use client";

import { useEffect, useState } from "react";
import { dmMetrics, type DmMetrics } from "@/app/(app)/inbox/actions";
import type { Locale } from "@/lib/i18n";

function Tile({ icon, value, label, tone = "" }: { icon: string; value: string | number; label: string; tone?: string }) {
  return (
    <div className={`rounded-xl border border-[#efe3d6] bg-white px-3 py-2 ${tone}`}>
      <div className="text-lg font-bold leading-none text-ink">{icon} {value}</div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
    </div>
  );
}

// Compact DM KPI strip shown above the inbox: pipeline state (total / waiting on
// a human / auto-reply on) plus last-7-days volume and Malak's automation share.
export default function DmMetricsPanel({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [m, setM] = useState<DmMetrics | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await dmMetrics();
        if (!alive) return;
        if (r.ok && r.data) setM(r.data);
        else if (r.error) setErr(r.error);
      } catch { /* ignore */ }
    };
    load();
    const id = setInterval(load, 30000); // keep the numbers fresh
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (err || !m) return null;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Tile icon="💬" value={m.totalConversations} label={L("محادثات", "Conversations")} />
      <Tile icon="🙋" value={m.needsHuman} label={L("تنتظر رد بشري", "Awaiting human")}
        tone={m.needsHuman > 0 ? "border-amber-300 bg-amber-50" : ""} />
      <Tile icon="🤖" value={m.autoOn} label={L("الرد التلقائي مفعّل", "Auto-reply on")} />
      <Tile icon="📥" value={m.inbound7d} label={L("واردة (٧ أيام)", "Inbound (7d)")} />
      <Tile icon="↩︎" value={m.outbound7d} label={L("ردود (٧ أيام)", "Replies (7d)")} />
      <Tile icon="⚡" value={`${m.autoSharePct}%`} label={L("أتمتة ملاك", "Malak automation")} />
    </div>
  );
}
