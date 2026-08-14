"use client";

// Malikas V2 — unified Variant Studio (UX.4E-4). The SINGLE composition root for
// variant editing UI, used by BOTH the Create wizard (AiProductCreator) and the
// Edit form (ProductEditForm). It composes the already-shared pieces — the
// identity toolbar, AI suggestions, bulk tools, completeness readout, and the
// shared VariantRow — into one section, so neither parent carries its own copy of
// that composition anymore.
//
// This is CONSOLIDATION ONLY. Every business rule still lives where it already
// did: the pure variant-model / variant-bulk / variant-ai / variant-completeness
// layers, the shared variant-validate authority, and the useVariantIdentity hook.
// The studio owns NO business logic — it does not renumber SKUs, decide identity,
// mutate rows, validate, or touch the DB. All of that is injected as callbacks by
// the parent, which keeps the ONE legitimate divergence (Create renumbers new
// variant SKUs on a main-SKU change; Edit never renumbers a persisted identity)
// entirely on the parent side.
//
// The only create/edit differences the studio itself resolves are PRESENTATIONAL
// (driven by `mode`): the section heading, the per-row field-set and labels, the
// row title, the DOM id prefixes, and the empty-state copy. AI variant
// suggestions are a capability gated by `allowAiSuggestions` — Edit-only for now;
// consolidation must not mount them in Create as a side effect.

import { useRef } from "react";
import VariantIdentityToolbar from "@/components/v2/catalog/VariantIdentityToolbar";
import VariantBulkTools from "@/components/v2/catalog/VariantBulkTools";
import VariantAISuggestions from "@/components/v2/catalog/VariantAISuggestions";
import VariantCompleteness from "@/components/v2/catalog/VariantCompleteness";
import VariantRow, { type VariantRowFieldDef } from "@/components/v2/catalog/VariantRow";
import type { VariantIdentityController } from "@/components/v2/catalog/useVariantIdentity";
import { activeVariantCount, type VariantFieldKey, type VariantRowModel } from "@/lib/products/variant-model";
import type { VariantSuggestion } from "@/lib/products/variant-ai";
import { nextActiveBarcodeKey } from "@/lib/products/variant-scanner";

// Per-mode presentational field sets. These are the two parents' pre-existing
// field lists, moved here verbatim so neither parent still declares one:
// - Create shows a read-only auto SKU as the LAST field (SKU is derived from the
//   main SKU, never hand-edited), barcode is editable, no numeric inputMode.
// - Edit shows SKU + barcode as editable inline, price/stock hint the decimal pad.
const CREATE_ROW_FIELDS: readonly VariantRowFieldDef[] = [
  { key: "variant_name", label: "اسم الخيار (عربي)" },
  { key: "variant_name_en", label: "اسم الخيار (إنجليزي)", dir: "ltr" },
  { key: "color", label: "اللون" },
  { key: "size", label: "الحجم" },
  { key: "price", label: "السعر (ر.ق)", dir: "ltr" },
  { key: "stock_quantity", label: "الكمية", dir: "ltr" },
  { key: "barcode", label: "الباركود (EAN-13)", dir: "ltr" },
  { key: "sku", label: "SKU الخيار (تلقائي)", dir: "ltr", readOnly: true },
];

const EDIT_ROW_FIELDS: readonly VariantRowFieldDef[] = [
  { key: "variant_name", label: "اسم الخيار (عربي)" },
  { key: "variant_name_en", label: "اسم الخيار (إنجليزي)", dir: "ltr" },
  { key: "sku", label: "SKU", dir: "ltr" },
  { key: "barcode", label: "الباركود", dir: "ltr" },
  { key: "color", label: "اللون" },
  { key: "size", label: "الحجم" },
  { key: "price", label: "السعر (ر.ق)", dir: "ltr", inputMode: "decimal" },
  { key: "stock_quantity", label: "الكمية", dir: "ltr", inputMode: "decimal" },
];

