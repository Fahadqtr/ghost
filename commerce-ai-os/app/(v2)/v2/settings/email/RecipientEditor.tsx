"use client";

// /v2/settings/email — the recipient editor (client island).
//
// Saving here changes the SAVED DEFAULT for a channel. It is deliberately not
// the same act as choosing where one email goes: the send screen prefills from
// this value and lets the owner type a different address for that send. So the
// copy says «افتراضي» throughout, and the note below states the per-send rule
// explicitly — a saved address must never read as a destination the system is
// committed to.

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RecipientEditor({
  channel, initialTo, initialCc, bccSupported,
}: {
  channel: "talabat" | "rafeeq";
  initialTo: string;
  initialCc: string;
  bccSupported: boolean;
}) {
  const router = useRouter();
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState(initialCc);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setState("saving");
    setError(null);
    try {
      const res = await fetch("/api/settings/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, to, cc }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(typeof body?.message_ar === "string" ? body.message_ar : "تعذّر الحفظ.");
        setState("idle");
        return;
      }
      setState("saved");
      router.refresh();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      setState("idle");
    }
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="mb-1 block text-slate-600">المستلم الافتراضي (To)</span>
        <input
          type="text" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)}
          placeholder="اكتب عنوان البريد"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-600">نسخة افتراضية (CC) — اختياري</span>
        <input
          type="text" dir="ltr" value={cc} onChange={(e) => setCc(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
        />
      </label>
      {!bccSupported ? (
        <p className="text-xs text-slate-500">
          النسخة المخفية (BCC) غير مدعومة حالياً — طبقة الإرسال المشتركة ترسل To وCC فقط.
        </p>
      ) : null}
      {error ? <p className="text-sm text-rose-700" role="alert">{error}</p> : null}
      <div className="flex items-center gap-3">
        <button
          type="button" onClick={() => void save()} disabled={state === "saving"}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {state === "saving" ? "جارٍ الحفظ…" : "حفظ الافتراضي"}
        </button>
        {state === "saved" ? <span className="text-sm text-emerald-700">تم الحفظ</span> : null}
      </div>
    </div>
  );
}
