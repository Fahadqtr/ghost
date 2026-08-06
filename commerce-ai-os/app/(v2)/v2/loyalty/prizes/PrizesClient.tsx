"use client";

import { useState, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PrizeRecord } from "@/lib/loyalty/rewards";
import { addPrizeAction, setPrizeActiveAction, deletePrizeAction } from "../actions";

export default function PrizesClient({ prizes }: { prizes: PrizeRecord[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [isPending, startTransition] = useTransition();
  const fileId = "prize-file";
  const fileRef = useRef<File | null>(null);

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current;
    if (!file) {
      setErr("اختاري صورة الجائزة.");
      return;
    }
    setErr(null);
    setAdding(true);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append("name", name);
        fd.append("file", file);
        const res = await addPrizeAction(fd);
        if (res?.error) {
          setErr(res.error);
        } else {
          setName("");
          fileRef.current = null;
          const input = document.getElementById(fileId) as HTMLInputElement | null;
          if (input) input.value = "";
          router.refresh();
        }
      } catch (e: any) {
        setErr(e?.message ?? "تعذّرت الإضافة.");
      } finally {
        setAdding(false);
      }
    });
  }

  function toggle(p: PrizeRecord) {
    setBusyId(p.id);
    setErr(null);
    startTransition(async () => {
      try {
        await setPrizeActiveAction(p.id, !p.active);
        router.refresh();
      } catch (e: any) {
        setErr(e?.message ?? "تعذّرت العملية.");
      } finally {
        setBusyId(null);
      }
    });
  }

  function remove(p: PrizeRecord) {
    if (!confirm(`حذف الجائزة${p.name ? ` «${p.name}»` : ""}؟`)) return;
    setBusyId(p.id);
    setErr(null);
    startTransition(async () => {
      try {
        await deletePrizeAction(p.id);
        router.refresh();
      } catch (e: any) {
        setErr(e?.message ?? "تعذّر الحذف.");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* add form */}
      <form onSubmit={onAdd} className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold text-slate-700">➕ إضافة جائزة</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="mb-1 block text-xs font-semibold text-slate-500">اسم الجائزة (اختياري)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثال: ماسك الوجه"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-pink-300"
            />
          </label>
          <label className="flex-1">
            <span className="mb-1 block text-xs font-semibold text-slate-500">صورة الجائزة</span>
            <input
              id={fileId}
              type="file"
              accept="image/*"
              onChange={(e) => (fileRef.current = e.target.files?.[0] ?? null)}
              className="w-full text-sm text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-pink-100 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-pink-700"
            />
          </label>
          <button
            type="submit"
            disabled={adding}
            className="rounded-xl bg-pink-600 px-4 py-2 text-sm font-bold text-white hover:bg-pink-700 disabled:opacity-50"
          >
            {adding ? "جارٍ الرفع…" : "إضافة"}
          </button>
        </div>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      </form>

      {/* grid */}
      {prizes.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
          لا توجد جوائز بعد — أضيفي أول جائزة بالأعلى.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {prizes.map((p) => {
            const rowBusy = isPending && busyId === p.id;
            return (
              <div
                key={p.id}
                className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${
                  p.active ? "border-slate-200" : "border-slate-200 opacity-60"
                }`}
              >
                <div className="aspect-square bg-slate-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.imageUrl} alt={p.name || "جائزة"} className="h-full w-full object-cover" />
                </div>
                <div className="p-2">
                  <p className="mb-2 truncate text-center text-sm font-semibold text-slate-700">
                    {p.name || "—"}
                  </p>
                  <div className="flex gap-1">
                    <button
                      onClick={() => toggle(p)}
                      disabled={rowBusy}
                      className={`flex-1 rounded-lg py-1.5 text-xs font-bold disabled:opacity-50 ${
                        p.active
                          ? "border border-slate-200 text-slate-500 hover:bg-slate-50"
                          : "bg-emerald-600 text-white hover:bg-emerald-700"
                      }`}
                    >
                      {p.active ? "إخفاء" : "إظهار"}
                    </button>
                    <button
                      onClick={() => remove(p)}
                      disabled={rowBusy}
                      className="rounded-lg border border-red-200 px-2 py-1.5 text-xs font-bold text-red-500 hover:bg-red-50 disabled:opacity-50"
                    >
                      حذف
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