export interface VariantStudioBulkHandlers {
  onAddRows: (count: number) => void;
  onFillMissingPrice: () => void;
  onSetSelectedStock: (quantity: string) => void;
  onDeleteSelected: () => void;
  onRestoreSelected: () => void;
  onRemoveEmptyRows: () => void;
  /** Whether any row can currently be restored (Edit soft-delete). */
  canRestore: boolean;
}

export interface VariantStudioProps {
  /** Selects the presentational layer only — never a business branch. */
  mode: "create" | "edit";
  rows: readonly VariantRowModel[];
  /** Current main product SKU (for completeness + the toolbar). */
  mainSku: string;

  // selection (stable row keys, never array index) —
  selectedKeys: ReadonlySet<string>;
  onToggleSelect: (key: string) => void;

  // per-row mutation (parent-owned; renumber vs not lives on the parent side) —
  onAddRow: () => void;
  onRemoveRow: (key: string) => void;
  /** Provided by Edit only (persisted soft-delete undo). */
  onRestoreRow?: (key: string) => void;
  onFieldChange: (key: string, field: VariantFieldKey, value: string) => void;

  // identity generators (parent's useVariantIdentity controller) —
  identity: VariantIdentityController;

  // bulk tools —
  bulk: VariantStudioBulkHandlers;

  // AI variant suggestions — capability, Edit-only for now —
  allowAiSuggestions?: boolean;
  primaryImageUrl?: string | null;
  onAddAiSuggestions?: (suggestions: VariantSuggestion[]) => void;

  /** Create passes its `busy` flag; Edit leaves it off. Gates every control. */
  disabled?: boolean;
}

