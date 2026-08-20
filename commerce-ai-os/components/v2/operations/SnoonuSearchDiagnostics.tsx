"use client";

// MEDIA.1C-HOTFIX3 — OWNER-ONLY identity-search diagnostic panel. Runs the
// three portal searches for the current product (per storefront) via the
// owner-gated server action and renders the runtime evidence: transport
// outcome, raw row count, exact-equality survivors, and the portal's OWN
// identifier values on the first row — side by side with the internal values.
// Read-only; imports no server module, holds no client, shows no secret.

import { useState, useTransition } from "react";
import { diagnoseSnoonuIdentityAction } from "@/app/(v2)/v2/operations/media/discovery/actions";
import { SNOONU_STOREFRONT_KEYS } from "@/lib/adapters/snoonu/merchant/merchant-contract";
import type { IdentityDiagnosticReport } from "@/lib/adapters/snoonu/merchant/diagnostics.server";

const READ_LABEL: Record<string, string> = {
  ok: "نجح (2xx)",
  unauthorized: "مرفوض (401/403)",
  timeout: "مهلة",
  error: "خطأ",
  skipped: "تخطّي",
};

export default function SnoonuSearchDiagnostics({ productId }: { productId: string }) {
  const [report, setReport] = useState<IdentityDiagnosticReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const run = (storefrontKey: string) => {
    start(async () => {
      const r = await diagnoseSnoonuIdentityAction({ productId, storefrontKey });
      if ("error" in r) { setError(r.error); setReport(null); }
      else { setReport(r); setError(null); }
    });
  };

  return (
    <section className="card space-y-2 border-dashed border-slate-300">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-700">تشخيص بحث الهوية (للمالك)</h2>
        <div className="flex gap-2">
          {SNOONU_STOREFRONT_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => run(k)}
              disabled={busy}
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              dir="ltr"
            >
              {busy ? "…" : `تشخيص ${k}`}
            </button>
          ))}
        </div>
      </div>
      {error ? <p className="text-xs text-rose-600" role="alert">{error}</p> : null}
      {report ? (
        <div className="space-y-2 text-xs">
          <p className="text-slate-500" dir="ltr">
            internal → SKU: <b>{report.product.sku ?? "—"}</b> · barcode: <b>{report.product.barcode ?? "—"}</b>
            {" "}· config: <b>{report.diagnostic.configState}</b> · probe: <b>{READ_LABEL[report.diagnostic.probe]}</b>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-right text-[11px]">
              <thead className="border-b border-slate-100 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">الوضع</th>
                  <th className="px-2 py-1.5">المصطلح</th>
                  <th className="px-2 py-1.5">النقل</th>
                  <th className="px-2 py-1.5">صفوف خام</th>
                  <th className="px-2 py-1.5">مطابقة تامة</th>
                  <th className="px-2 py-1.5">عينة المنصة (SKU / باركود / اسم)</th>
                </tr>
              </thead>
              <tbody>
                {report.diagnostic.modes.map((m) => (
                  <tr key={m.mode} className="border-b border-slate-50 align-top last:border-0">
                    <td className="px-2 py-1.5 font-semibold" dir="ltr">{m.mode}</td>
                    <td className="px-2 py-1.5 font-mono" dir="ltr">{m.term ?? "—"}</td>
                    <td className="px-2 py-1.5">{READ_LABEL[m.read]}</td>
                    <td className="px-2 py-1.5">{m.read === "ok" ? m.rawCount : "—"}</td>
                    <td className="px-2 py-1.5 font-bold">{m.read === "ok" ? m.exactCount : "—"}</td>
                    <td className="px-2 py-1.5 font-mono" dir="ltr">
                      {m.sample ? `${m.sample.sku ?? "—"} / ${m.sample.barcode ?? "—"} / ${m.sample.name ?? "—"}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-400">
            قراءة النتيجة: «مرفوض» في barcode/sku مع probe ناجح = المنصة لا تقبل بحث الهوية؛ «نجح» مع صفوف خام صفر =
            لا نتيجة لهذا المصطلح؛ صفوف خام أكبر من صفر مع مطابقة تامة صفر = معرّفات المنصة تختلف عن الداخلية (انظر العينة).
          </p>
        </div>
      ) : null}
    </section>
  );
}
