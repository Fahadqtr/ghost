"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveMovements, reverseMovement, type StaffMove } from "../approvals-actions";

function fmt(s: string | null) {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ar", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function ApprovalsClient({ initialRows, initialPending }: { initialRows: StaffMove[]; initialPending: number }) {
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
      setNote(`✓ اعتمدت ${ids.length} حركة`);
      setTimeout(refresh, 600);
    });
  };

  const reverse = (m: StaffMove) => {
    if (!confirm(`عكس الحركة؟ راح ترجّع المخزون: ${m.dir === "in" ? "إخراج" : "إدخال"} ${m.qty} من «${m.name ?? m.sku}».`)) return;
    start(async () => {
      const r = await reverseMovement(m.id);
      if (r && "error" in r && r.error) { setNote(r.error); return; }
      setRows((rs) => rs.map((x) => (x.id === m.id ? { ...x, review: "reversed" } : x)));
      setNote("↩︎ تم عكس الحركة وإرجاع المخزون");
      setTimeout(refresh, 600);
    });
  };

  return (
    <div className="space-y-3">
      {/* tabs + bulk approve */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
          <button onClick={() => setTab("pending")} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "pending" ? "bg-violet-600 text-white" : "text-slate-600"}`}>
            بانتظار المراجعة {pending.length > 0 && <span className="ml-1 rounded-full bg-amber-400 px-1.5 text-[11px] text-amber-900">{pending.length}</span>}
          </button>
          <button onClick={() => setTab("all")} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "all" ? "bg-violet-600 text-white" : "text-slate-600"}`}>الكل ({rows.length})</button>
        </div>
        {tab === "pending" && pending.length > 0 ? (
          <button disabled={busy} onClick={() => approve(pending.map((p) => p.id))} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50">✓ اعتماد الكل ({pending.length})</button>
        ) : null}
      </div>

      {note ? <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{note}</div> : null}

      {shown.length === 0 ? (
        <div className="card py-10 text-center text-sm text-slate-400">{tab === "pending" ? "ما فيه حركات بانتظار المراجعة 🎉" : "ما فيه حركات بعد."}</div>
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
                  <span className={`rounded px-1.5 py-0.5 font-bold ${m.dir === "in" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                    {m.dir === "in" ? "➕ إدخال" : "➖ إخراج"} {m.qty}
                  </span>
                  <span>👤 {m.by || "—"}</span>
                  {m.reason ? <span>· {m.reason}</span> : null}
                  <span className="text-slate-400">· {fmt(m.at)}</span>
                </div>
              </div>
              {m.review === "pending" ? (
                <div className="flex shrink-0 flex-col gap-1">
                  <button disabled={busy} onClick={() => approve([m.id])} className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white disabled:opacity-50">✓ اعتمدت</button>
                  <button disabled={busy} onClick={() => reverse(m)} className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">↩︎ عكس</button>
                </div>
              ) : (
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${m.review === "approved" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>
                  {m.review === "approved" ? "✓ معتمدة" : "↩︎ معكوسة"}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
