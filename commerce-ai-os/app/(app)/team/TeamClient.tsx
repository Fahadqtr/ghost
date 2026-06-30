"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addStaff, setStaffActive, deleteStaff, type StaffMember } from "./actions";
import type { Locale } from "@/lib/i18n";

const rndPin = () => String(Math.floor(1000 + Math.random() * 9000)); // 4-digit

export default function TeamClient({ initialMembers, locale = "ar" }: { initialMembers: StaffMember[]; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [name, setName] = useState("");
  const [pin, setPin] = useState(rndPin());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();

  const flash = (ok: boolean, text: string) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 3000); };
  const refresh = () => router.refresh();

  const add = () => {
    start(async () => {
      const r = await addStaff(name, pin);
      if (r && "error" in r && r.error) { flash(false, r.error); return; }
      flash(true, L(`أُضيف ${name} برمز ${pin}`, `Added ${name} · code ${pin}`));
      setName(""); setPin(rndPin());
      refresh();
    });
  };

  const toggle = (m: StaffMember) => start(async () => {
    const r = await setStaffActive(m.id, !m.active);
    if (r && "error" in r && r.error) { flash(false, r.error); return; }
    setMembers((ms) => ms.map((x) => (x.id === m.id ? { ...x, active: !x.active } : x)));
  });

  const remove = (m: StaffMember) => {
    if (!confirm(L(`حذف الموظف «${m.name}»؟`, `Delete employee "${m.name}"?`))) return;
    start(async () => {
      const r = await deleteStaff(m.id);
      if (r && "error" in r && r.error) { flash(false, r.error); return; }
      setMembers((ms) => ms.filter((x) => x.id !== m.id));
    });
  };

  return (
    <div className="space-y-4">
      {/* add form */}
      <div className="card space-y-3">
        <p className="text-sm font-semibold text-ink">{L("إضافة موظف", "Add employee")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex-1 text-xs text-muted">{L("الاسم", "Name")}
            <input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder={L("مثال: سارة", "e.g. Sara")} onKeyDown={(e) => e.key === "Enter" && add()} />
          </label>
          <label className="text-xs text-muted">{L("الرمز", "Code")}
            <input className="input mt-1 w-28 tracking-widest" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))} inputMode="numeric" />
          </label>
          <button onClick={() => setPin(rndPin())} className="btn-ghost px-3 py-2 text-xs" title={L("رمز عشوائي", "Random code")}>🎲</button>
          <button onClick={add} disabled={busy || !name.trim()} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{L("إضافة", "Add")}</button>
        </div>
        {msg ? <p className={`text-xs ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</p> : null}
      </div>

      {/* list */}
      {members.length === 0 ? (
        <div className="card py-8 text-center text-sm text-slate-400">{L("ما فيه موظفين بعد — أضف أول واحد فوق.", "No employees yet — add your first above.")}</div>
      ) : (
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.id} className={`flex items-center gap-3 rounded-xl border p-2.5 ${m.active ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"}`}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm font-bold text-violet-700">{m.name.slice(0, 1)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{m.name}</p>
                <p className="text-xs text-muted">{L("الرمز:", "Code:")} <span className="font-mono font-bold tracking-widest text-ink">{m.pin}</span></p>
              </div>
              {!m.active ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] text-slate-600">{L("معطّل", "Disabled")}</span> : null}
              <button disabled={busy} onClick={() => toggle(m)} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                {m.active ? L("تعطيل", "Disable") : L("تفعيل", "Enable")}
              </button>
              <button disabled={busy} onClick={() => remove(m)} className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50">{L("حذف", "Delete")}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
