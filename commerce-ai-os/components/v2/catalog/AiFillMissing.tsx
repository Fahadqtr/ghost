"use client";

// UX.4D-2 — AI "fill missing" panel. Client component, propose-only. It calls the
// server action to GET a proposal (no DB write), previews each field (current vs
// proposed) with a checkbox, and applies the chosen changes to the parent form
// via `onApply(patch)` — the fill/overwrite decision is owned by the pure
// planFillForm, never re-implemented here. It never saves. RTL, mobile-first.
// Reusable by Create later (same props shape).

import { useState, useTransition } from "react";
import { generateProductFillProposal, type FillVerification } from "@/app/(v2)/v2/catalog/generation-actions";
import {
  PROPOSAL_FIELD_LABELS,
  PROPOSAL_SCALAR_MAP,
  planFillForm,
} from "@/lib/products/product-generation-form";
import { PRODUCT_GENERATION_FIELDS, type ProductGenerationField, type ProductGenerationProposal } from "@/lib/products/product-generation";
import { matchBrandId, type BrandOption } from "@/lib/products/brand-match";

function clamp(v: string, n = 90): string {
  const t = v.trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export default function AiFillMissing({
  currentScalars,
  imageUrl,
  brands,
  onApply,
}: {
  currentScalars: Record<string, string>;
  imageUrl: string | null;
  brands: readonly BrandOption[];
  onApply: (patch: Record<string, string>) => void;
}) {
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProductGenerationProposal | null>(null);
  const [verification, setVerification] = useState<FillVerification | null>(null);
  const [checked, setChecked] = useState<Set<ProductGenerationField>>(new Set());

  const currentOf = (f: ProductGenerationField): string =>
    f === "brand"
      ? brands.find((b) => b.id === currentScalars.brand_id)?.name ?? ""
      : currentScalars[PROPOSAL_SCALAR_MAP[f as Exclude<ProductGenerationField, "brand">]] ?? "";

  const isMissing = (f: ProductGenerationField): boolean => currentOf(f).trim() === "";

  function generate() {
    setError(null);
    setProposal(null);
    setVerification(null);
    startTransition(async () => {
      const res = await generateProductFillProposal({
        current: {
          name_en: currentScalars.name_en,
          name_ar: currentScalars.name_ar,
          description_en: currentScalars.description_en,
          description_ar: currentScalars.description_ar,
          main_category: currentScalars.main_category,
        },
        imageUrl,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const reviewRequired = res.proposal.confidence === "low";
      // Default-check the fields that "apply missing" would fill.
      const preset = new Set<ProductGenerationField>();
      if (!reviewRequired) {
        for (const f of PRODUCT_GENERATION_FIELDS) {
          const proposed = (res.proposal[f] ?? "").toString().trim();
          if (!proposed || !isMissing(f)) continue;
          if (f === "brand" && matchBrandId(brands, proposed) === "") continue;
          preset.add(f);
        }
      }
      setProposal(res.proposal);
      setVerification(res.verification);
      setChecked(preset);
    });
  }

  function toggle(f: ProductGenerationField) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  function applyMissing() {
    if (!proposal) return;
    const plan = planFillForm(currentScalars, proposal, brands, { mode: "fill-missing" });
    onApply(plan.patch);
    reset();
  }

  function applySelected() {
    if (!proposal) return;
    const plan = planFillForm(currentScalars, proposal, brands, {
      mode: "overwrite-selected",
      fields: [...checked],
    });
    onApply(plan.patch);
    reset();
  }

  function reset() {
    setProposal(null);
    setVerification(null);
    setChecked(new Set());
    setError(null);
  }

  // Offered fields (proposal has a non-blank value), in canonical order.
  const offered = proposal
    ? PRODUCT_GENERATION_FIELDS.filter((f) => (proposal[f] ?? "").toString().trim() !== "")
    : [];
  const reviewRequired = proposal?.confidence === "low";
  const verifyWarn =
    verification && (verification.imageMatches === false || verification.arMatchesEn === false);

  return (
    <section dir="rtl" className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">إكمال البيانات بالذكاء الاصطناعي</h2>
        <button type="button" className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50" disabled={busy} onClick={generate}>
          {busy ? "جارٍ التحليل…" : "✨ إكمال البيانات الناقصة"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      ) : null}

      {proposal ? (
        <div className="space-y-3">
          {reviewRequired ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              ثقة التحليل منخفضة — لن يُطبَّق شيء تلقائيًا. راجِع الحقول واختَر يدويًا.
            </p>
          ) : null}

          {verification ? (
            <div className="space-y-1 rounded-lg bg-[#faf6f1] px-3 py-2 text-xs text-muted">
              {verification.imageMatches !== null ? (
                <p>مطابقة الصورة: {verification.imageMatches ? "نعم" : "لا ⚠️"}</p>
              ) : null}
              {verification.arMatchesEn !== null ? (
                <p>تطابق العربي مع الإنجليزي: {verification.arMatchesEn ? "نعم" : "لا ⚠️"}</p>
              ) : null}
              {verification.notes ? <p>ملاحظة: {verification.notes}</p> : null}
            </div>
          ) : null}

          {verifyWarn ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              راجِع النتائج بعناية قبل التطبيق (احتمال عدم تطابق).
            </p>
          ) : null}

          {offered.length === 0 ? (
            <p className="text-xs text-muted">لا توجد اقتراحات جديدة.</p>
          ) : (
            <ul className="space-y-2">
              {offered.map((f) => {
                const proposed = (proposal[f] ?? "").toString();
                const cur = currentOf(f);
                const brandUnmatched = f === "brand" && matchBrandId(brands, proposed) === "";
                return (
                  <li key={f} className="rounded-lg border border-[#efe3d6] p-2 text-xs">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked.has(f)}
                        disabled={busy || brandUnmatched}
                        onChange={() => toggle(f)}
                      />
                      <span className="min-w-0 flex-1 space-y-0.5">
                        <span className="block font-semibold text-ink">
                          {PROPOSAL_FIELD_LABELS[f]}
                          {isMissing(f) ? <span className="mr-1 text-emerald-600"> (ناقص)</span> : null}
                          {brandUnmatched ? <span className="mr-1 text-amber-700"> (غير مطابقة لعلامة معروفة)</span> : null}
                        </span>
                        {cur ? <span className="block text-muted">الحالي: {clamp(cur)}</span> : null}
                        <span className="block text-ink">المقترح: {clamp(proposed)}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50" disabled={busy || reviewRequired} onClick={applyMissing}>
              تطبيق البيانات الناقصة
            </button>
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50" disabled={busy || checked.size === 0} onClick={applySelected}>
              تطبيق المحدد ({checked.size})
            </button>
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-50" disabled={busy} onClick={reset}>
              إلغاء
            </button>
          </div>
          <p className="text-[11px] text-muted">لا يتم الحفظ من هنا — طبّق الاقتراح ثم احفظ المنتج بالزر المعتاد.</p>
        </div>
      ) : null}
    </section>
  );
}
