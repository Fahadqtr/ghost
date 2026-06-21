"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition, useState } from "react";
import { setProductApproval } from "@/app/(app)/products/actions";

export interface RejectedItem { id: string; name_en: string | null; sku: string | null }

// Dashboard rejected list with a quick "اعتمد" (approve) button per product, so
// you can clear a rejection without leaving the dashboard.
export default function RejectedApprovalList({ items, extra }: { items: RejectedItem[]; extra: number }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const approve = (id: string) => {
    setPendingId(id);
    start(async () => {
      const res = await setProductApproval(id, "Approved");
      setPendingId(null);
      if (res?.error) alert(res.error);
      else router.refresh();
    });
  };

  return (
    <ul className="divide-y divide-red-100 px-3 pb-2">
      {items.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-2 py-2">
          <Link href={`/products/${r.id}`} className="flex min-w-0 flex-1 items-center justify-between gap-2 text-sm hover:underline">
            <span className="truncate text-ink">{r.name_en ?? "—"}</span>
            <span className="shrink-0 font-mono text-xs text-muted">{r.sku ?? "—"}</span>
          </Link>
          <button
            onClick={() => approve(r.id)}
            disabled={busy && pendingId === r.id}
            className="shrink-0 rounded-lg bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy && pendingId === r.id ? "…" : "✓ اعتمد"}
          </button>
        </li>
      ))}
      {extra > 0 ? <li className="py-2 text-xs text-muted">…and {extra} more</li> : null}
    </ul>
  );
}
