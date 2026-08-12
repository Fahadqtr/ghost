"use client";

// Malikas V2 — AI Product Creator wizard (Phase UI.5). Client Component.
//
// Steps: upload → analyze → generate → duplicate check → review → save.
// NOTHING persists before حفظ: the image lives in memory as a data URL (the
// final upload happens inside the save action), and the product row is only
// written by createProductCore after the user approves. Every mutating call
// is double-submit guarded; every message shown is a fixed Arabic constant.
//
// Identity rules surfaced here, enforced server-side again:
// - main SKU is the catalog's mk<number> pattern, editable but validated;
// - variant SKUs are ALWAYS <main>-1..n, renumbered live on add/remove and on
//   a main-SKU edit (never mk123-01 / mk123-A / mk123-black);
// - barcodes come from the server's uniqueness-checked EAN-13 batch;
// - the stored image name is derived from the FINAL SKU at save time, so an
//   SKU edit automatically renames the image (never the original filename).

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  analyzeAiProductImage,
  createAiProduct,
  prepareAiProduct,
  type DuplicateCards,
  type PreparedIdentity,
} from "@/app/(v2)/v2/catalog/new/actions";
import SimilarProducts from "@/components/v2/catalog/SimilarProducts";
import { prepareImage, type PreparedImage } from "@/lib/imagePrep";
import ProductCompleteness from "@/components/v2/catalog/ProductCompleteness";
import { computeProductCompleteness } from "@/lib/products/product-completeness";
import VariantIdentityToolbar from "@/components/v2/catalog/VariantIdentityToolbar";
import { useVariantIdentity } from "@/components/v2/catalog/useVariantIdentity";
import {
  addVariantRow,
  removeVariantRow,
  renumberVariantRowSkus,
  updateVariantField,
  type VariantFieldKey,
  type VariantRowModel,
} from "@/lib/products/variant-model";
import { buildVariantInputs } from "@/lib/products/edit-form-state";
import { renumberVariantSkus, isValidMkSku, normalizeMkSku } from "@/lib/products/sku-generate";
import { CREATE_MESSAGES, validateAiProductInput } from "@/lib/products/create-validation";
import type { VisionExtract } from "@/lib/products/ai-extract";
import type { ProductInput } from "@/lib/products/product-save";
import type { EditBrand } from "@/lib/products/product-edit-read";
import { matchBrandId } from "@/lib/products/brand-match";
import { PRODUCT_GENERATION_FIELDS, toProductGenerationProposal } from "@/lib/products/product-generation";
import { PROPOSAL_SCALAR_MAP } from "@/lib/products/product-generation-form";

const ALLOWED_FILE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const CONFIDENCE_LABELS: Record<VisionExtract["confidence"], string> = {
  high: "ثقة عالية",
  medium: "ثقة متوسطة",
  low: "ثقة منخفضة",
};

// Variant rows use the shared VariantRowModel (UX.4E-2). The create wizard only
// ever produces NEW rows, so every row carries id: null and removed: false.

interface FormScalars {
  sku: string;
  barcode: string;
  name_en: string;
  name_ar: string;
  brand_id: string;
  main_category: string;
  sub_category: string;
  product_type: string;
  color: string;
  size: string;
  price: string;
  discount_price: string;
  cost: string;
  stock_quantity: string;
  stock_status: string;
  description_en: string;
  description_ar: string;
  keywords_en: string;
  keywords_ar: string;
  notes: string;
}

const EMPTY_SCALARS: FormScalars = {
  sku: "", barcode: "", name_en: "", name_ar: "", brand_id: "", main_category: "",
  sub_category: "", product_type: "", color: "", size: "", price: "",
  discount_price: "", cost: "", stock_quantity: "", stock_status: "",
  description_en: "", description_ar: "", keywords_en: "", keywords_ar: "", notes: "",
};

