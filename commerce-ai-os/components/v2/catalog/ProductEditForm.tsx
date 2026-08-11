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
  EMPTY_VARIANT_FIELDS,
  hasUnsavedChanges,
  toVariantRows,
  type VariantFields,
  type VariantRowState,
} from "@/lib/products/edit-form-state";
import { validateProductEditInput } from "@/lib/products/edit-validation";
import ProductCompleteness from "@/components/v2/catalog/ProductCompleteness";
import { computeProductCompleteness } from "@/lib/products/product-completeness";
import VariantIdentityToolbar from "@/components/v2/catalog/VariantIdentityToolbar";
import { loadCatalogIdentity, type CatalogIdentity } from "@/app/(v2)/v2/catalog/identity-actions";
import {
  copyProductPriceToEmpty,
  fillMissingVariantBarcodes,
  fillMissingVariantSkus,
  generateAllMissingIdentity,
  nextMainBarcode,
  nextMainSku,
} from "@/lib/products/identity-fill";
import { renumberVariantSkus } from "@/lib/products/sku-generate";
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
  brands,
  categories,
  stockStatuses,
  controls,
  cancelHref,
}: {
  productId: string;
  initial: ProductEditInitial;
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

  function setRowField(key: string, field: keyof VariantFields, value: string) {
    setRows((rs) =>
      rs.map((r) => (r.key === key ? { ...r, fields: { ...r.fields, [field]: value } } : r)),
    );
  }

  function addRow() {
    newRowCounter.current += 1;
    setRows((rs) => [
      ...rs,
      { key: `new-${newRowCounter.current}`, id: null, removed: false, fields: { ...EMPTY_VARIANT_FIELDS } },
    ]);
  }

  function removeRow(key: string) {
    setRows((rs) =>
      rs.flatMap((r) => {
        if (r.key !== key) return [r];
        // New row: drop it outright. Existing row: keep it visible, marked
        // removed, so the user can undo before saving.
        return r.id === null ? [] : [{ ...r, removed: true }];
      }),
    );
  }

  function restoreRow(key: string) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, removed: false } : r)));
  }

  function focusField(fieldId: string) {
    const el = document.getElementById(fieldId);
    if (el instanceof HTMLElement) el.focus();
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    const payload: ProductInput = { ...scalars, variants: buildVariantInputs(rows) };
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

  const activeCount = rows.filter((r) => !r.removed).length;

  // ── identity generators (UX.4B) — proposal only, form state only ────────────
  const [identity, setIdentity] = useState<CatalogIdentity | null>(null);
  const [identityBusy, setIdentityBusy] = useState(false);

  /** Fetch the catalog identity snapshot once (read-only) for collision-safe
   *  generation. Cached in state; a failure surfaces a fixed Arabic message. */
  async function ensureIdentity(): Promise<CatalogIdentity | null> {
    if (identity) return identity;
    setIdentityBusy(true);
    try {
      const res = await loadCatalogIdentity();
      if ("error" in res) {
        setError("تعذّر فحص الكتالوج للتوليد. حاول مرة أخرى.");
        return null;
      }
      setIdentity(res.data);
      return res.data;
    } finally {
      setIdentityBusy(false);
    }
  }

  async function genMainSku() {
    const id = await ensureIdentity();
    if (!id) return;
    if (scalars.sku.trim() !== "" && !window.confirm("سيتم استبدال SKU الحالي. متابعة؟")) return;
    setScalar("sku", nextMainSku(id.skus));
  }

  async function genMainBarcode() {
    const id = await ensureIdentity();
    if (!id) return;
    if (scalars.barcode.trim() !== "" && !window.confirm("سيتم استبدال الباركود الحالي. متابعة؟")) return;
    setScalar("barcode", nextMainBarcode(new Set(id.barcodes), Math.random));
  }

  // Variant tools operate on ACTIVE (non-removed) rows, in order. Each writes new
  // values into form state only — never a DB. "Missing" ops never touch a filled
  // field; "نسخ بادئة SKU" renumbers every variant and asks first when any exists.
  function genMissingVariantSku() {
    setRows((rs) => {
      const active = rs.filter((r) => !r.removed);
      const skus = fillMissingVariantSkus(scalars.sku, active.map((r) => ({ sku: r.fields.sku })));
      let k = -1;
      return rs.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, sku: skus[k] } })));
    });
  }

  async function genMissingVariantBarcode() {
    const id = await ensureIdentity();
    if (!id) return;
    setRows((rs) => {
      const active = rs.filter((r) => !r.removed);
      const bcs = fillMissingVariantBarcodes(
        active.map((r) => ({ barcode: r.fields.barcode })),
        new Set(id.barcodes),
        Math.random,
        [scalars.barcode],
      );
      let k = -1;
      return rs.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, barcode: bcs[k] } })));
    });
  }

  async function genAllMissing() {
    const id = await ensureIdentity();
    if (!id) return;
    setRows((rs) => {
      const active = rs.filter((r) => !r.removed);
      const out = generateAllMissingIdentity(
        scalars.sku,
        active.map((r) => ({ sku: r.fields.sku, barcode: r.fields.barcode })),
        new Set(id.barcodes),
        Math.random,
        [scalars.barcode],
      );
      let k = -1;
      return rs.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, sku: out.skus[k], barcode: out.barcodes[k] } })));
    });
  }

  function copyVariantSkuPrefix() {
    const anyNonEmpty = rows.some((r) => !r.removed && r.fields.sku.trim() !== "");
    if (anyNonEmpty && !window.confirm("سيتم إعادة ترقيم كل SKU للخيارات وفق SKU المنتج. متابعة؟")) return;
    setRows((rs) => {
      const count = rs.filter((r) => !r.removed).length;
      const skus = renumberVariantSkus(scalars.sku, count);
      let k = -1;
      return rs.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, sku: skus[k] } })));
    });
  }

  function copyVariantPrice() {
    setRows((rs) => {
      const active = rs.filter((r) => !r.removed);
      const prices = copyProductPriceToEmpty(scalars.price, active.map((r) => ({ price: r.fields.price })));
      let k = -1;
      return rs.map((r) => (r.removed ? r : (++k, { ...r, fields: { ...r.fields, price: prices[k] } })));
    });
  }

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
              <button type="button" className="btn-ghost shrink-0 px-2 py-1 text-xs disabled:opacity-50" disabled={identityBusy} onClick={() => void genMainSku()}>
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
              <button type="button" className="btn-ghost shrink-0 px-2 py-1 text-xs disabled:opacity-50" disabled={identityBusy} onClick={() => void genMainBarcode()}>
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
            busy={identityBusy}
            onGenerateMissingSku={genMissingVariantSku}
            onGenerateMissingBarcode={() => void genMissingVariantBarcode()}
            onGenerateAll={() => void genAllMissing()}
            onCopyPrefix={copyVariantSkuPrefix}
            onCopyPrice={copyVariantPrice}
          />
        ) : null}

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
                  <span className="text-xs font-medium text-muted">
                    {row.id === null ? "خيار جديد" : `خيار ${index + 1}`}
                  </span>
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
