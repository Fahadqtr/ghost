"use client";

import { useState, useTransition } from "react";
import { sendVoucherAction } from "../../actions";

export default function VoucherActions({ customerId }: { customerId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [isPending, startTransition] = useTransition();

  function sendWhatsApp() {
    setMsg(null);
    startTransition(async () => {
      try {
        const res = await sendVoucherAction(customerId);
        if (!res.configured) {
          setOk(false);
          setMsg("واتساب غير مُفعّل — تأكدي من إعداد WhatsApp (WHATSAPP_* / قالب Meta).");
        } else if (res.ok) {
          setOk(true);
          setMsg("✅ تم إرسال تأكيد الواتساب للزبونة.");
        } else {
          setOk(false);
          setMsg(`تعذّر الإرسال: ${res.error ?? "خطأ غير معروف"}`);
        }
      } catch (e: any) {
        setOk(false);
        setMsg(e?.message ?? "تعذّر الإرسال.");
      }
    });
  }

  return (
    <div data-no-print className="mb-4 flex flex-wrap items-center gap-2">
      <button
        onClick={() => window.print()}
        className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
      >
        🖨️ طباعة القسيمة
      </button>
      <button
        onClick={sendWhatsApp}
        disabled={isPending}
        className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {isPending ? "جارٍ الإرسال…" : "💬 إرسال تأكيد واتساب"}
      </button>
      {msg && (
        <span className={`text-sm ${ok ? "text-emerald-600" : "text-red-600"}`}>{msg}</span>
      )}
    </div>
  );
}
