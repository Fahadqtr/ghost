"use client";

// Malikas V2 — Variant identity toolbar (UX.4B). Presentational ONLY: a small
// row of buttons above the variant table. It holds NO state and does NO data
// access — every action is a callback the parent form provides (which applies the
// shared pure helpers in lib/products/identity-fill to its own row state). RTL,
// mobile-first, small buttons.

export default function VariantIdentityToolbar({
  onGenerateMissingSku,
  onGenerateMissingBarcode,
  onGenerateAll,
  onCopyPrefix,
  onCopyPrice,
  disabled = false,
  busy = false,
}: {
  onGenerateMissingSku: () => void;
  onGenerateMissingBarcode: () => void;
  onGenerateAll: () => void;
  onCopyPrefix: () => void;
  onCopyPrice: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const cls = "btn-ghost px-2 py-1 text-xs disabled:opacity-50";
  return (
    <div dir="rtl" className="flex flex-wrap items-center gap-2">
      <button type="button" className={cls} disabled={disabled || busy} onClick={onGenerateMissingSku}>
        توليد SKU الناقص
      </button>
      <button type="button" className={cls} disabled={disabled || busy} onClick={onGenerateMissingBarcode}>
        توليد باركود ناقص
      </button>
      <button type="button" className={cls} disabled={disabled || busy} onClick={onGenerateAll}>
        {busy ? "جارٍ…" : "توليد الكل"}
      </button>
      <button type="button" className={cls} disabled={disabled || busy} onClick={onCopyPrefix}>
        نسخ بادئة SKU
      </button>
      <button type="button" className={cls} disabled={disabled || busy} onClick={onCopyPrice}>
        نسخ سعر المنتج
      </button>
    </div>
  );
}
