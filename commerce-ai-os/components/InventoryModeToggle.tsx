"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { switchInventoryMode } from "@/app/(app)/inventory/actions";
import type { InventoryMode } from "@/lib/settings";
import type { Locale } from "@/lib/i18n";

// System-wide switch: track exact quantities, or just In-stock / Out-of-stock.
export default function InventoryModeToggle({ mode, locale = "ar" }: { mode: InventoryMode; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [busy, start] = useTransition();
  const [err, setErr] = useState("");
  const router = useRouter();

  const flip = (next: InventoryMode) => {
    if (next === mode || busy) return;
    setErr("");
    start(async () => {
      const r = await switchInventoryMode(next);
      if (!r.ok) { setErr(r.error ?? ""); return; }
      router.refresh();
    });
  };

  const simple = mode === "simple";
  return (
    <div className="card flex flex-col gap-2 border-[#efe3d6] p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">
          ⚙️ {L("نظام المخزون", "Inventory system")} ·{" "}
          <span className={simple ? "text-violet-700" : "text-emerald-700"}>
            {simple ? L("متوفر / نفذ فقط", "In / Out of stock only") : L("تتبّع الكميات", "Quantity tracking")}
          </span>
        </p>
        <p className="text-xs text-muted">
          {simple
            ? L("النظام مبسّط — كل منتج «متوفر» أو «نفذ» بدون أرقام.", "Simplified — each product is just In or Out of stock, no numbers.")
            : L("النظام يتتبّع كميات المخزون بالتفصيل.", "The system tracks exact stock quantities.")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 p-1">
        <button
          onClick={() => flip("quantities")}
          disabled={busy}
          className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${!simple ? "bg-white text-emerald-700 shadow-sm ring-1 ring-emerald-200" : "text-slate-500"}`}
        >
          🔢 {L("كميات", "Quantities")}
        </button>
        <button
          onClick={() => flip("simple")}
          disabled={busy}
          className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${simple ? "bg-white text-violet-700 shadow-sm ring-1 ring-violet-200" : "text-slate-500"}`}
        >
          ✅ {L("متوفر/نفذ", "In / Out")}
        </button>
      </div>
      {err ? <p className="w-full text-xs text-red-600 sm:w-auto">{err}</p> : null}
    </div>
  );
}
