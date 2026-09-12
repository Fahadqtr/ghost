"use client";

// STAFF COPY — variant row actions on /v2/catalog/[id].
//
// READ-ONLY. Clipboard writes and download links only; there is no mutation in
// this file. It renders INTO the existing options table through ProductDetail's
// render-prop slot, so the table keeps its own layout and this component owns
// nothing but the buttons.
//
// The copied block comes from the shared pure builder, so a variant copied from
// the row and the same variant copied from the product drawer are byte-identical.

import { useCallback, useState } from "react";
import {
  buildAllVariantsCopyText,
  buildVariantCopyBlock,
  variantDisplayName,
  type CopyPanelVariant,
} from "@/lib/catalog/copy-panel/copy-panel";

const COPIED = "تم النسخ ✓";
const FAILED = "تعذّر النسخ";

async function toClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function useFlash() {
  const [flash, setFlash] = useState<{ key: string; text: string } | null>(null);
  const show = useCallback((key: string, ok: boolean) => {
    const text = ok ? COPIED : FAILED;
    setFlash({ key, text });
    setTimeout(() => setFlash((c) => (c && c.key === key ? null : c)), 1600);
  }, []);
  return { flash, show };
}

/** A compact icon-sized copy button. Disabled when there is nothing to copy. */
function Chip({
  value, testId, title, onDone, children,
}: { value: string; testId: string; title: string; onDone: (k: string, ok: boolean) => void; children: React.ReactNode }) {
  const empty = value.trim() === "";
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      disabled={empty}
      onClick={async () => onDone(testId, await toClipboard(value))}
      className="btn-ghost shrink-0 px-2 py-0.5 text-[11px] leading-5 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** The per-row actions cell. Kept to one wrapping line so rows stay short. */
export function VariantRowCopyActions({ variant, index }: { variant: CopyPanelVariant; index: number }) {
  const { flash, show } = useFlash();
  const id = variant.id ?? variant.sku ?? `v${index}`;
  const block = buildVariantCopyBlock(variant);

  return (
    <div className="flex flex-wrap items-center gap-1" dir="rtl">
      <Chip value={variantDisplayName(variant)} testId={`vcopy-name-${id}`} title="نسخ اسم الخيار" onDone={show}>الاسم</Chip>
      <Chip value={variant.sku ?? ""} testId={`vcopy-sku-${id}`} title="نسخ SKU الخيار" onDone={show}>SKU</Chip>
      <Chip value={variant.barcode ?? ""} testId={`vcopy-barcode-${id}`} title="نسخ باركود الخيار" onDone={show}>الباركود</Chip>
      <Chip
        value={typeof variant.price === "number" && Number.isFinite(variant.price) ? String(variant.price) : ""}
        testId={`vcopy-price-${id}`} title="نسخ سعر الخيار" onDone={show}
      >السعر</Chip>
      <Chip value={block} testId={`vcopy-all-${id}`} title="نسخ بيانات الخيار" onDone={show}>نسخ بيانات الخيار</Chip>

      {variant.imageUrl ? (
        <>
          <Chip value={variant.imageUrl} testId={`vcopy-image-url-${id}`} title="نسخ رابط صورة الخيار" onDone={show}>رابط الصورة</Chip>
          <a
            data-testid={`vdownload-image-${id}`}
            href={`/api/products/image?url=${encodeURIComponent(variant.imageUrl)}&dl=1&name=${encodeURIComponent(variant.sku ?? `variant-${index + 1}`)}`}
            download
            title="تنزيل صورة الخيار"
            className="btn-ghost shrink-0 px-2 py-0.5 text-[11px] leading-5"
          >
            تنزيل الصورة
          </a>
        </>
      ) : null}

      {flash ? <span className="text-[11px] text-emerald-700">{flash.text}</span> : null}
    </div>
  );
}

/** The table-level "copy every variant" control. */
export function CopyAllVariantsButton({ variants }: { variants: readonly CopyPanelVariant[] }) {
  const { flash, show } = useFlash();
  const text = buildAllVariantsCopyText(variants);
  return (
    <div className="flex items-center gap-2" dir="rtl">
      <button
        type="button"
        data-testid="copy-all-variants"
        disabled={text === ""}
        onClick={async () => show("copy-all-variants", await toClipboard(text))}
        className="btn-ghost px-3 py-1 text-xs disabled:opacity-40"
      >
        نسخ جميع الخيارات
      </button>
      {flash ? <span className="text-[11px] text-emerald-700">{flash.text}</span> : null}
    </div>
  );
}
