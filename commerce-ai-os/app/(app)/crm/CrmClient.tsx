"use client";

import { useMemo, useState, useTransition } from "react";
import { getCustomerDetail, saveCustomerNote, setCustomerTags, type CrmCustomer, type CrmDetail } from "./actions";
import { SEGMENTS, segmentLabel, type CustomerSegment } from "@/lib/crm/customer-compute";
import { formatQar } from "@/lib/social/ad-overlay-compute";

const keyOf = (c: { source: string; sourceId: string }) => `${c.source}:${c.sourceId}`;

function relDay(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const d = Math.floor((Date.now() - t) / 86_400_000);
  if (d <= 0) return "اليوم";
  if (d === 1) return "أمس";
  if (d < 30) return `قبل ${d} يوم`;
  if (d < 365) return `قبل ${Math.floor(d / 30)} شهر`;
  return `قبل ${Math.floor(d / 365)} سنة`;
}

const SEG_STYLE: Record<CustomerSegment, string> = {
  vip: "bg-amber-100 text-amber-800",
  repeat: "bg-emerald-100 text-emerald-800",
  new: "bg-sky-100 text-sky-800",
  lapsed: "bg-rose-100 text-rose-700",
  lead: "bg-violet-100 text-violet-800",
};

export default function CrmClient({ rows, counts, shopifyNote }: {
  rows: CrmCustomer[];
  counts: Record<CustomerSegment, number>;
  shopifyNote?: string;
}) {
  const [q, setQ] = useState("");
  const [seg, setSeg] = useState<CustomerSegment | "all">("all");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CrmDetail | "loading">>({});
  const [rowState, setRowState] = useState<Record<string, { tags: string[]; hasNote: boolean }>>({});

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (seg !== "all" && r.segment !== seg) return false;
      if (!needle) return true;
      return `${r.name} ${r.phone} ${r.instagram} ${r.email}`.toLowerCase().includes(needle);
    });
  }, [rows, q, seg]);

  const toggle = (c: CrmCustomer) => {
    const k = keyOf(c);
    if (openKey === k) { setOpenKey(null); return; }
    setOpenKey(k);
    if (!details[k]) {
      setDetails((s) => ({ ...s, [k]: "loading" }));
      getCustomerDetail(c.source, c.sourceId)
        .then((d) => setDetails((s) => ({ ...s, [k]: d })))
        .catch(() => setDetails((s) => ({ ...s, [k]: { notes: "", tags: [], error: "تعذّر جلب التفاصيل." } })));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold text-ink">🧑‍🤝‍🧑 العملاء (CRM)</h1>
        <span className="text-xs text-muted">{rows.length} عميل</span>
      </div>

      {shopifyNote ? (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{shopifyNote}</div>
      ) : null}

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث بالاسم، الجوال، الحساب…"
        className="input w-full text-sm" />

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setSeg("all")}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${seg === "all" ? "bg-brand text-white" : "bg-slate-100 text-slate-600"}`}>
          الكل ({rows.length})
        </button>
        {SEGMENTS.map((s) => (
          <button key={s.key} onClick={() => setSeg(s.key)}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${seg === s.key ? "bg-brand text-white" : "bg-slate-100 text-slate-600"}`}>
            {s.emoji} {s.ar} ({counts[s.key] ?? 0})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-muted">لا يوجد عملاء في هذا التصنيف.</p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((c) => {
            const k = keyOf(c);
            const open = openKey === k;
            const st = rowState[k];
            const hasNote = st?.hasNote ?? c.hasNote;
            return (
              <li key={k} className="card p-0">
                <button onClick={() => toggle(c)} className="flex w-full items-center gap-3 p-3 text-start">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${SEG_STYLE[c.segment]}`}>
                    {(c.name || "؟").trim().charAt(0)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-bold text-ink">{c.name}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${SEG_STYLE[c.segment]}`}>{segmentLabel(c.segment)}</span>
                      {c.needsHuman ? <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">يحتاج رد</span> : null}
                      {hasNote ? <span className="shrink-0" title="فيه ملاحظة">📝</span> : null}
                    </div>
                    <div className="truncate text-[11px] text-muted" dir="ltr">
                      {c.source === "shopify"
                        ? `${c.orders} طلب · ${formatQar(c.spent)}${c.phone ? " · " + c.phone : ""}`
                        : `${c.channel === "whatsapp" ? "واتساب" : "دايركت"}${c.instagram ? " · @" + c.instagram.replace(/^@/, "") : ""}`}
                    </div>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted">{relDay(c.lastActivityAt)}</span>
                </button>

                {open ? (
                  <CustomerDetail c={c} detail={details[k]}
                    onSaved={(tags, hasNote) => setRowState((s) => ({ ...s, [k]: { tags, hasNote } }))} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CustomerDetail({ c, detail, onSaved }: {
  c: CrmCustomer;
  detail: CrmDetail | "loading" | undefined;
  onSaved: (tags: string[], hasNote: boolean) => void;
}) {
  const identity = { name: c.name, phone: c.phone, instagram: c.instagram, email: c.email };
  const [note, setNote] = useState<string | null>(null);
  const [tags, setTags] = useState<string[] | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, start] = useTransition();

  if (detail === "loading" || detail === undefined) {
    return <div className="border-t border-[#efe3d6] p-3 text-xs text-muted">جاري التحميل…</div>;
  }

  const noteVal = note ?? detail.notes;
  const tagVal = tags ?? detail.tags;

  const saveNote = () => {
    start(async () => {
      const r = await saveCustomerNote(c.source, c.sourceId, noteVal, identity);
      if (r.error) { setMsg(`❌ ${r.error}`); return; }
      setMsg("✅ اتحفظت الملاحظة");
      onSaved(tagVal, !!noteVal.trim());
    });
  };
  const commitTags = (next: string[]) => {
    setTags(next);
    start(async () => {
      const r = await setCustomerTags(c.source, c.sourceId, next, identity);
      if (r.error) { setMsg(`❌ ${r.error}`); return; }
      onSaved(next, !!noteVal.trim());
    });
  };
  const addTag = () => {
    const t = tagInput.trim();
    if (!t || tagVal.includes(t)) { setTagInput(""); return; }
    commitTags([...tagVal, t]);
    setTagInput("");
  };

  return (
    <div className="space-y-3 border-t border-[#efe3d6] p-3">
      {detail.error ? <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">{detail.error}</p> : null}

      {/* Orders (Shopify) */}
      {detail.orders ? (
        detail.orders.length ? (
          <div>
            <p className="mb-1 text-xs font-semibold text-muted">الطلبات</p>
            <ul className="space-y-1">
              {detail.orders.map((o, i) => (
                <li key={i} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-xs">
                  <span className="font-semibold text-ink" dir="ltr">{o.name}</span>
                  <span className="text-muted">{relDay(o.createdAt)}{o.fulfillment ? ` · ${o.fulfillment}` : ""}</span>
                  <span className="font-semibold text-ink">{formatQar(o.total)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : <p className="text-xs text-muted">لا توجد طلبات.</p>
      ) : null}

      {/* Messages (DM) */}
      {detail.messages ? (
        detail.messages.length ? (
          <div>
            <p className="mb-1 text-xs font-semibold text-muted">آخر المحادثة</p>
            <div className="max-h-56 space-y-1 overflow-y-auto rounded bg-slate-50 p-2">
              {detail.messages.map((m, i) => (
                <div key={i} className={`text-xs ${m.direction === "out" ? "text-start" : "text-end"}`}>
                  <span className={`inline-block rounded-lg px-2 py-1 ${m.direction === "out" ? (m.ai ? "bg-violet-100 text-violet-900" : "bg-emerald-100 text-emerald-900") : "bg-white text-ink"}`}>
                    {m.body}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : <p className="text-xs text-muted">لا توجد رسائل.</p>
      ) : null}

      {/* Tags */}
      <div>
        <p className="mb-1 text-xs font-semibold text-muted">وسوم</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {tagVal.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-brand-light px-2 py-0.5 text-[11px] text-brand-dark">
              {t}
              <button onClick={() => commitTags(tagVal.filter((x) => x !== t))} disabled={busy} className="text-brand-dark/60">×</button>
            </span>
          ))}
          <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
            placeholder="+ وسم" className="w-20 rounded-full border border-slate-200 px-2 py-0.5 text-[11px]" />
        </div>
      </div>

      {/* Notes */}
      <div>
        <p className="mb-1 text-xs font-semibold text-muted">ملاحظات</p>
        <textarea value={noteVal} onChange={(e) => setNote(e.target.value)} rows={2}
          className="input w-full text-xs" placeholder="تفضيلات العميل، طلبات خاصة…" />
        <div className="mt-1 flex items-center gap-2">
          <button onClick={saveNote} disabled={busy} className="btn-primary px-3 py-1 text-xs disabled:opacity-50">
            {busy ? "…" : "حفظ"}
          </button>
          {msg ? <span className="text-[11px] text-muted">{msg}</span> : null}
        </div>
      </div>
    </div>
  );
}
