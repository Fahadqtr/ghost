"use client";

import { useState } from "react";
import {
  createReelRequest, listReelRequests, scheduleReelRequest, cancelReelRequest,
  type ReelRequestRow,
} from "@/app/(app)/content/reel-request-actions";
import { REEL_STYLES, styleLabelAr } from "@/lib/social/reel-request-compute";
import type { PickProduct } from "@/components/ContentGenerator";
import ProductThumb from "@/components/ProductThumb";
import type { Locale } from "@/lib/i18n";

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  scheduled: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-500",
};

// «اطلب ريل احترافي» — file a Marketing Studio talking-avatar reel request
// (product + style + slot + notes), then paste the finished mp4 URL back to
// schedule it. The premium reels are produced via Marketing Studio; this panel
// is the queue + one-tap scheduling around them.
export default function ReelRequestPanel({ items, initial = [], locale = "ar" }: { items: PickProduct[]; initial?: ReelRequestRow[]; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const [sku, setSku] = useState("");
  const [style, setStyle] = useState(REEL_STYLES[0].slug);
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [rows, setRows] = useState<ReelRequestRow[]>(initial);
  const [note, setNote] = useState("");
  const [urlById, setUrlById] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});

  const selected = items.find((p) => p.sku === sku) || null;
  const productName = selected ? (selected.name_ar || selected.name_en || selected.sku) : "";

  // Refresh the list after a mutation (event-driven — no mount effect; the
  // initial rows come from the server page as a prop).
  const load = async () => {
    const r = await listReelRequests();
    if (!("error" in r)) setRows(r.rows);
  };

  const submit = async () => {
    if (!sku) { setErr(L("اختر منتجًا أولًا", "Pick a product first")); return; }
    setBusy(true); setErr(""); setMsg("");
    try {
      const iso = when ? new Date(when).toISOString() : null;
      const r = await createReelRequest({ sku, productName, style, notes, scheduledAtIso: iso });
      if ("error" in r) setErr(r.error);
      else { setMsg(L("✅ انحفظ الطلب — بيتولّد ويتجدول", "✅ Request saved — it'll be generated and scheduled")); setNotes(""); setWhen(""); await load(); }
    } catch (e: any) {
      setErr(e?.message || L("تعذّر حفظ الطلب", "Failed to save the request"));
    } finally { setBusy(false); }
  };

  const copy = async (text: string, m: string) => {
    try { await navigator.clipboard.writeText(text); setNote(m); setTimeout(() => setNote(""), 1500); }
    catch { setNote(L("تعذّر النسخ", "Copy failed")); }
  };

  const schedule = async (id: string) => {
    const url = (urlById[id] || "").trim();
    if (!url) { setNote(L("الصق رابط الفيديو أول", "Paste the video URL first")); return; }
    setRowBusy((s) => ({ ...s, [id]: true }));
    try {
      const r = await scheduleReelRequest({ id, videoUrl: url });
      if ("error" in r) setNote(r.error);
      else { setNote(L("📅 تمت الجدولة — اعتمده من /social", "📅 Scheduled — approve on /social")); await load(); }
    } finally { setRowBusy((s) => ({ ...s, [id]: false })); }
  };

  const cancel = async (id: string) => {
    setRowBusy((s) => ({ ...s, [id]: true }));
    try { await cancelReelRequest(id); await load(); }
    finally { setRowBusy((s) => ({ ...s, [id]: false })); }
  };

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-bold text-ink">🎬✨ {L("اطلب ريل احترافي", "Request a professional reel")}</h3>
        <p className="text-xs text-muted">
          {L("ريل UGC بأفاتار يتكلم عربي (Marketing Studio). احفظ الطلب، والصق رابط الريل الجاهز ليتجدول تلقائيًا.",
            "Talking-avatar Arabic UGC reel (Marketing Studio). Save the request, paste the finished reel URL to auto-schedule.")}
        </p>
      </div>

      {/* New request form */}
      <div className="grid gap-2 rounded-xl border border-[#efe3d6] bg-white p-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-slate-600">
          {L("المنتج", "Product")}
          <select value={sku} onChange={(e) => setSku(e.target.value)} className="input mt-1 w-full py-1.5 text-sm">
            <option value="">{L("— اختر —", "— pick —")}</option>
            {items.map((p) => (
              <option key={p.sku} value={p.sku}>{(p.name_ar || p.name_en || p.sku)}{p.sku ? ` (${p.sku})` : ""}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">
          {L("النمط", "Style")}
          <select value={style} onChange={(e) => setStyle(e.target.value)} className="input mt-1 w-full py-1.5 text-sm">
            {REEL_STYLES.map((s) => <option key={s.slug} value={s.slug}>{en ? s.labelEn : s.labelAr}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">
          {L("وقت النشر (اختياري)", "Publish time (optional)")}
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="input mt-1 w-full py-1.5 text-sm" />
        </label>
        <label className="text-xs font-semibold text-slate-600">
          {L("ملاحظات للسكربت (اختياري)", "Script notes (optional)")}
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={L("مثال: ركّزي على النتيجة السريعة", "e.g. focus on the fast result")}
            className="input mt-1 w-full py-1.5 text-sm" />
        </label>
        <div className="sm:col-span-2 flex items-center gap-2">
          <button onClick={submit} disabled={busy} className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50">
            {busy ? L("…", "…") : `🎬✨ ${L("اطلب الريل", "Request reel")}`}
          </button>
          {msg ? <span className="text-xs text-emerald-700">{msg}</span> : null}
          {err ? <span className="text-xs text-red-600">{err}</span> : null}
        </div>
      </div>

      {note ? <p className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800">{note}</p> : null}

      {/* Existing requests */}
      {rows.length ? (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded-xl border border-[#efe3d6] bg-white p-3">
              <div className="flex items-start gap-2">
                <ProductThumb imageUrl={null} sku={r.sku} sizeClass="h-12 w-12" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{r.productName || r.sku || "—"}</span>
                    <span className="badge bg-violet-100 text-violet-700">{styleLabelAr(r.style)}</span>
                    <span className={`badge ${STATUS_BADGE[r.status] ?? "bg-slate-100 text-slate-600"}`}>
                      {r.status === "pending" ? L("بالانتظار", "pending") : r.status === "scheduled" ? L("مجدول", "scheduled") : L("ملغى", "cancelled")}
                    </span>
                  </div>
                  {r.notes ? <p className="mt-0.5 text-[11px] text-muted">{r.notes}</p> : null}
                  {r.scheduledAtIso ? <p className="text-[11px] text-muted" dir="ltr">🕐 {new Date(r.scheduledAtIso).toLocaleString()}</p> : null}
                </div>
                <button onClick={() => copy(r.brief, L("📋 نُسخت وصفة التوليد", "📋 Generation brief copied"))}
                  className="shrink-0 rounded-md bg-slate-200 px-2 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-300">
                  📋 {L("انسخ الوصفة", "Copy brief")}
                </button>
              </div>

              {r.status === "pending" ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input value={urlById[r.id] ?? ""} onChange={(e) => setUrlById((s) => ({ ...s, [r.id]: e.target.value }))}
                    dir="ltr" placeholder={L("الصق رابط الريل الجاهز mp4", "paste the finished reel mp4 URL")}
                    className="input min-w-0 flex-1 py-1 text-xs" />
                  <button onClick={() => schedule(r.id)} disabled={rowBusy[r.id]}
                    className="btn-primary shrink-0 px-3 py-1.5 text-xs disabled:opacity-50">
                    {rowBusy[r.id] ? "…" : `📅 ${L("جدولة", "Schedule")}`}
                  </button>
                  <button onClick={() => cancel(r.id)} disabled={rowBusy[r.id]}
                    className="shrink-0 rounded-md bg-slate-100 px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-200">
                    {L("إلغاء", "Cancel")}
                  </button>
                </div>
              ) : r.videoUrl ? (
                <a href={r.videoUrl} target="_blank" rel="noreferrer" dir="ltr"
                  className="mt-1 block truncate text-[11px] text-violet-700 underline">{r.videoUrl}</a>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="py-3 text-center text-xs text-muted">{L("لا طلبات بعد — اطلب أول ريل احترافي فوق.", "No requests yet — request your first professional reel above.")}</p>
      )}
    </div>
  );
}