export default function VariantStudio({
  mode,
  rows,
  mainSku,
  selectedKeys,
  onToggleSelect,
  onAddRow,
  onRemoveRow,
  onRestoreRow,
  onFieldChange,
  identity,
  bulk,
  allowAiSuggestions = false,
  primaryImageUrl = null,
  onAddAiSuggestions,
  disabled = false,
}: VariantStudioProps) {
  const isCreate = mode === "create";
  const rowFields = isCreate ? CREATE_ROW_FIELDS : EDIT_ROW_FIELDS;
  const fieldIdPrefix = isCreate ? "create-variant" : "edit-variant";
  const sectionId = isCreate ? "create-variants" : "edit-variants";
  const heading = isCreate ? "٣ · الخيارات" : "الخيارات";
  const emptyMessage = isCreate
    ? "منتج بدون خيارات — يمكنك إضافة خيارات (ألوان/درجات/أحجام) قبل الحفظ."
    : "لا توجد خيارات لهذا المنتج — يمكنك إضافة خيار جديد.";

  const activeCount = activeVariantCount(rows);

  // Scanner parity (UX.4E-9C) — ported from the retired legacy editor. A handheld
  // barcode scanner emits Enter after each code; instead of that Enter submitting
  // the form we advance focus to the NEXT active variant barcode field so codes
  // scan straight down the list. Refs are keyed by the STABLE row key (never the
  // array index), and only the barcode input registers one. The ordering decision
  // lives in the pure `nextActiveBarcodeKey` helper (skips soft-removed rows,
  // never creates a row, returns null at the last field).
  const barcodeRefs = useRef(new Map<string, HTMLInputElement>());
  const registerBarcodeRef = (key: string) => (field: VariantFieldKey, el: HTMLInputElement | null) => {
    if (field !== "barcode") return;
    if (el) barcodeRefs.current.set(key, el);
    else barcodeRefs.current.delete(key);
  };
  const handleBarcodeKeyDown =
    (key: string) => (field: VariantFieldKey, e: React.KeyboardEvent<HTMLInputElement>) => {
      // Scanner flow applies ONLY to the barcode field on Enter. Every other field,
      // and every other key (Tab included), keeps its native behavior untouched.
      if (field !== "barcode" || e.key !== "Enter") return;
      e.preventDefault(); // don't let the scanner's Enter submit the form
      const nextKey = nextActiveBarcodeKey(rows, key);
      if (nextKey === null) return; // last active field — keep focus safe, no wrap, no new row
      const el = barcodeRefs.current.get(nextKey);
      if (!el) return; // next field unmounted/missing — never throw
      el.focus();
      el.select();
    };

  // Field ids number by PAYLOAD index (position among non-removed rows) so the DOM
  // ids match what the shared validator reports for focus-on-error. For Create,
  // where no row is ever soft-removed, this is just the array index — identical to
  // the wizard's previous numbering.
  const payloadIndexByKey = new Map<string, number>();
  {
    let pi = 0;
    for (const r of rows) if (!r.removed) payloadIndexByKey.set(r.key, pi++);
  }

  return (
    <section id={sectionId} tabIndex={-1} className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">
          {heading} ({activeCount})
        </h2>
        <button type="button" onClick={onAddRow} disabled={disabled} className="btn-ghost">
          + إضافة خيار
        </button>
      </div>

      {/* Variant identity tools (UX.4B) — proposal only, form state only. */}
      {activeCount > 0 ? (
        <VariantIdentityToolbar
          disabled={disabled}
          busy={identity.identityBusy}
          onGenerateMissingSku={identity.generateMissingVariantSku}
          onGenerateMissingBarcode={() => void identity.generateMissingVariantBarcode()}
          onGenerateAll={() => void identity.generateAllMissing()}
          onCopyPrefix={identity.copyVariantSkuPrefix}
          onCopyPrice={identity.copyVariantPrice}
        />
      ) : null}

      {/* AI variant suggestions (UX.4E-6) — Edit-only capability; proposal only.
          Consolidation must NOT mount this in Create. */}
      {allowAiSuggestions && onAddAiSuggestions ? (
        <VariantAISuggestions
          primaryImageUrl={primaryImageUrl}
          onAddSuggestions={onAddAiSuggestions}
          disabled={disabled}
        />
      ) : null}

      {/* Bulk tools (UX.4E-5) — proposal only; shared pure transforms. */}
      {rows.length > 0 ? (
        <VariantBulkTools
          selectedCount={selectedKeys.size}
          canRestore={bulk.canRestore}
          onAddRows={bulk.onAddRows}
          onFillMissingPrice={bulk.onFillMissingPrice}
          onSetSelectedStock={bulk.onSetSelectedStock}
          onGenerateMissingSku={identity.generateMissingVariantSku}
          onGenerateMissingBarcode={() => void identity.generateMissingVariantBarcode()}
          onGenerateMissingIdentity={() => void identity.generateAllMissing()}
          onDeleteSelected={bulk.onDeleteSelected}
          onRestoreSelected={bulk.onRestoreSelected}
          onRemoveEmptyRows={bulk.onRemoveEmptyRows}
          disabled={disabled}
          busy={identity.identityBusy}
        />
      ) : null}

      {/* Variant completeness (UX.4E-7) — read-only readiness view. */}
      {rows.length > 0 ? <VariantCompleteness rows={rows} mainSku={mainSku} /> : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted">{emptyMessage}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row, index) => {
            const title = isCreate
              ? row.fields.sku
              : row.id === null
                ? "خيار جديد"
                : `خيار ${index + 1}`;
            return (
              <VariantRow
                key={row.key}
                row={row}
                title={title}
                titleDir={isCreate ? "ltr" : undefined}
                fields={rowFields}
                fieldIdPrefix={fieldIdPrefix}
                fieldIndex={payloadIndexByKey.get(row.key) ?? index}
                selected={selectedKeys.has(row.key)}
                onToggleSelect={() => onToggleSelect(row.key)}
                onRemove={() => onRemoveRow(row.key)}
                onRestore={onRestoreRow ? () => onRestoreRow(row.key) : undefined}
                onFieldChange={(field, value) => onFieldChange(row.key, field, value)}
                registerFieldRef={registerBarcodeRef(row.key)}
                onFieldKeyDown={handleBarcodeKeyDown(row.key)}
                disabled={disabled}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
