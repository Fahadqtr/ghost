"use client";

// Malikas V2 Product Editor form (Phase UI.4). Client Component: local state
// for the scalar fields and the variant rows, pre-submit validation with
// focus-on-first-error, then ONE call to the thin V2 server action, which runs
// the shared save core (updateProduct's exact write path).
//
// Identity rules enforced here and re-proven by lib/products/edit-form-state:
// - an existing variant keeps its DATABASE uuid verbatim in the payload;
// - a new row sends NO id (the database generates the uuid on insert);
// - a removed existing row is omitted from the payload (the atomic RPC decides
//   whether the delete is allowed) and can be restored before saving;
// - the React list key is the uuid when there is one, otherwise a local
//   "new-N" marker that never reaches the payload.
//
// This component talks to Supabase only through the server action — it never
// imports a Supabase client, and it renders only fixed Arabic messages.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { saveProductEdit } from "@/app/(v2)/v2/catalog/[id]/edit/actions";
import {
  buildVariantInputs,
  hasUnsavedChanges,
  toVariantRows,
  withPersistedIdentity,
  type VariantFields,
  type VariantRowState,
} from "@/lib/products/edit-form-state";
import {
  activeVariantCount,
  addVariantRow,
  removeVariantRow,
  restoreVariantRow,
  updateVariantField,
} from "@/lib/products/variant-model";
import {
  addRows as bulkAddRows,
  fillMissingPrice as bulkFillMissingPrice,
  setSelectedStock as bulkSetSelectedStock,
  markSelectedRemoved as bulkMarkSelectedRemoved,
  restoreSelected as bulkRestoreSelected,
  removeEmptyRows as bulkRemoveEmptyRows,
} from "@/lib/products/variant-bulk";
import { mergeVariantSuggestions, type VariantSuggestion } from "@/lib/products/variant-ai";
import { useVariantIdentity } from "@/components/v2/catalog/useVariantIdentity";
import VariantBulkTools from "@/components/v2/catalog/VariantBulkTools";
import VariantAISuggestions from "@/components/v2/catalog/VariantAISuggestions";
import VariantCompleteness from "@/components/v2/catalog/VariantCompleteness";
import { validateProductEditInput } from "@/lib/products/edit-validation";
import ProductCompleteness from "@/components/v2/catalog/ProductCompleteness";
import { computeProductCompleteness } from "@/lib/products/product-completeness";
import ProductMediaEditor from "@/components/v2/catalog/ProductMediaEditor";
import AiFillMissing from "@/components/v2/catalog/AiFillMissing";
import type { ProductMediaState } from "@/lib/products/product-media";
import VariantIdentityToolbar from "@/components/v2/catalog/VariantIdentityToolbar";
import type { ProductInput } from "@/lib/products/product-save";
import type { EditBrand, ProductEditInitial } from "@/lib/products/product-edit-read";
import type { CatalogControls } from "@/lib/catalog-v2/master-catalog-view";

/** Scalar (non-variant) keys of the form, all string-valued. */
type ScalarKey = Exclude<keyof ProductEditInitial, "variants">;

const VARIANT_FIELD_DEFS: { key: keyof VariantFields; label: string; dir?: "ltr" }[] = [
  { key: "variant_name", label: "اسم الخيار (عربي)" },
  { key: "variant_name_en", label: "اسم الخيار (إنجليزي)", dir: "ltr" },
  { key: "sku", label: "SKU", dir: "ltr" },
  { key: "barcode", label: "الباركود", dir: "ltr" },
  { key: "color", label: "اللون" },
  { key: "size", label: "الحجم" },
  { key: "price", label: "السعر (ر.ق)", dir: "ltr" },
  { key: "stock_quantity", label: "الكمية", dir: "ltr" },
];

function scalarsOf(initial: ProductEditInitial): Record<ScalarKey, string> {
  const { variants: _variants, ...rest } = initial;
  return rest;
}

