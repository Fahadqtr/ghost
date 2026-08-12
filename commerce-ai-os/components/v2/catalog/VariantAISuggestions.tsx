"use client";

// Malikas V2 — AI variant suggestions (UX.4E-6). Mobile-first, RTL. Proposal
// ONLY: it analyzes the product's CURRENT primary image with the EXISTING
// propose-only vision action (analyzeAiProductImage — same prompt/parser/model,
// unchanged), turns the trusted VisionExtract variants into suggestions via the
// pure lib/products/variant-ai layer, and hands the SELECTED suggestions to the
// parent to append as new local rows. It never writes to the DB, never creates a
// SKU/barcode/price/stock, never changes a persisted row, and contains no
// prompt, parser, identity, or validation logic of its own. SKU/barcode are
// filled afterwards by the existing Variant Identity tools; validation stays
// with the shared validators at Save.

import { useState } from "react";
import { prepareImage } from "@/lib/imagePrep";
import { analyzeAiProductImage } from "@/app/(v2)/v2/catalog/new/actions";
import {
  toVariantSuggestions,
  suggestionsPreselected,
  type VariantSuggestion,
} from "@/lib/products/variant-ai";

const MSG = {
  trigger: "✨ اقتراح خيارات بالذكاء",
  analyzing: "جارٍ التحليل…",
  noImage: "أضف صورة المنتج أولًا لاقتراح الخيارات.",
  readFail: "تعذّر قراءة صورة المنتج — حاول مرة أخرى.",
  none: "لم يتم العثور على خيارات مقترحة في الصورة.",
  warnMedium: "دقة متوسطة — راجعي الاقتراحات قبل الإضافة.",
  warnLow: "دقة منخفضة — لم يتم التحديد تلقائيًا. راجعي بعناية قبل الإضافة.",
  add: "إضافة المحدد",
  cancel: "إلغاء",
} as const;

type Confidence = "high" | "medium" | "low";

export default function VariantAISuggestions({
  primaryImageUrl,
  onAddSuggestions,
  disabled = false,
}: {
  primaryImageUrl: string | null;
  onAddSuggestions: (suggestions: VariantSuggestion[]) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<VariantSuggestion[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confidence, setConfidence] = useState<Confidence>("high");

  const hasImage = typeof primaryImageUrl === "string" && primaryImageUrl.trim() !== "";

  async function analyze() {
    if (!hasImage || busy) return;
    setBusy(true);
    setError(null);
    setSuggestions(null);
    try {
      // Convert the product's current primary image to base64 in the browser and
      // reuse the EXISTING propose-only action — no server URL fetch (no SSRF),
      // no new prompt/model, no DB write.
      let prepared;
      try {
        const resp = await fetch(primaryImageUrl as string);
        if (!resp.ok) throw new Error("fetch failed");
        const blob = await resp.blob();
        prepared = await prepareImage(new File([blob], "product", { type: blob.type || "image/jpeg" }));
      } catch {
        setError(MSG.readFail);
        return;
      }
      const res = await analyzeAiProductImage(prepared.base64, prepared.mediaType);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const list = toVariantSuggestions(res.data);
      if (list.length === 0) {
        setError(MSG.none);
        return;
      }
      const conf = res.data.confidence;
      setConfidence(conf);
      setSuggestions(list);
      // High/medium preselect all; low starts empty (the user must opt in).
      setSelected(suggestionsPreselected(conf) ? new Set(list.map((_, i) => i)) : new Set());
    } finally {
      setBusy(false);
    }
  }

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function reset() {
    setSuggestions(null);
    setSelected(new Set());
    setError(null);
  }

  function add() {
    if (!suggestions) return;
    const chosen = suggestions.filter((_, i) => selected.has(i));
    if (chosen.length === 0) return;
    onAddSuggestions(chosen);
    reset();
  }

  const off = disabled || busy;

  return (
    <div dir="rtl" className="flex flex-col gap-2">
      {suggestions === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
            disabled={off || !hasImage}
            onClick={() => void analyze()}
          >
            {busy ? MSG.analyzing : MSG.trigger}
          </button>
          {!hasImage ? <span className="text-[11px] text-[#8a7968]">{MSG.noImage}</span> : null}
          {error ? <span className="text-[11px] text-rose-600">{error}</span> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border border-[#efe3d6] bg-[#fdf8f2] p-2">
          {confidence !== "high" ? (
            <p className="text-[11px] text-amber-700">{confidence === "low" ? MSG.warnLow : MSG.warnMedium}</p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {suggestions.map((s, i) => (
              <li key={i}>
                <label className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-2 py-1 text-xs">
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} disabled={off} />
                  {s.variant_name ? <span className="font-medium text-ink">{s.variant_name}</span> : null}
                  {s.variant_name_en ? <span dir="ltr" className="text-[#8a7968]">{s.variant_name_en}</span> : null}
                  {s.color ? <span className="text-[#8a7968]">اللون: {s.color}</span> : null}
                  {s.size ? <span className="text-[#8a7968]" dir="ltr">{s.size}</span> : null}
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
              disabled={off || selected.size === 0}
              onClick={add}
            >
              {MSG.add} ({selected.size})
            </button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={reset}>
              {MSG.cancel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