export default function AiProductCreator({
  brands,
  categories,
  stockStatuses,
}: {
  brands: EditBrand[];
  categories: string[];
  stockStatuses: string[];
}) {
  const [step, setStep] = useState<"upload" | "review">("upload");
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [note, setNote] = useState("");
  const [extract, setExtract] = useState<VisionExtract | null>(null);
  const [scalars, setScalars] = useState<FormScalars>(EMPTY_SCALARS);
  const [rows, setRows] = useState<VariantRowModel[]>([]);
  const [duplicates, setDuplicates] = useState<DuplicateCards | null>(null);
  const [partialScan, setPartialScan] = useState(false);
  // The image changed after an analysis: the AI-derived panels (confidence,
  // package text, duplicate report) belong to the OLD image, so they are
  // cleared until re-analysis. User-edited form fields are kept.
  const [imageStale, setImageStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, startSaving] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rowCounter = useRef(0);
  const busy = analyzing || checking || saving;

  const dirty = step === "review" || image !== null;
  useEffect(() => {
    if (!dirty || saving) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

  // ── image selection (nothing uploaded here) ────────────────────────────────

  async function onPickFile(file: File | null) {
    setError(null);
    if (!file) return;
    if (!ALLOWED_FILE_TYPES.has(file.type)) {
      setError(CREATE_MESSAGES.image_type);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(CREATE_MESSAGES.image_too_large);
      return;
    }
    try {
      const prepared = await prepareImage(file);
      setImage(prepared);
      if (step === "review") {
        setImageStale(true);
        setDuplicates(null);
      }
    } catch {
      setError(CREATE_MESSAGES.image_type);
    }
  }

  function clearImage() {
    setImage(null);
    if (step === "review") {
      setImageStale(true);
      setDuplicates(null);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // ── analysis + identity ────────────────────────────────────────────────────

  function setRowsFromExtract(x: VisionExtract, mainSku: string, barcodes: string[]) {
    const skus = renumberVariantSkus(mainSku, x.variants.length);
    setRows(
      x.variants.map((v, i) => {
        rowCounter.current += 1;
        return {
          key: `row-${rowCounter.current}`,
          id: null,
          removed: false,
          fields: {
            variant_name: v.variant_name,
            variant_name_en: v.variant_name_en,
            sku: skus[i],
            barcode: barcodes[i] ?? "",
            color: v.color,
            size: v.size,
            price: "",
            stock_quantity: "",
          },
        };
      }),
    );
  }

  async function runAnalysis() {
    if (!image || busy) return;
    setAnalyzing(true);
    setError(null);
    try {
      const res = await analyzeAiProductImage(image.base64, image.mediaType, note);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const x = res.data;
      setExtract(x);
      const prep = await prepareAiProduct(
        {
          sku: "",
          barcodes: [],
          brand: x.brand,
          nameEn: x.name_en,
          nameAr: x.name_ar,
          size: x.size,
          shade: x.shade,
        },
        x.variants.length,
      );
      if ("error" in prep) {
        setError(prep.error);
        return;
      }
      applyPrepared(x, prep.data);
      setImageStale(false);
      setStep("review");
    } finally {
      setAnalyzing(false);
    }
  }

  function applyPrepared(x: VisionExtract, prepared: PreparedIdentity) {
    // Content fields now flow through the SHARED proposal layer (same contract as
    // Edit): VisionExtract → proposal (shade→color, brand as a raw string), then
    // map each content field onto its form scalar and resolve the brand via the
    // shared matcher. This seeds the review form exactly as before (every content
    // field set from the analysis; identity SKU/barcode + variants unchanged) —
    // only the duplicated field-by-field mapping is gone.
    const proposal = toProductGenerationProposal(x, (x.visible_text ?? "").trim() ? "image+text" : "image");
    setScalars((s) => {
      const next: FormScalars = { ...s, sku: prepared.sku, barcode: prepared.productBarcode };
      for (const f of PRODUCT_GENERATION_FIELDS) {
        if (f === "brand") {
          next.brand_id = matchBrandId(brands, proposal.brand ?? "");
          continue;
        }
        next[PROPOSAL_SCALAR_MAP[f] as keyof FormScalars] = proposal[f] ?? "";
      }
      return next;
    });
    setRowsFromExtract(x, prepared.sku, prepared.variantBarcodes);
    setDuplicates(prepared.duplicates);
    setPartialScan(prepared.partial);
  }

  /** Re-scan identity (SKU pool, barcodes, duplicates) for the CURRENT form. */
  async function refreshIdentity(nextRowCount: number) {
    if (busy) return;
    setChecking(true);
    setError(null);
    try {
      const prep = await prepareAiProduct(
        {
          sku: "",
          barcodes: [],
          brand: brands.find((b) => b.id === scalars.brand_id)?.name ?? "",
          nameEn: scalars.name_en,
          nameAr: scalars.name_ar,
          size: scalars.size,
          shade: scalars.color,
        },
        nextRowCount,
      );
      if ("error" in prep) {
        setError(prep.error);
        return;
      }
      const d = prep.data;
      // Keep a user-edited (still valid) main SKU; refresh barcodes and the
      // duplicate report; variant SKUs always renumber from the main.
      const mainSku = isValidMkSku(scalars.sku) ? normalizeMkSku(scalars.sku) : d.sku;
      const skus = renumberVariantSkus(mainSku, nextRowCount);
      setScalars((s) => ({ ...s, sku: mainSku, barcode: s.barcode || d.productBarcode }));
      setRows((rs) =>
        rs.slice(0, nextRowCount).map((r, i) => ({
          ...r,
          fields: { ...r.fields, sku: skus[i], barcode: d.variantBarcodes[i] ?? r.fields.barcode },
        })),
      );
      setDuplicates(d.duplicates);
      setPartialScan(d.partial);
    } finally {
      setChecking(false);
    }
  }

  // ── variant rows ───────────────────────────────────────────────────────────

  // Row mutations go through the shared pure variant model (UX.4E-2). Every
  // create-wizard row is new (id: null), so a renumber over the whole list is
  // identical to the previous "renumber all rows" behavior.
  function renumber(rowsIn: VariantRowModel[], mainSku: string): VariantRowModel[] {
    return renumberVariantRowSkus(mainSku, rowsIn);
  }

  function addRow() {
    rowCounter.current += 1;
    const next = addVariantRow(rows, `row-${rowCounter.current}`);
    setRows(renumber(next, scalars.sku));
    // A new row needs a fresh uniqueness-checked barcode from the server.
    void refreshIdentity(next.length);
  }

  function removeRow(key: string) {
    const next = removeVariantRow(rows, key);
    setRows(renumber(next, scalars.sku));
    void refreshIdentity(next.length);
  }

  function setRowField(key: string, field: VariantFieldKey, value: string) {
    setRows((rs) => updateVariantField(rs, key, field, value));
  }

  function onMainSkuChange(value: string) {
    setScalars((s) => ({ ...s, sku: value }));
    if (isValidMkSku(value)) {
      setRows((rs) => renumber(rs, value));
    }
  }

  // ── identity generators (UX.4B → shared hook in UX.4E-2) ────────────────────
  // Orchestration + the seven generate/copy actions live in the shared hook. The
  // create wizard injects onMainSkuChange as setMainSku, so a generated MAIN SKU
  // renumbers the variant SKUs to the new prefix (its long-standing behavior).
  const variantIdentity = useVariantIdentity({
    mainSku: scalars.sku,
    mainBarcode: scalars.barcode,
    productPrice: scalars.price,
    rows,
    setMainSku: onMainSkuChange,
    setMainBarcode: (value) => setScalars((s) => ({ ...s, barcode: value })),
    setRows,
    onError: setError,
  });

  // ── save ───────────────────────────────────────────────────────────────────

  function buildInput(): ProductInput {
    // Create rows are all new (id: null, never removed), so buildVariantInputs
    // emits the same id-less VariantInput[] the inline mapping did.
    return {
      ...scalars,
      sku: normalizeMkSku(scalars.sku),
      approval: "",
      rejection_reason: "",
      platform_status: "",
      image_filename: "",
      image_url: "",
      variants: buildVariantInputs(rows),
    };
  }

  function focusField(fieldId: string) {
    const el = document.getElementById(fieldId);
    if (el instanceof HTMLElement) el.focus();
  }

  function onSave() {
    if (busy || !image) return;
    const payload = buildInput();
    const validation = validateAiProductInput(payload);
    if (!validation.ok) {
      setError(validation.message);
      focusField(validation.field);
      return;
    }
    if (duplicates?.level === "exact") {
      setError(CREATE_MESSAGES.duplicate_exact);
      return;
    }
    setError(null);
    startSaving(async () => {
      // On success the action redirects to the new product's detail page, so
      // this only resumes on failure. A stale SKU/barcode gets a fresh scan so
      // the user can immediately save again with updated numbers.
      const res = await createAiProduct(payload, image.base64, image.mediaType);
      if (res && typeof res.error === "string") {
        setError(res.error);
        if (res.error === CREATE_MESSAGES.sku_taken || res.error === CREATE_MESSAGES.barcode_taken) {
          setScalars((s) => ({ ...s, sku: "", barcode: "" }));
          await refreshIdentity(rows.length);
        }
      }
    });
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  const scalarInput = (key: keyof FormScalars, label: string, opts?: { ltr?: boolean; numeric?: boolean; textarea?: boolean }) => (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      {opts?.textarea ? (
        <textarea
          id={`create-${key}`}
          rows={4}
          dir={opts?.ltr ? "ltr" : undefined}
          className="input"
          value={scalars[key]}
          onChange={(e) => setScalars((s) => ({ ...s, [key]: e.target.value }))}
        />
      ) : (
        <input
          id={`create-${key}`}
          dir={opts?.ltr ? "ltr" : undefined}
          inputMode={opts?.numeric ? "decimal" : undefined}
          className="input"
          value={scalars[key]}
          onChange={(e) => setScalars((s) => ({ ...s, [key]: e.target.value }))}
        />
      )}
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-ink">إضافة منتج بالذكاء الاصطناعي</h1>
        <Link href="/v2/catalog" className="btn-ghost" aria-disabled={busy}>
          إلغاء
        </Link>
      </div>

      {error ? (
        <div role="alert" className="card border-rose-200 bg-rose-50 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      {/* Step 1: image */}
      <section className="card space-y-3">
        <h2 className="text-sm font-semibold text-ink">١ · صورة المنتج</h2>
        <input
          ref={fileInputRef}
          id="create-image-file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        />
        {image ? (
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- in-memory preview data URL */}
            <img src={image.dataUrl} alt="معاينة صورة المنتج" className="h-40 w-40 rounded-xl border border-[#efe3d6] object-cover" />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                تغيير الصورة
              </button>
              <button type="button" className="btn-ghost text-rose-600" disabled={busy} onClick={clearImage}>
                حذف الصورة
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            اختيار صورة (JPG / PNG / WEBP)
          </button>
        )}
        <label className="flex flex-col gap-1">
          <span className="label">ملاحظة اختيارية للتحليل (لون حقيقي، خيارات، تصحيح…)</span>
          <input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="button" className="btn-primary disabled:opacity-60" disabled={!image || busy} onClick={() => void runAnalysis()}>
          {analyzing ? "جارٍ تحليل الصورة…" : step === "review" ? "إعادة التحليل" : "تحليل الصورة"}
        </button>
      </section>

      {step === "review" && extract ? (
        <>
          {/* Confidence + duplicates */}
          <section className="card space-y-2">
            {imageStale ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                الصورة تغيّرت — نتائج التحليل السابقة أُخفيت. اضغط «إعادة التحليل» لتحديث البيانات المستخرجة.
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge">{CONFIDENCE_LABELS[extract.confidence]}</span>
                {extract.visible_text ? (
                  <span className="text-xs text-muted">نص العبوة: {extract.visible_text}</span>
                ) : null}
              </div>
            )}
            {!imageStale && extract.confidence === "low" ? (
              <p className="text-xs text-amber-700">ثقة منخفضة — راجع الحقول بعناية قبل الحفظ.</p>
            ) : null}
            {partialScan ? (
              <p className="text-xs text-amber-700">تم فحص جزء من الكتالوج فقط ضمن الحد الآمن للقراءة.</p>
            ) : null}
            {duplicates ? (
              <SimilarProducts level={duplicates.level} cards={duplicates.cards} total={duplicates.total} />
            ) : null}
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void refreshIdentity(rows.length)}>
              {checking ? "جارٍ الفحص…" : "إعادة فحص التكرار والأرقام"}
            </button>
          </section>

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
              hasImage: image !== null,
              variantCount: rows.length,
            })}
          />

          {/* Review fields */}
          <section className="card space-y-3">
            <h2 className="text-sm font-semibold text-ink">٢ · مراجعة البيانات</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {scalarInput("name_ar", "الاسم (عربي)")}
              {scalarInput("name_en", "الاسم (إنجليزي)", { ltr: true })}
              <label className="flex flex-col gap-1">
                <span className="label">العلامة التجارية</span>
                <select
                  id="create-brand_id"
                  className="select-input"
                  value={scalars.brand_id}
                  onChange={(e) => setScalars((s) => ({ ...s, brand_id: e.target.value }))}
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
                <span className="label">التصنيف</span>
                <select
                  id="create-main_category"
                  className="select-input"
                  value={scalars.main_category}
                  onChange={(e) => setScalars((s) => ({ ...s, main_category: e.target.value }))}
                >
                  <option value="">— اختر —</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              {scalarInput("product_type", "نوع المنتج")}
              {scalarInput("size", "الحجم")}
              {scalarInput("color", "الدرجة / اللون")}
              <label className="flex flex-col gap-1">
                <span className="label">حالة المخزون</span>
                <select
                  id="create-stock_status"
                  className="select-input"
                  value={scalars.stock_status}
                  onChange={(e) => setScalars((s) => ({ ...s, stock_status: e.target.value }))}
                >
                  <option value="">— بدون —</option>
                  {stockStatuses.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              {scalarInput("price", "السعر (ر.ق)", { ltr: true, numeric: true })}
              {scalarInput("discount_price", "سعر الخصم (ر.ق)", { ltr: true, numeric: true })}
              {scalarInput("cost", "التكلفة (ر.ق)", { ltr: true, numeric: true })}
              {scalarInput("stock_quantity", "الكمية", { ltr: true, numeric: true })}
              <label className="flex flex-col gap-1">
                <span className="label">SKU</span>
                <div className="flex items-center gap-2">
                  <input
                    id="create-sku"
                    dir="ltr"
                    className="input flex-1"
                    value={scalars.sku}
                    onChange={(e) => onMainSkuChange(e.target.value)}
                  />
                  <button type="button" className="btn-ghost shrink-0 px-2 py-1 text-xs disabled:opacity-50" disabled={busy || variantIdentity.identityBusy} onClick={() => void variantIdentity.generateMainSku()}>
                    توليد
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="label">الباركود (EAN-13)</span>
                <div className="flex items-center gap-2">
                  <input
                    id="create-barcode"
                    dir="ltr"
                    inputMode="numeric"
                    className="input flex-1"
                    value={scalars.barcode}
                    onChange={(e) => setScalars((s) => ({ ...s, barcode: e.target.value }))}
                  />
                  <button type="button" className="btn-ghost shrink-0 px-2 py-1 text-xs disabled:opacity-50" disabled={busy || variantIdentity.identityBusy} onClick={() => void variantIdentity.generateMainBarcode()}>
                    توليد
                  </button>
                </div>
              </label>
              {scalarInput("description_ar", "الوصف (عربي)", { textarea: true })}
              {scalarInput("description_en", "الوصف (إنجليزي)", { ltr: true, textarea: true })}
              {scalarInput("keywords_ar", "كلمات مفتاحية (عربي)")}
              {scalarInput("keywords_en", "كلمات مفتاحية (إنجليزي)", { ltr: true })}
            </div>
          </section>

          {/* Variants */}
          <section id="create-variants" tabIndex={-1} className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">٣ · الخيارات ({rows.length})</h2>
              <button type="button" onClick={addRow} disabled={busy} className="btn-ghost">
                + إضافة خيار
              </button>
            </div>

            {/* Variant identity tools (UX.4B) — proposal only, form state only. */}
            {rows.length > 0 ? (
              <VariantIdentityToolbar
                disabled={busy}
                busy={variantIdentity.identityBusy}
                onGenerateMissingSku={variantIdentity.generateMissingVariantSku}
                onGenerateMissingBarcode={() => void variantIdentity.generateMissingVariantBarcode()}
                onGenerateAll={() => void variantIdentity.generateAllMissing()}
                onCopyPrefix={variantIdentity.copyVariantSkuPrefix}
                onCopyPrice={variantIdentity.copyVariantPrice}
              />
            ) : null}
            {rows.length === 0 ? (
              <p className="text-sm text-muted">منتج بدون خيارات — يمكنك إضافة خيارات (ألوان/درجات/أحجام) قبل الحفظ.</p>
            ) : (
              <div className="space-y-3">
                {rows.map((row, i) => (
                  <div key={row.key} className="rounded-xl border border-[#efe3d6] bg-white p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium text-muted" dir="ltr">
                        {row.fields.sku}
                      </span>
                      <button type="button" onClick={() => removeRow(row.key)} disabled={busy} className="btn-ghost text-xs text-rose-600">
                        حذف الخيار
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {(
                        [
                          ["variant_name", "اسم الخيار (عربي)", false],
                          ["variant_name_en", "اسم الخيار (إنجليزي)", true],
                          ["color", "اللون", false],
                          ["size", "الحجم", false],
                          ["price", "السعر (ر.ق)", true],
                          ["stock_quantity", "الكمية", true],
                          ["barcode", "الباركود (EAN-13)", true],
                        ] as const
                      ).map(([field, label, ltr]) => (
                        <label key={field} className="flex flex-col gap-1">
                          <span className="label">{label}</span>
                          <input
                            id={`create-variant-${i}-${field}`}
                            dir={ltr ? "ltr" : undefined}
                            className="input"
                            value={row.fields[field]}
                            onChange={(e) => setRowField(row.key, field, e.target.value)}
                          />
                        </label>
                      ))}
                      <label className="flex flex-col gap-1">
                        <span className="label">SKU الخيار (تلقائي)</span>
                        <input id={`create-variant-${i}-sku`} dir="ltr" className="input" value={row.fields.sku} readOnly />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Save */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onSave}
              disabled={busy || !image || duplicates?.level === "exact"}
              className="btn-primary disabled:opacity-60"
            >
              {saving ? "جارٍ الحفظ…" : "حفظ المنتج"}
            </button>
            <Link href="/v2/catalog" className="btn-ghost" aria-disabled={busy}>
              إلغاء
            </Link>
            <span className="text-xs text-muted">لن يُحفظ أي شيء قبل الضغط على «حفظ المنتج». المنتج الجديد يُنشأ غير معتمد ولا يُرسل لأي منصة.</span>
          </div>
        </>
      ) : null}
    </div>
  );
}
