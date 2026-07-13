"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setProductApproval } from "@/app/(app)/products/actions";
import ProductThumb from "@/components/ProductThumb";

// The approval center's main list: staff-submitted products awaiting the
// owner. Approve fires the whole downstream (platforms task + Talabat queue)
// through setProductApproval; reject asks for an optional reason.

export interface PendingProduct {
  id: string;
  sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  image_url: string | null;
  price: number | null;
  discount_price: number | null;
  main_category: string | null;
  submittedBy: string | null; // from the staff-new:<name> marker
  created_at: string | null;
}

export default function PendingProductsList({ items, locale = "ar" }: { items: PendingProduct[]; locale?: string }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, start] = useTransition();

  const act = (p: PendingProduct, approval: "Approved" | "Rejected", reason?: string) => {
    setBusyId(p.id); setMsg("");
    start(async () => {
      const r = await setProductApproval(p.id, approval, reason);
      setBusyId(null);
      if (r?.error) { setMsg(`❌ ${r.error}`); return; }
      setGone((s) => new Set(s).add(p.id));
      setMsg(approval === "Approved"
        ? L(`✅ اعتمدت «${p.name_en ?? p.sku ?? ""}» — انفتحت مهمة المنصات ودخل طابور طلبات.`, `✅ Approved "${p.name_en ?? p.sku ?? ""}" — platforms task opened + queued for Talabat.`)
        : L(`🚫 رفضت «${p.name_en ?? p.sku ?? ""}».`, `🚫 Rejected "${p.name_en ?? p.sku ?? ""}".`));
      router.refresh();
    });
  };

  const reject = (p: PendingProduct) => {
    const reason = prompt(L("سبب الرفض (اختياري):", "Rejection reason (optional):"));
    if (reason === null) return; // cancelled
    act(p, "Rejected", reason);
  };

  const visible = items.filter((p) => !gone.has(p.id));

  return (
    <div className="space-y-2">
      {msg ? <p className="rounded-lg bg-[#faf6f0] px-3 py-2 text-xs text-ink/80">{msg}</p> : null}
      {visible.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">✅ {L("ما في منتجات بانتظار اعتمادك.", "Nothing awaiting your approval.")}</p>
      ) : null}
      {visible.map((p) => {
        const eff = Number(p.discount_price) > 0 ? p.discount_price : p.price;
        return (
          <div key={p.id} className="flex items-center gap-3 rounded-xl border border-[#efe3d6] bg-white p-2.5">
            <ProductThumb imageUrl={p.image_url} sku={p.sku} sizeClass="h-14 w-14" label={L("بدون صورة", "No photo")} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink">{p.name_en || p.name_ar || p.sku || "—"}</p>
              <p className="mt-0.5 truncate text-xs text-muted">
                {p.sku ?? "—"}
                {p.main_category ? ` · ${p.main_category}` : ""}
                {eff != null ? ` · ${eff} ${L("ر.ق", "QAR")}` : ` · ⛔ ${L("بدون سعر", "no price")}`}
              </p>
              {p.submittedBy ? (
                <span className="mt-1 inline-block rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-700">👤 {p.submittedBy}</span>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
              <a href={`/products/${p.id}/edit`} target="_blank" rel="noreferrer" className="btn-ghost px-2.5 py-1.5 text-center text-xs">✏️</a>
              <button disabled={busyId === p.id} onClick={() => reject(p)}
                className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50">
                ✗ {L("ارفض", "Reject")}
              </button>
              <button disabled={busyId === p.id} onClick={() => act(p, "Approved")}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                {busyId === p.id ? "…" : `✓ ${L("اعتمد", "Approve")}`}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
