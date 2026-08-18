"use client";

// MEDIA.1A-P — Snoonu Connection Manager (PRESENTATIONAL + read-only Test action).
// Shows each storefront's session state independently and offers a read-only "Test
// Connection" action. It never collects a secret in the UI (secrets are provisioned
// out-of-band into server env), never displays secret material, and performs no
// write. CONNECTED appears only when a real authenticated read proves the session.

import { useState, useTransition } from "react";
import { testSnoonuConnection } from "@/app/(v2)/v2/operations/media/discovery/actions";
import { SESSION_STATE_LABEL } from "@/lib/adapters/snoonu/merchant/session-status";
import type { SnoonuSessionState, SnoonuSessionStatus } from "@/lib/adapters/snoonu/merchant/session-status";

const STATE_TONE: Record<SnoonuSessionState, string> = {
  CONNECTED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  STALE: "border-amber-200 bg-amber-50 text-amber-700",
  EXPIRED: "border-amber-200 bg-amber-50 text-amber-700",
  SESSION_REQUIRED: "border-sky-200 bg-sky-50 text-sky-700",
  UNKNOWN: "border-slate-200 bg-slate-50 text-slate-600",
  ERROR: "border-rose-200 bg-rose-50 text-rose-700",
};

const STOREFRONT_LABEL: Record<string, string> = {
  "snoonu:malikas": "Snoonu — Malikas",
  "snoonu:pure_seoul": "Snoonu — Pure Seoul",
};

function Row({ initial }: { initial: SnoonuSessionStatus }) {
  const [status, setStatus] = useState<SnoonuSessionStatus>(initial);
  const [busy, start] = useTransition();

  const test = () => {
    start(async () => {
      const next = await testSnoonuConnection(status.storefrontKey);
      setStatus(next);
    });
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <div>
        <div className="text-sm font-bold text-ink" dir="ltr">{STOREFRONT_LABEL[status.storefrontKey] ?? status.storefrontKey}</div>
        <div className="text-[11px] text-slate-400">{status.configured ? "السر مُهيّأ في الخادم" : "لا يوجد سر مُهيّأ"}</div>
      </div>
      <div className="flex items-center gap-2">
        <span className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold ${STATE_TONE[status.state]}`}>
          {SESSION_STATE_LABEL[status.state]}
        </span>
        <button
          type="button"
          onClick={test}
          disabled={busy}
          className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? "…يختبر" : "اختبار الاتصال"}
        </button>
      </div>
    </div>
  );
}

export default function SnoonuConnectionManager({ statuses }: { statuses: SnoonuSessionStatus[] }) {
  return (
    <section className="card space-y-2">
      <div>
        <h2 className="text-sm font-bold text-slate-700">حالة اتصال Snoonu</h2>
        <p className="text-[11px] text-slate-400">
          الجلسة تُزوَّد خارج التطبيق في إعدادات الخادم (لكل متجر سرّ منفصل). لا يُدخل أي سرّ من الواجهة.
          «متصل» يظهر فقط عند إثبات قراءة مصادَقة حقيقية.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {statuses.map((s) => <Row key={s.storefrontKey} initial={s} />)}
      </div>
    </section>
  );
}
