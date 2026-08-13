"use client";

// Malikas V2 — shared variant row (UX.4E-4). Presentational ONLY: the single
// per-variant card used by BOTH the Create wizard and the Edit form, so the two
// parents no longer each carry their own copy of the row markup. It renders:
//   • a selection checkbox + a title (the auto SKU in Create, "خيار جديد/N" in Edit),
//   • a remove control, or — for a soft-removed persisted row — a "سيُحذف عند الحفظ"
//     note with an undo button (Edit only; Create passes no onRestore),
//   • a grid of field inputs described entirely by the `fields` prop, so the two
//     forms inject their own legitimate field ordering / labels / editability
//     (Create's SKU is read-only auto, Edit's SKU is editable) without any branch
//     living here.
//
// It holds NO state, does NO I/O, owns NO business rules, and never decides WHICH
// fields exist or how a value changes — every mutation is a callback the parent
// provides. A soft-removed row hides its field grid (the parent still keeps the
// row in state until Save, exactly as before).

import type { VariantFieldKey, VariantRowModel } from "@/lib/products/variant-model";

/** One input in the row's field grid. Purely presentational description. */
export interface VariantRowFieldDef {
  key: VariantFieldKey;
  label: string;
  dir?: "ltr";
  inputMode?: "decimal" | "numeric";
  /** A read-only field (Create's auto SKU) renders without an onChange. */
  readOnly?: boolean;
}

export default function VariantRow({
  row,
  title,
  titleDir,
  fields,
  fieldIdPrefix,
  fieldIndex,
  selected,
  onToggleSelect,
  onRemove,
  onRestore,
  onFieldChange,
  disabled = false,
}: {
  row: VariantRowModel;
  /** Header title (Create: the auto SKU; Edit: "خيار جديد" / "خيار N"). */
  title: string;
  titleDir?: "ltr";
  /** Ordered field descriptors (the parent's legitimate field-set difference). */
  fields: readonly VariantRowFieldDef[];
  /** DOM id prefix, e.g. "create-variant" / "edit-variant". */
  fieldIdPrefix: string;
  /** Number embedded in each field id (payload index — matches validation focus). */
  fieldIndex: number;
  selected: boolean;
  onToggleSelect: () => void;
  onRemove: () => void;
  /** Provided only where a soft-removed row can be restored (Edit). */
  onRestore?: () => void;
  onFieldChange: (field: VariantFieldKey, value: string) => void;
  disabled?: boolean;
}) {
  const removed = row.removed;
  return (
    <div
      className={
        "rounded-xl border p-3 " +
        (removed ? "border-amber-200 bg-amber-50" : "border-[#efe3d6] bg-white")
      }
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs font-medium text-muted">
          <input
            type="checkbox"
            aria-label="تحديد الصف"
            checked={selected}
            onChange={onToggleSelect}
            disabled={disabled}
          />
          <span dir={titleDir}>{title}</span>
        </label>
        {removed && onRestore ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-700">سيُحذف عند الحفظ</span>
            <button type="button" onClick={onRestore} className="btn-ghost text-xs">
              تراجع
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="btn-ghost text-xs text-rose-600"
          >
            حذف الخيار
          </button>
        )}
      </div>
      {removed ? null : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="label">{f.label}</span>
              <input
                id={`${fieldIdPrefix}-${fieldIndex}-${f.key}`}
                dir={f.dir}
                inputMode={f.inputMode}
                className="input"
                value={row.fields[f.key]}
                readOnly={f.readOnly}
                onChange={f.readOnly ? undefined : (e) => onFieldChange(f.key, e.target.value)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
