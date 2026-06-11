"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPureSeoulApproval, type PSRejected } from "@/app/(app)/import-export/pure-seoul-actions";

// Shows the products currently rejected on Pure Seoul (from pure_seoul_status,
// independent of Malika). Each row can be un-rejected, which clears its status
// in the standalone table only.
export default function PureSeoulRejectedList({ items }: { items: PSRejected[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, start] = useTransition();

  const clear = (id: string) => {
    if (!confirm("إلغاء الرفض على Pure Seoul لهذا المنتج؟ (مليكاس ما تتأثر)")) return;
    setBusyId(id);
    start(async () => {
      const res = await setPureSeoulApproval([id], "");
      setBusyId(null);
      if (res?.error) { alert(res.error); return; }
      router.refresh();
    });
  };

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">
          ⛔ مرفوضة على Pure Seoul <span className="text-muted">— {items.length}</span>
        </h3>
        <p className="text-xs text-muted">حالة مستقلة عن مليكاس. تقدر تلغي الرفض لأي منتج بدون ما تأثّر على مليكاس.</p>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-slate-400">ما في منتجات مرفوضة على Pure Seoul حاليًا.</p>
      ) : (
        <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {items.map((p) => (
            <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ink">{p.name_en ?? "—"}</span>
                  <span className="shrink-0 font-mono text-xs text-muted">{p.sku ?? "—"}</span>
                </div>
                {p.reason ? <p className="truncate text-[11px] text-red-700">السبب: {p.reason}</p> : null}
              </div>
              <button
                onClick={() => clear(p.id)}
                disabled={busyId === p.id}
                className="btn-ghost shrink-0 px-2 py-1 text-xs disabled:opacity-50"
                title="إلغاء الرفض على Pure Seoul"
              >
                {busyId === p.id ? "…" : "↩ إلغاء الرفض"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
