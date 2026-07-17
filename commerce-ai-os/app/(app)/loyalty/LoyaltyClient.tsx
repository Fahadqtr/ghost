"use client";

import { useState, useTransition } from "react";
import type { PendingSubmission, ReadyCustomer } from "@/lib/loyalty/rewards";
import { approveAction, rejectAction, redeemAction } from "./actions";

export default function LoyaltyClient({
  pending,
  ready,
  required,
}: {
  pending: PendingSubmission[];
  ready: ReadyCustomer[];
  required: number;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    setErr(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (e: any) {
        setErr(e?.message ?? "تعذّرت العملية.");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="space-y-8">
      {/* Rewards ready to redeem */}
      {ready.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-bold text-slate-700">
            🎁 جاهزات للاستبدال ({ready.length})
          </h2>
          <div className="space-y-2">
            {ready.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-pink-200 bg-pink-50 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  {c.chosenPrizeImage && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.chosenPrizeImage}
                      alt={c.chosenPrizeName ?? "الجائزة"}
                      className="h-12 w-12 rounded-lg border border-pink-200 object-cover"
                    />
                  )}
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{c.name}</p>
                    <p dir="ltr" className="text-xs text-slate-500">{c.phone}</p>
                    <p className="text-xs font-semibold text-pink-700">
                      {c.chosenPrizeName
                        ? `اختارت: ${c.chosenPrizeName || "جائزة"}`
                        : c.chosenPrizeImage
                        ? "اختارت جائزة"
                        : "لم تختر جائزة بعد"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() =>
                    run(c.id, async () => {
                      if (confirm(`تأكيد استبدال هدية ${c.name}؟ ستبدأ بطاقة جديدة.`))
                        await redeemAction(c.id);
                    })
                  }
                  disabled={isPending && busyId === c.id}
                  className="shrink-0 rounded-lg bg-pink-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-pink-700 disabled:opacity-50"
                >
                  تم التسليم — بطاقة جديدة
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Pending review queue */}
      <section>
        <h2 className="mb-2 text-sm font-bold text-slate-700">
          ⏳ بانتظار المراجعة ({pending.length})
        </h2>

        {err && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>
        )}

        {pending.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
            لا توجد صور بانتظار المراجعة الآن.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {pending.map((s) => (
              <div
                key={s.id}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
              >
                <a href={s.imageUrl} target="_blank" rel="noreferrer" className="block bg-slate-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={s.imageUrl}
                    alt="صورة التقييم"
                    className="max-h-72 w-full object-contain"
                  />
                </a>
                <div className="p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-800">{s.name}</p>
                      <p dir="ltr" className="text-xs text-slate-500">{s.phone}</p>
                    </div>
                    <span className="rounded-full bg-pink-100 px-2 py-0.5 text-xs font-bold text-pink-700">
                      {s.stamps}/{required} ❤
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => run(s.id, () => approveAction(s.id))}
                      disabled={isPending && busyId === s.id}
                      className="flex-1 rounded-lg bg-emerald-600 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      ✓ اعتماد وختم قلب
                    </button>
                    <button
                      onClick={() =>
                        run(s.id, async () => {
                          const note = prompt("سبب الرفض (اختياري):") ?? undefined;
                          await rejectAction(s.id, note);
                        })
                      }
                      disabled={isPending && busyId === s.id}
                      className="flex-1 rounded-lg border border-slate-200 bg-white py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      ✕ رفض
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
