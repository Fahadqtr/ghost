"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CustomerRecord } from "@/lib/loyalty/rewards";
import { updateCustomerAction, deleteCustomerAction } from "../actions";

export default function CustomersTable({
  rows,
  required,
}: {
  rows: CustomerRecord[];
  required: number;
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // draft fields while editing a row
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [stamps, setStamps] = useState(0);

  function beginEdit(r: CustomerRecord) {
    setEditingId(r.id);
    setName(r.name);
    setPhone(r.phone);
    setStamps(r.stamps);
    setErr(null);
  }

  function save(id: string) {
    setBusyId(id);
    setErr(null);
    startTransition(async () => {
      try {
        await updateCustomerAction(id, { name, phone, stamps });
        setEditingId(null);
        router.refresh();
      } catch (e: any) {
        setErr(e?.message ?? "تعذّر الحفظ.");
      } finally {
        setBusyId(null);
      }
    });
  }

  function remove(r: CustomerRecord) {
    if (!confirm(`حذف ${r.name} نهائياً؟ ستُحذف كل صور تقييماتها أيضاً.`)) return;
    setBusyId(r.id);
    setErr(null);
    startTransition(async () => {
      try {
        await deleteCustomerAction(r.id);
        router.refresh();
      } catch (e: any) {
        setErr(e?.message ?? "تعذّر الحذف.");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      {err && (
        <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">{err}</p>
      )}
      <table className="w-full text-right text-sm">
        <thead className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
          <tr>
            <th className="px-4 py-3 font-semibold">الاسم</th>
            <th className="px-4 py-3 font-semibold">رقم الجوال</th>
            <th className="px-4 py-3 font-semibold">القلوب</th>
            <th className="px-4 py-3 font-semibold">الهدايا</th>
            <th className="px-4 py-3 font-semibold">آخر نشاط</th>
            <th className="px-4 py-3 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const editing = editingId === r.id;
            const rowBusy = isPending && busyId === r.id;
            return (
              <tr key={r.id} className="border-b border-slate-50 last:border-0 align-middle">
                {editing ? (
                  <>
                    <td className="px-4 py-3">
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-sm outline-none focus:border-pink-300"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        dir="ltr"
                        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-right text-sm outline-none focus:border-pink-300"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        min={0}
                        max={required}
                        value={stamps}
                        onChange={(e) => setStamps(Number(e.target.value))}
                        className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-sm outline-none focus:border-pink-300"
                      />
                      <span className="ms-1 text-xs text-slate-400">/{required}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{r.cyclesCompleted}</td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button
                          onClick={() => save(r.id)}
                          disabled={rowBusy}
                          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          حفظ
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          disabled={rowBusy}
                          className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-500 hover:bg-slate-50"
                        >
                          إلغاء
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 font-semibold text-slate-800">
                      {r.name}
                      {r.rewardReady && (
                        <span className="mr-2 rounded-full bg-pink-100 px-2 py-0.5 text-[10px] font-bold text-pink-700">
                          🎁 جاهزة
                        </span>
                      )}
                    </td>
                    <td dir="ltr" className="px-4 py-3 text-right text-slate-500">{r.phone}</td>
                    <td className="px-4 py-3">
                      <span className="whitespace-nowrap" title={`${r.stamps} من ${required}`}>
                        {"❤".repeat(r.stamps)}
                        <span className="text-slate-200">{"❤".repeat(required - r.stamps)}</span>
                        <span className="ms-1 text-xs text-slate-400">
                          {r.stamps}/{required}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.cyclesCompleted}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{r.updatedAt.slice(0, 10)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button
                          onClick={() => beginEdit(r)}
                          disabled={rowBusy}
                          className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          تعديل
                        </button>
                        <button
                          onClick={() => remove(r)}
                          disabled={rowBusy}
                          className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-500 hover:bg-red-50 disabled:opacity-50"
                        >
                          حذف
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
