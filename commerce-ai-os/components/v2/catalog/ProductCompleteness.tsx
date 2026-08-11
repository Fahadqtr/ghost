// Malikas V2 — Product Completeness widget (UX.4A). Presentational ONLY: it
// renders a ProductCompletenessResult (percent + per-field checklist) computed by
// lib/products/product-completeness. No state, no effects, no data access, no
// writes — it never touches the form. RTL, mobile-first. Rendered inside the
// (already client) create/edit forms, so it adds no client-JS logic of its own.

import type { CompletenessTone, ProductCompletenessResult } from "@/lib/products/product-completeness";

const TONE: Record<CompletenessTone, { bar: string; text: string; label: string }> = {
  complete: { bar: "bg-emerald-500", text: "text-emerald-700", label: "مكتمل" },
  good: { bar: "bg-amber-500", text: "text-amber-700", label: "جيد — يحتاج إكمال" },
  incomplete: { bar: "bg-rose-500", text: "text-rose-700", label: "يحتاج إكمال" },
};

export default function ProductCompleteness({ result }: { result: ProductCompletenessResult }) {
  const tone = TONE[result.tone];
  return (
    <section dir="rtl" className="card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">اكتمال المنتج</h2>
        <span className={"text-sm font-bold " + tone.text}>{result.percent}%</span>
      </div>

      <div
        className="h-2 w-full overflow-hidden rounded-full bg-[#f0e7db]"
        role="progressbar"
        aria-valuenow={result.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={"h-full rounded-full " + tone.bar} style={{ width: `${result.percent}%` }} />
      </div>
      <p className={"text-xs " + tone.text}>{tone.label}</p>

      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
        {result.checks.map((c) => (
          <li key={c.code} className="flex items-center gap-1.5 text-xs">
            <span aria-hidden className={c.passed ? "text-emerald-600" : "text-rose-500"}>
              {c.passed ? "✓" : "✗"}
            </span>
            <span className={c.passed ? "text-ink" : "text-muted"}>{c.label}</span>
            {c.required ? null : <span className="text-[10px] text-muted">(اختياري)</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
