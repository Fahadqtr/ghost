"use client";

import { useMemo, useState } from "react";
import type { CrmCustomer } from "./actions";
import { normalizePhone } from "@/lib/crm/customer-compute";
import { formatQar } from "@/lib/social/ad-overlay-compute";

function relDay(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const d = Math.floor((Date.now() - t) / 86_400_000);
  if (d < 30) return `قبل ${d} يوم`;
  if (d < 365) return `قبل ${Math.floor(d / 30)} شهر`;
  return `قبل ${Math.floor(d / 365)} سنة`;
}

// A wa.me deep link (no API / token needed) — opens WhatsApp with the customer's
// number and a warm pre-filled re-engagement message.
function waLink(phone: string, name: string): string | null {
  const p = normalizePhone(phone);
  if (p.length < 8) return null;
  const intl = p.length === 8 ? `974${p}` : p; // Qatar local → full number
  const text = encodeURIComponent(`هلا ${name || ""} 🌸 اشتقنا لك في ملكات الكون! وصلنا جديد يعجبك 💛`);
  return `https://wa.me/${intl}?text=${text}`;
}

// "Who to follow up today" — actionable lists derived entirely from the
// customer directory (no backend): lapsed buyers to win back, and DM contacts
// waiting on a human reply. One tap opens WhatsApp or the inbox.
export default function CrmFollowUps({ rows, onOpen, locale = "ar" }: {
  rows: CrmCustomer[];
  onOpen: (c: CrmCustomer) => void;
  locale?: string;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [open, setOpen] = useState(false);

  const { lapsed, needsReply } = useMemo(() => {
    const lapsed = rows.filter((r) => r.segment === "lapsed").slice(0, 25);
    const needsReply = rows.filter((r) => r.needsHuman).slice(0, 25);
    return { lapsed, needsReply };
  }, [rows]);

  const total = lapsed.length + needsReply.length;
  if (total === 0) return null;

  return (
    <div className="card p-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between p-3 text-start">
        <span className="text-sm font-bold text-ink">🔔 {L("متابعات اليوم", "Follow-ups today")}
          <span className="ms-2 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">{total}</span>
        </span>
        <span className="text-muted">{open ? "▴" : "▾"}</span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-[#efe3d6] p-3">
          {lapsed.length ? (
            <div>
              <p className="mb-2 text-xs font-semibold text-muted">🕰️ {L("عملاء غايبون — رجّعهم", "Lapsed — win them back")} ({lapsed.length})</p>
              <ul className="space-y-1.5">
                {lapsed.map((c) => {
                  const wa = waLink(c.phone, c.name);
                  return (
                    <li key={`${c.source}:${c.sourceId}`} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-sm">
                      <button type="button" onClick={() => onOpen(c)} className="min-w-0 flex-1 truncate text-start text-ink hover:underline">{c.name}</button>
                      <span className="shrink-0 text-[11px] text-muted tabular-nums">{L("آخر طلب", "last")} {relDay(c.lastActivityAt)}</span>
                      <span className="shrink-0 text-[11px] font-semibold text-ink tabular-nums">{formatQar(c.spent)}</span>
                      {wa ? (
                        <a href={wa} target="_blank" rel="noopener noreferrer"
                          className="shrink-0 rounded-full bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white">💬 {L("واتساب", "WhatsApp")}</a>
                      ) : (
                        <button type="button" onClick={() => onOpen(c)} className="shrink-0 rounded-full bg-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{L("بطاقة", "Card")}</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {needsReply.length ? (
            <div>
              <p className="mb-2 text-xs font-semibold text-muted">💬 {L("يحتاجون ردًّا (دايركت)", "Waiting for a reply (DMs)")} ({needsReply.length})</p>
              <ul className="space-y-1.5">
                {needsReply.map((c) => (
                  <li key={`${c.source}:${c.sourceId}`} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-sm">
                    <button type="button" onClick={() => onOpen(c)} className="min-w-0 flex-1 truncate text-start text-ink hover:underline">
                      {c.name}{c.instagram ? <span className="text-muted"> · @{c.instagram.replace(/^@/, "")}</span> : null}
                    </button>
                    <a href="/inbox" className="shrink-0 rounded-full bg-violet-600 px-2.5 py-1 text-[11px] font-bold text-white">↗ {L("الوارد", "Inbox")}</a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