export default function ProductEditForm({
  productId,
  initial,
  initialMedia,
  brands,
  categories,
  stockStatuses,
  controls,
  cancelHref,
}: {
  productId: string;
  initial: ProductEditInitial;
  initialMedia: ProductMediaState;
  brands: EditBrand[];
  categories: string[];
  stockStatuses: string[];
  controls: CatalogControls;
  cancelHref: string;
}) {
  const initialScalars = useMemo(() => scalarsOf(initial), [initial]);
  const initialRows = useMemo(() => toVariantRows(initial.variants), [initial]);

  const [scalars, setScalars] = useState<Record<ScalarKey, string>>(initialScalars);
  const [rows, setRows] = useState<VariantRowState[]>(initialRows);
  // Bulk-tools row selection (UX.4E-5): stable row keys (DB id or local new-key),
  // never array index.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [media, setMedia] = useState<ProductMediaState>(initialMedia);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const newRowCounter = useRef(0);

  const dirty = useMemo(
    () => hasUnsavedChanges(initialScalars, scalars, initialRows, rows),
    [initialScalars, scalars, initialRows, rows],
  );

  // Warn on tab close / hard navigation while there are unsaved changes.
  // (Browser-level only: App Router client-side navigations don't fire it.)
  useEffect(() => {
    if (!dirty || pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);

  function setScalar(key: ScalarKey, value: string) {
    setScalars((s) => ({ ...s, [key]: value }));
  }

  // Media writes are persisted server-side by the media actions (they already
  // synced products.image_url/image_filename). Here we mirror the new primary
  // into the form scalars so (a) the completeness widget updates immediately and
  // (b) a later Save re-writes the SAME image_url/filename instead of reverting
  // it. The media itself is never part of the variant/scalar validation.
  function applyMedia(next: ProductMediaState) {
    setMedia(next);
    setScalars((s) => ({
      ...s,
      image_url: next.primary?.url ?? "",
      image_filename: next.primary?.filename ?? "",
    }));
  }

  // Apply an AI "fill missing" patch (UX.4D-2). The proposal layer + form adapter
  // already decided WHICH scalar keys change (fill-missing default / explicit
  // overwrite); here we only merge those keys into form state. Identity/commerce
  // fields can never be in the patch (the proposal contract excludes them), and
  // only existing scalar keys are written. Completeness updates from scalars; the
  // user still saves with the normal button.
  function applyAiPatch(patch: Record<string, string>) {
    setScalars((s) => {
      const next: Record<ScalarKey, string> = { ...s };
      for (const key of Object.keys(patch)) {
        if (key in next) next[key as ScalarKey] = patch[key];
      }
      return next;
    });
  }

  // Row mutations go through the shared pure variant model (UX.4E-2): identical
  // behavior to the previous inline logic — a new row is dropped outright, an
  // existing row is kept visible and marked removed (undo-able before save).
  function setRowField(key: string, field: keyof VariantFields, value: string) {
    setRows((rs) => updateVariantField(rs, key, field, value));
  }

  function addRow() {
    newRowCounter.current += 1;
    const key = `new-${newRowCounter.current}`;
    setRows((rs) => addVariantRow(rs, key));
  }

  function removeRow(key: string) {
    setRows((rs) => removeVariantRow(rs, key));
  }

  function restoreRow(key: string) {
    setRows((rs) => restoreVariantRow(rs, key));
  }

  // ── bulk tools (UX.4E-5) ─────────────────────────────────────────────────
  // Each action applies a shared PURE transform from lib/products/variant-bulk
  // (proposal only — nothing persists until Save). Edit never renumbers SKUs, so
  // added rows are appended as-is and persisted identities are never touched.
  function toggleSelected(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function bulkAdd(count: number) {
    const base = newRowCounter.current;
    newRowCounter.current += count;
    setRows((rs) => bulkAddRows(rs, count, (i) => `new-${base + i + 1}`));
  }

  function bulkFillPrice() {
    setRows((rs) => bulkFillMissingPrice(rs, scalars.price));
  }

  function bulkSetStock(quantity: string) {
    setRows((rs) => bulkSetSelectedStock(rs, selectedKeys, quantity));
  }

  function bulkDelete() {
    setRows((rs) => bulkMarkSelectedRemoved(rs, selectedKeys));
    setSelectedKeys(new Set());
  }

  function bulkRestore() {
    setRows((rs) => bulkRestoreSelected(rs, selectedKeys));
  }

  function bulkRemoveEmpty() {
    setRows((rs) => bulkRemoveEmptyRows(rs));
    setSelectedKeys((prev) => new Set([...prev].filter((k) => rows.some((r) => r.key === k))));
  }

  // AI variant suggestions (UX.4E-6): append the user-selected suggestions as
  // NEW local rows (id null, blank SKU/barcode). Proposal only — nothing
  // persists until Save; identity is filled by the existing Variant Identity
  // tools, validation stays with the shared validator.
  function addAiSuggestions(suggestions: VariantSuggestion[]) {
    const base = newRowCounter.current;
    newRowCounter.current += suggestions.length;
    setRows((rs) =>
      mergeVariantSuggestions(rs, suggestions, {
        mode: "append-new",
        keyFactory: (i) => `ai-${base + i + 1}`,
      }),
    );
  }

  function focusField(fieldId: string) {
    const el = document.getElementById(fieldId);
    if (el instanceof HTMLElement) el.focus();
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    // Carry the persisted (loaded) identity so the validator can grandfather an
    // UNCHANGED legacy SKU/barcode (UX.4E-3). These fields are validation-only;
    // the save core/RPC ignore them, so nothing extra is written.
    const payload: ProductInput = withPersistedIdentity(
      { ...scalars, variants: buildVariantInputs(rows) },
      { sku: initialScalars.sku, barcode: initialScalars.barcode, rows: initialRows },
    );
    const validation = validateProductEditInput(payload);
    if (!validation.ok) {
      setError(validation.message);
      focusField(validation.field);
      return;
    }

    setError(null);
    startTransition(async () => {
      // Controls travel as plain strings; the action re-validates them through
      // parseCatalogControls before building the redirect target.
      const rawControls = {
        query: controls.query,
        filter: controls.filter,
        sort: controls.sort,
        page: String(controls.page),
      };
      // On success the action redirects to the detail page (with the catalog
      // controls preserved), so this only resumes on failure.
      const result = await saveProductEdit(productId, payload, rawControls);
      if (result && typeof result.error === "string") setError(result.error);
    });
  }

  const activeCount = activeVariantCount(rows);

  // ── identity generators (UX.4B → shared hook in UX.4E-2) ────────────────────
  // Orchestration + the seven generate/copy actions now live in the shared
  // useVariantIdentity hook. The edit form writes a generated MAIN SKU as a plain
  // scalar (it deliberately does NOT renumber variant SKUs — that is the create
  // wizard's behavior, injected there via onMainSkuChange).
  const variantIdentity = useVariantIdentity({
    mainSku: scalars.sku,
    mainBarcode: scalars.barcode,
    productPrice: scalars.price,
    rows,
    setMainSku: (value) => setScalar("sku", value),
    setMainBarcode: (value) => setScalar("barcode", value),
    setRows,
    onError: setError,
  });

  // Validation reports field ids by PAYLOAD index (removed rows are omitted
  // from the payload), so the DOM ids must use the same numbering.
  const payloadIndexByKey = new Map<string, number>();
  {
    let pi = 0;
    for (const r of rows) if (!r.removed) payloadIndexByKey.set(r.key, pi++);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {/* Header: title + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink">تعديل المنتج</h1>
        <div className="flex items-center gap-2">
          <button type="submit" disabled={pending} className="btn-primary disabled:opacity-60">
            {pending ? "جارٍ الحفظ…" : "حفظ التغييرات"}
          </button>
          <Link href={cancelHref} className="btn-ghost" aria-disabled={pending}>
            إلغاء
          </Link>
        </div>
      </div>

      {error ? (
        <div role="alert" className="card border-rose-200 bg-rose-50 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {/* Product media (UX.4C-2) — upload / replace / delete the primary photo.
          Writes go through the server actions and return a fresh media state;
          applyMedia mirrors the new primary into the form scalars so completeness
          updates at once and Save persists the same image_url/filename. */}
      <ProductMediaEditor productId={productId} state={media} onChange={applyMedia} />

      {/* Product completeness (UX.4A) — read-only; derived from the readiness
          engine via the shared wrapper. Never mutates the form. */}
      <ProductCompleteness
        result={computeProductCompleteness({
          nameAr: scalars.name_ar,
          nameEn: scalars.name_en,
          sku: scalars.sku,
          barcode: scalars.barcode,
          price: scalars.price,
          category: scalars.main_category,
          brandId: scalars.brand_id,
          descriptionAr: scalars.description_ar,
          descriptionEn: scalars.description_en,
          hasImage: (scalars.image_url ?? "").trim() !== "",
          variantCount: activeCount,
        })}
      />

      {/* AI fill missing (UX.4D-2) — propose-only. Uses the primary image from the
          media state + current content fields; applies via the shared proposal
          layer (fill-missing default). Never saves; completeness updates from the
          patched scalars. */}
      <AiFillMissing
        currentScalars={scalars as Record<string, string>}
        imageUrl={media.primary?.url ?? null}
        brands={brands}
        onApply={applyAiPatch}
      />

      {/* Basic info */}
      <section className="card space-y-3">
        <h2 className="text-sm font-semibold text-ink">البيانات الأساسية</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="label">الاسم (عربي)</span>
            <input
              id="edit-name_ar"
              className="input"
              value={scalars.name_ar}
              onChange={(e) => setScalar("name_ar", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">الاسم (إنجليزي)</span>
            <input
              id="edit-name_en"
              dir="ltr"
              className="input"
              value={scalars.name_en}
              onChange={(e) => setScalar("name_en", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">SKU</span>
            <div className="flex items-center gap-2">
              <input
                id="edit-sku"
                dir="ltr"
                className="input flex-1"
                value={scalars.sku}
                onChange={(e) => setScalar("sku", e.target.value)}
              />
              <button type="button" className="btn-ghost shrink-0 px-2 py-1 text-xs disabled:opacity-50" disabled={variantIdentity.identityBusy} onClick={() => void variantIdentity.generateMainSku()}>
                توليد
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">الباركود</span>
            <div className="flex items-center gap-2">
              <input
                id="edit-barcode"
                dir="ltr"
                className="input flex-1"
                value={scalars.barcode}
                onChange={(e) => setScalar("barcode", e.target.value)}
              />
              <button type="button" className="btn-ghost shrink-0 px-2 py-1 text-xs disabled:opacity-50" disabled={variantIdentity.identityBusy} onClick={() => void variantIdentity.generateMainBarcode()}>
                توليد
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">العلامة التجارية</span>
            <select
              id="edit-brand_id"
              className="select-input"
              value={scalars.brand_id}
              onChange={(e) => setScalar("brand_id", e.target.value)}
            >
              <option value="">— بدون —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">نوع المنتج</span>
            <input
              id="edit-product_type"
              className="input"
              value={scalars.product_type}
              onChange={(e) => setScalar("product_type", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">اللون</span>
            <input
              id="edit-color"
              className="input"
              value={scalars.color}
              onChange={(e) => setScalar("color", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">الحجم</span>
            <input
              id="edit-size"
              className="input"
              value={scalars.size}
              onChange={(e) => setScalar("size", e.target.value)}
            />
          </label>
        </div>
      </section>

      {/* Category */}
      <section className="card space-y-3">
        <h2 className="text-sm font-semibold text-ink">التصنيف</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="label">التصنيف الرئيسي</span>
            <select
              id="edit-main_category"
              className="select-input"
              value={scalars.main_category}
              onChange={(e) => setScalar("main_category", e.target.value)}
            >
              <option value="">— بدون —</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">التصنيف الفرعي</span>
            <input
              id="edit-sub_category"
              className="input"
              value={scalars.sub_category}
              onChange={(e) => setScalar("sub_category", e.target.value)}
            />
          </label>
        </div>
      </section>

      {/* Pricing & stock */}
      <section className="card space-y-3">
        <h2 className="text-sm font-semibold text-ink">الأسعار والمخزون</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className="label">السعر (ر.ق)</span>
            <input
              id="edit-price"
              dir="ltr"
              inputMode="decimal"
              className="input"
              value={scalars.price}
              onChange={(e) => setScalar("price", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">سعر الخصم (ر.ق)</span>
            <input
              id="edit-discount_price"
              dir="ltr"
              inputMode="decimal"
              className="input"
              value={scalars.discount_price}
              onChange={(e) => setScalar("discount_price", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">التكلفة (ر.ق)</span>
            <input
              id="edit-cost"
              dir="ltr"
              inputMode="decimal"
              className="input"
              value={scalars.cost}
              onChange={(e) => setScalar("cost", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">الكمية</span>
            <input
              id="edit-stock_quantity"
              dir="ltr"
              inputMode="numeric"
              className="input"
              value={scalars.stock_quantity}
              onChange={(e) => setScalar("stock_quantity", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">حالة المخزون</span>
            <select
              id="edit-stock_status"
              className="select-input"
              value={scalars.stock_status}
              onChange={(e) => setScalar("stock_status", e.target.value)}
            >
              <option value="">— بدون —</option>
              {stockStatuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* Descriptions */}
      <section className="card space-y-3">
        <h2 className="text-sm font-semibold text-ink">الأوصاف والكلمات المفتاحية</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="label">الوصف (عربي)</span>
            <textarea
              id="edit-description_ar"
              rows={4}
              className="input"
              value={scalars.description_ar}
              onChange={(e) => setScalar("description_ar", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">الوصف (إنجليزي)</span>
            <textarea
              id="edit-description_en"
              dir="ltr"
              rows={4}
              className="input"
              value={scalars.description_en}
              onChange={(e) => setScalar("description_en", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">كلمات مفتاحية (عربي)</span>
            <input
              id="edit-keywords_ar"
              className="input"
              value={scalars.keywords_ar}
              onChange={(e) => setScalar("keywords_ar", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">كلمات مفتاحية (إنجليزي)</span>
            <input
              id="edit-keywords_en"
              dir="ltr"
              className="input"
              value={scalars.keywords_en}
              onChange={(e) => setScalar("keywords_en", e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="label">ملاحظات</span>
            <textarea
              id="edit-notes"
              rows={2}
              className="input"
              value={scalars.notes}
              onChange={(e) => setScalar("notes", e.target.value)}
            />
          </label>
        </div>
      </section>

      {/* Variants */}
      <section id="edit-variants" tabIndex={-1} className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">الخيارات ({activeCount})</h2>
          <button type="button" onClick={addRow} className="btn-ghost">
            + إضافة خيار
          </button>
        </div>

        {/* Variant identity tools (UX.4B) — proposal only, form state only. */}
        {activeCount > 0 ? (
          <VariantIdentityToolbar
            busy={variantIdentity.identityBusy}
            onGenerateMissingSku={variantIdentity.generateMissingVariantSku}
            onGenerateMissingBarcode={() => void variantIdentity.generateMissingVariantBarcode()}
            onGenerateAll={() => void variantIdentity.generateAllMissing()}
            onCopyPrefix={variantIdentity.copyVariantSkuPrefix}
            onCopyPrice={variantIdentity.copyVariantPrice}
          />
        ) : null}
        {/* AI variant suggestions (UX.4E-6) — proposal only; reuses the existing
            propose-only vision action + the pure variant-ai merge layer. */}
        <VariantAISuggestions
          primaryImageUrl={media.primary?.url ?? null}
          onAddSuggestions={addAiSuggestions}
        />
        {/* Bulk tools (UX.4E-5) — proposal only; shared pure transforms. */}
        {rows.length > 0 ? (
          <VariantBulkTools
            selectedCount={selectedKeys.size}
            canRestore={rows.some((r) => r.removed)}
            onAddRows={bulkAdd}
            onFillMissingPrice={bulkFillPrice}
            onSetSelectedStock={bulkSetStock}
            onGenerateMissingSku={variantIdentity.generateMissingVariantSku}
            onGenerateMissingBarcode={() => void variantIdentity.generateMissingVariantBarcode()}
            onGenerateMissingIdentity={() => void variantIdentity.generateAllMissing()}
            onDeleteSelected={bulkDelete}
            onRestoreSelected={bulkRestore}
            onRemoveEmptyRows={bulkRemoveEmpty}
            busy={variantIdentity.identityBusy}
          />
        ) : null}
        {/* Variant completeness (UX.4E-7) — read-only readiness view. */}
        {rows.length > 0 ? <VariantCompleteness rows={rows} mainSku={scalars.sku} /> : null}

        {rows.length === 0 ? (
          <p className="text-sm text-muted">لا توجد خيارات لهذا المنتج — يمكنك إضافة خيار جديد.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((row, index) => (
              <div
                key={row.key}
                className={
                  "rounded-xl border p-3 " +
                  (row.removed ? "border-amber-200 bg-amber-50" : "border-[#efe3d6] bg-white")
                }
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs font-medium text-muted">
                    <input
                      type="checkbox"
                      aria-label="تحديد الصف"
                      checked={selectedKeys.has(row.key)}
                      onChange={() => toggleSelected(row.key)}
                    />
                    <span>{row.id === null ? "خيار جديد" : `خيار ${index + 1}`}</span>
                  </label>
                  {row.removed ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-amber-700">سيُحذف عند الحفظ</span>
                      <button type="button" onClick={() => restoreRow(row.key)} className="btn-ghost text-xs">
                        تراجع
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => removeRow(row.key)}
                      className="btn-ghost text-xs text-rose-600"
                    >
                      حذف الخيار
                    </button>
                  )}
                </div>
                {row.removed ? null : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {VARIANT_FIELD_DEFS.map((f) => (
                      <label key={f.key} className="flex flex-col gap-1">
                        <span className="label">{f.label}</span>
                        <input
                          id={`edit-variant-${payloadIndexByKey.get(row.key) ?? index}-${f.key}`}
                          dir={f.dir}
                          inputMode={f.key === "price" || f.key === "stock_quantity" ? "decimal" : undefined}
                          className="input"
                          value={row.fields[f.key]}
                          onChange={(e) => setRowField(row.key, f.key, e.target.value)}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Footer actions (mirror of the header, for long forms on mobile) */}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className="btn-primary disabled:opacity-60">
          {pending ? "جارٍ الحفظ…" : "حفظ التغييرات"}
        </button>
        <Link href={cancelHref} className="btn-ghost" aria-disabled={pending}>
          إلغاء
        </Link>
      </div>
    </form>
  );
}
