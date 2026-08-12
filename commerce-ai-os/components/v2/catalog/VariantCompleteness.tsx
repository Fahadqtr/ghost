"use client";

// Malikas V2 — Variant Completeness (UX.4E-7). Presentational ONLY: a compact,
// mobile-first RTL panel that explains how ready the variant rows are. It reads
// the shared PURE completeness helpers (lib/products/variant-completeness) and
// renders a summary + per-row status + missing/invalid chips. It holds no state,
// does no I/O, mutates nothing, and never blocks Save — variant-validate stays
// authoritative. It does not touch the variant cards themselves.

import {
  computeVariantCompleteness,
  summarizeVariantCompleteness,
  type VariantCheckKey,
  type VariantCompletenessStatus,
} from "@/lib/products/variant-completeness";
import { activeVariantRows, type VariantRowModel } from "@/lib/products/variant-model";

const LABEL: Record<VariantCheckKey, string> = {
  name: "الاسم",
  sku: "SKU",
  barcode: "الباركود",
  price: "السعر",
  stock: "الكمية",
  second_name: "الاسم الثاني",
  color: "اللون",
  size: "الحجم",
};

const STATUS_TEXT: Record<Exclude<VariantCompletenessStatus, "removed">, string> = {
  complete: "مكتمل",
  incomplete: "ناقص",
  invalid: "غير صالح",
};

const STATUS_DOT: Record<Exclude<VariantCompletenessStatus, "removed">, string> = {
  complete: "bg-emerald-500",
  incomplete: "bg-amber-500",
  invalid: "bg-rose-500",
};

export default function VariantCompleteness({
  rows,
  mainSku,
}: {
  rows: readonly VariantRowModel[];
  mainSku: string;
}) {
  const summary = summarizeVariantCompleteness(rows, mainSku);
  if (summary.activeCount === 0) return null;

  const active = activeVariantRows(rows);
  const barTone =
    summary.invalidCount > 0 ? "bg-rose-500" : summary.percent === 100 ? "bg-emerald-500" : "bg-amber-500";

  return (
    <div dir="rtl" className="flex flex-col gap-2 rounded-xl border border-[#efe3d6] bg-[#fdf8f2] p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-ink">اكتمال الخيارات</span>
        <span className="text-[#8a7968]">
          {summary.completeCount}/{summary.activeCount} مكتمل · {summary.percent}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#efe3d6]">
        <div className={`h-full rounded-full ${barTone}`} style={{ width: `${summary.percent}%` }} />
      </div>
      {summary.needsAttention ? (
        <p className="text-[11px] text-[#8a7968]">
          {summary.incompleteCount > 0 ? `${summary.incompleteCount} ناقص` : ""}
          {summary.incompleteCount > 0 && summary.invalidCount > 0 ? " · " : ""}
          {summary.invalidCount > 0 ? `${summary.invalidCount} غير صالح` : ""}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {active.map((row) => {
          const c = computeVariantCompleteness(row, mainSku);
          if (c.status === "removed") return null;
          const title =
            row.fields.variant_name.trim() ||
            row.fields.variant_name_en.trim() ||
            row.fields.sku.trim() ||
            "خيار";
          return (
            <li key={row.key} className="flex flex-wrap items-center gap-1.5 rounded-lg bg-white px-2 py-1">
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[c.status]}`} aria-hidden />
              <span className="font-medium text-ink">{title}</span>
              <span className="text-[#8a7968]">{STATUS_TEXT[c.status]}</span>
              {c.invalid.map((k) => (
                <span key={`i-${k}`} className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] text-rose-600">
                  {LABEL[k]} غير صالح
                </span>
              ))}
              {c.missing.map((k) => (
                <span key={`m-${k}`} className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                  {LABEL[k]} ناقص
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
