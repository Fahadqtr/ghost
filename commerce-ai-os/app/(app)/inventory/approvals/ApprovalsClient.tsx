"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveMovements, reverseMovement, editMovement, deleteMovement, type StaffMove } from "../approvals-actions";
import type { Locale } from "@/lib/i18n";

function fmt(s: string | null, locale: Locale) {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function ApprovalsClient({ initialRows, initialPending, locale = "ar" }: { initialRows: StaffMove[]; initialPending: number; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [busy, start] = useTransition();
  const [note, setNote] = useState("");

  const pending = useMemo(() => rows.filter((r) => r.review === "pending"), [rows]);
  const shown = tab === "pending" ? pending : rows;

  const refresh = () => { setNote(""); router.refresh(); };

  const approve = (ids: number[]) => {
    if (!ids.length) return;
    start(async () => {
      const r = await approveMovements(ids);
      if (r && "error" in r && r.error) { setNote(r.error); return; }
      setRows((rs) => rs.map((x) => (ids.includes(x.id) ? { ...x, review: "approved" } : x)));
      setNote(L(`✓ اعتمدت ${ids.length} حركة`, `✓ Approved ${ids.length} movement(s)`));
      setTimeout(refresh, 600);
    });
  };

  const reverse = (m: StaffMove) => {
    const undo = m.dir === "in" ? L("إخراج", "out") : L("إدخال", "in");
    if (!confirm(L(`عكس الحركة؟ راح ترجّع المخزون: ${undo} ${m.qty} من «${m.name ?? m.sku}».`, `Reverse this movement? Stock will be ${undo} ${m.qty} of "${m.name ?? m.sku}".`))) return;
    start(async () => {
      const r = await reverseMovement(m.id);
      if (r && "error" in r && r.error) { setNote(r.error); return; }
      setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, review: "reversed" } : x)));
      setNote(L("↩︎ تم عكس الحركة وإرجاع المخزون", "↩︎ Movement reversed, stock restored"));
      setTimeout(refresh, 600);
    });
  };

  const edit = (m: StaffMove) => {
    const entered = prompt(L(`الكمية الجديدة لـ «${m.name ?? m.sku}» (الحالية ${m.qty}):`, `New quantity for "${m.name ?? m.sku}" (current ${m.qty}):`), String(m.qty));
    if (entered == null) return;
    const q = Math.floor(Number(entered));
    if (!q || q < 1) { setNote(L("كمية غير صحيحة.", "Invalid quantity.")); return; }
    if (q === m.qty) return;
    start(async () => {
      const r = await editMovement(m.id, q);
      if (r && "error" in r && r.error) { setNote(r.error); return; }
      setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, qty: q, edited: { from: m.qty, to: q, by: L("المدير", "manager") } } : x)));
      setNote(L(`✏️ عُدّلت الكمية إلى ${q}`, `✏️ Quantity changed to ${q}`));
      setTimeout(refresh, 600);
    });
  };

  const del = (m: StaffMove) => {
    if (!confirm(L(`حذف الحركة؟ راح يُرجَّع المخزون وتُعلَّم كمحذوفة.`, `Delete this movement? Stock will be restored and it will be marked deleted.`))) return;
    start(async () => {
      const r = await deleteMovement(m.id);
      if (r && "error" in r && r.error) { setNote(r.error); return; }
      setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, review: "deleted" } : x)));
      setNote(L("🗑 تم حذف الحركة وإرجاع المخزون", "🗑 Movement deleted, stock restored"));
      setTimeout(refresh, 600);
    });
  };

  return (
    <div className="space-y-3">
      {/* tabs + bulk approve */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
          <button onClick={() => setTab("pending")} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "pending" ? "bg-violet-600 text-white" : "text-slate-600"}`}>
            {L("بانتظار المراجعة", "Pending review")} {pending.length > 0 && <span className="ml-1 rounded-full bg-amber-400 px-1.5 text-[11px] text-amber-900">{pending.length}</span>}
          </button>
          <button onClick={() => setTab("all")} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "all" ? "bg-violet-600 text-white" : "text-slate-600"}`}>{L("الكل", "All")} ({rows.length})</button>
        </div>
        {tab === "pending" && pending.length > 0 ? (
          <button disabled={busy} onClick={() => approve(pending.map((p) => p.id))} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50">{L("✓ اعتماد الكل", "✓ Approve all")} ({pending.length})</button>
        ) : null}
      </div>

      {note ? <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{note}</div> : null}

      {shown.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-400">{tab === "pending" ? L("ما فيه حركات بانتظار المراجعة 🎉", "Nothing awaiting review 🎉") : L("ما فيه حركات بعد.", "No movements yet.")}</div>
      ) : (
        <div className="space-y-2">
          {shown.map((m) => (
            <div key={m.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-2.5">
              <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                {m.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.image} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-slate-300">📦</span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{m.name ?? m.sku ?? "—"}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                  <span className={`rounded-sm px-1.5 py-0.5 font-bold ${m.dir === "in" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                    {m.dir === "in" ? L("➕ إدخال", "➕ In") : L("➖ إخراج", "➖ Out")} {m.qty}
                  </span>
                  <span>👤 {m.by || "—"}</span>
                  {m.reason ? <span>· {m.reason}</span> : null}
                  <span className="text-slate-400">· {fmt(m.at, locale)}</span>
                  {m.edited ? <span className="rounded-sm bg-blue-50 px-1.5 py-0.5 font-medium text-blue-600">{L(`✏️ عُدّلت ${m.edited.from}→${m.edited.to} (${m.edited.by})`, `✏️ edited ${m.edited.from}→${m.edited.to} (${m.edited.by})`)}</span> : null}
                </div>
              </div>
              {m.review === "pending" ? (
                <div className="flex shrink-0 flex-col gap-1">
                  <button disabled={busy} onClick={() => approve([m.id])} className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white disabled:opacity-50">{L("✓ اعتمدت", "✓ Approve")}</button>
                  <div className="flex gap-1">
                    <button disabled={busy} onClick={() => edit(m)} className="flex-1 rounded-md border border-blue-200 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50">{L("✏️ تعديل", "✏️ Edit")}</button>
                    <button disabled={busy} onClick={() => del(m)} className="flex-1 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">{L("🗑 حذف", "🗑 Delete")}</button>
                  </div>
                </div>
              ) : (
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${m.review === "approved" ? "bg-emerald-50 text-emerald-700" : m.review === "deleted" ? "bg-slate-100 text-slate-500" : "bg-red-50 text-red-600"}`}>
                  {m.review === "approved" ? L("✓ معتمدة", "✓ Approved") : m.review === "deleted" ? L("🗑 محذوفة", "🗑 Deleted") : L("↩︎ معكوسة", "↩︎ Reversed")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
