"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CATEGORIES, STOCK_STATUSES } from "@/lib/constants";
import type { Brand } from "@/lib/types";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  nextProductSku,
  describeProductFromImage,
  type ProductInput,
  type VariantInput,
} from "@/app/(app)/products/actions";
import { uploadNewProductImage, editNewProductImage } from "@/app/(app)/products/image-actions";
import { prepareImage, dataUrlToFile } from "@/lib/imagePrep";

const EMPTY_VARIANT: VariantInput = {
  variant_name: "",
  sku: "",
  barcode: "",
  color: "",
  size: "",
  price: "",
  stock_quantity: "",
};

// slug للـSKU: "Iphone 16 Pro" -> "iphone-16-pro"
function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// توليد باركود EAN-13 صالح (12 رقم + خانة تحقّق)
function genEan13(): string {
  let d = "";
  for (let i = 0; i < 12; i++) d += Math.floor(Math.random() * 10);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * Number(d[i]);
  const check = (10 - (sum % 10)) % 10;
  return d + check;
}

function emptyInput(): ProductInput {
  return {
    sku: "",
    barcode: "",
    name_en: "",
    name_ar: "",
    brand_id: "",
    main_category: "",
    sub_category: "",
    product_type: "",
    color: "",
    size: "",
    price: "",
    discount_price: "",
    cost: "",
    stock_quantity: "",
    stock_status: "",
    platform_status: "",
    approval: "",
    rejection_reason: "",
    image_filename: "",
    image_url: "",
    description_en: "",
    description_ar: "",
    keywords_en: "",
    keywords_ar: "",
    notes: "",
    variants: [],
  };
}

export default function ProductForm({
  brands,
  productId,
  initial,
}: {
  brands: Brand[];
  productId?: string;
  initial?: Partial<ProductInput>;
}) {
  const router = useRouter();
  const [form, setForm] = useState<ProductInput>({
    ...emptyInput(),
    ...initial,
    variants: initial?.variants ?? [],
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The edit page also has a separate ProductImages panel that persists the new
  // primary photo server-side and then router.refresh()es. That refresh feeds a
  // fresh `initial.image_url` in, but useState only reads it once — so without
  // this sync the form keeps its stale (often empty) image_url and the next
  // Save would overwrite the freshly-uploaded photo with a blank value, wiping
  // it from the catalog. Adjust state during render when the server's primary
  // image changes (React's recommended pattern), leaving in-form edits intact.
  const [serverImage, setServerImage] = useState(initial?.image_url ?? "");
  if ((initial?.image_url ?? "") !== serverImage) {
    setServerImage(initial?.image_url ?? "");
    setForm((f) => ({
      ...f,
      image_url: initial?.image_url ?? "",
      image_filename: initial?.image_filename ?? f.image_filename,
    }));
  }

  const set = (k: keyof ProductInput, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const setVariant = (i: number, k: keyof VariantInput, v: string) =>
    setForm((f) => {
      const variants = [...f.variants];
      variants[i] = { ...variants[i], [k]: v };
      return { ...f, variants };
    });

  const addVariant = () =>
    setForm((f) => ({ ...f, variants: [...f.variants, { ...EMPTY_VARIANT }] }));
  const removeVariant = (i: number) =>
    setForm((f) => ({ ...f, variants: f.variants.filter((_, idx) => idx !== i) }));

  // توليد باركود للمنتج الرئيسي
  const generateBarcode = () => setForm((f) => ({ ...f, barcode: genEan13() }));

  // مسح بالماسح: الماسح يرسل Enter بعد الباركود. بدل ما يحفظ الفورم، ننتقل لحقل
  // باركود الخيار التالي ليُمسح بسرعة (وللأخير نخرج من الحقل بدون حفظ).
  const focusVariantBarcode = (idx: number) => {
    const el = document.querySelector(`[data-vbc="${idx}"]`) as HTMLInputElement | null;
    if (el) {
      el.focus();
      el.select();
    }
    return !!el;
  };
  const onBarcodeEnter = (e: React.KeyboardEvent, nextIdx: number) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!focusVariantBarcode(nextIdx)) (e.target as HTMLInputElement).blur();
    }
  };

  // توليد باركود الخيارات: نفس الباركود الرئيسي + لاحقة تسلسلية (-1، -2…).
  // لو الرئيسي فاضي نولّد له EAN-13 أول، ونملأ الخيارات الفاضية فقط.
  const generateVariantBarcodes = () =>
    setForm((f) => {
      const base = f.barcode.trim() || genEan13();
      return {
        ...f,
        barcode: base,
        variants: f.variants.map((v, i) =>
          v.barcode.trim() ? v : { ...v, barcode: `${base}-${i + 1}` }
        ),
      };
    });

  // --- SKU generation -------------------------------------------------------
  const [skuBusy, setSkuBusy] = useState(false);
  // توليد SKU للمنتج (mk#### التالي في الكتالوج).
  const generateSku = async () => {
    setSkuBusy(true);
    const res = await nextProductSku();
    setSkuBusy(false);
    if (res.error) { setError(res.error); return; }
    if (res.sku) setForm((f) => ({ ...f, sku: res.sku }));
    return res.sku;
  };
  // توليد SKU للخيارات: {parentSku}-{N}-{slug(name)}. يملأ الفاضية فقط، ويولّد
  // SKU رئيسي أول لو كان فاضياً.
  const generateVariantSkus = async () => {
    let base = form.sku.trim();
    if (!base) base = (await generateSku()) || "";
    if (!base) return;
    setForm((f) => ({
      ...f,
      sku: base,
      variants: f.variants.map((v, i) =>
        v.sku.trim()
          ? v
          : { ...v, sku: `${base}-${i + 1}${v.variant_name.trim() ? `-${slug(v.variant_name)}` : ""}` }
      ),
    }));
  };

  // For a NEW product, pre-fill the SKU with the next mk#### on first load.
  useEffect(() => {
    if (!productId && !form.sku.trim()) void generateSku();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Image upload (computer or phone camera) ------------------------------
  const [upBusy, setUpBusy] = useState(false);
  const onUploadImage = async (file: File | null | undefined) => {
    if (!file) return;
    setUpBusy(true);
    setAiMsg(null);
    setError(null);
    try {
      // Phone photos are 3–12 MB and server actions cap request bodies, so
      // downscale in the browser FIRST (same pipeline as the staff tab). The
      // try/finally also guarantees the busy state can never get stuck.
      const prepped = await prepareImage(file);
      const fd = new FormData();
      fd.append("file", dataUrlToFile(prepped.dataUrl, file.name || "photo.jpg"));
      if (form.sku.trim()) fd.append("sku", form.sku.trim());
      const res = await uploadNewProductImage(fd);
      if ("error" in res && res.error) { setError(res.error); return; }
      const url = (res as any).url as string;
      const filename = (res as any).filename as string;
      setForm((f) => ({ ...f, image_url: url, image_filename: filename }));
      // Auto-draft title/description from the freshly uploaded image when empty.
      if (!form.name_en.trim() && !form.description_en.trim()) await describeFromImage(url);
    } catch {
      setError("تعذّر رفع الصورة — جرّب صورة أصغر أو أعد المحاولة.");
    } finally {
      setUpBusy(false);
    }
  };

  // --- AI: title + description from the product image ------------------------
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const describeFromImage = async (urlOverride?: string) => {
    const url = (urlOverride ?? form.image_url).trim();
    if (!url) { setAiMsg("أضف Image URL أولاً."); return; }
    setAiBusy(true);
    setAiMsg(null);
    const res = await describeProductFromImage(url);
    setAiBusy(false);
    if (res.error) { setAiMsg(res.error); return; }
    const d = res.data!;
    // Fill empty fields; don't clobber anything the user already typed.
    setForm((f) => ({
      ...f,
      name_en: f.name_en.trim() || d.name_en,
      name_ar: f.name_ar.trim() || d.name_ar,
      description_en: f.description_en.trim() || d.description_en,
      description_ar: f.description_ar.trim() || d.description_ar,
      keywords_en: f.keywords_en.trim() || d.keywords_en,
      keywords_ar: f.keywords_ar.trim() || d.keywords_ar,
      main_category: f.main_category.trim() || d.main_category,
    }));
    setAiMsg("تم توليد العنوان والوصف والفئة ✓");
  };

  // --- AI: edit the product photo (same engine as the staff tab) -------------
  const [editPrompt, setEditPrompt] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const editImage = async () => {
    const src = form.image_url.trim();
    if (!src || !editPrompt.trim() || editBusy) return;
    setEditBusy(true);
    setAiMsg(null);
    const r = await editNewProductImage(src, editPrompt);
    setEditBusy(false);
    if ("error" in r) { setAiMsg(r.error); return; }
    setForm((f) => ({ ...f, image_url: r.imageUrl, image_filename: r.imageUrl.split("/").pop() ?? f.image_filename }));
    setEditPrompt("");
    setAiMsg("تم تعديل الصورة ✓");
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const res = productId
      ? await updateProduct(productId, form)
      : await createProduct(form);
    // On success the action redirects; only errors return here.
    if (res?.error) {
      setError(res.error);
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!productId) return;
    if (!confirm("Delete this product and its variants/inventory? This cannot be undone.")) return;
    setSaving(true);
    const res = await deleteProduct(productId);
    if (res?.error) {
      setError(res.error);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {/* Photo-first hero (new products) — same flow as the staff tab: one
          photo → AI drafts name/description/keywords/category into the form. */}
      {!productId ? (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-violet-200 bg-violet-50/50 p-4 text-center">
          {form.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={form.image_url} alt="" className="max-h-40 rounded-lg object-contain" />
          ) : (
            <>
              <span className="text-3xl">📸</span>
              <span className="text-sm font-medium text-violet-700">صوّر المنتج أو ارفع صورة</span>
              <span className="text-xs text-muted">يتولّد الاسم والوصف والفئة تلقائيًا</span>
            </>
          )}
          {upBusy || aiBusy ? (
            <span className="text-xs text-violet-600">{upBusy ? "…يرفع الصورة" : "…يحلّل الصورة ويكتب الحقول"}</span>
          ) : null}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            disabled={upBusy || aiBusy}
            onChange={(e) => { void onUploadImage(e.target.files?.[0]); e.target.value = ""; }}
          />
        </label>
      ) : null}

      {/* Identity */}
      <Section title="Identity">
        <Field label="SKU">
          <div className="flex gap-2">
            <input className="input flex-1" value={form.sku} onChange={(e) => set("sku", e.target.value)} />
            <button type="button" className="btn-ghost whitespace-nowrap disabled:opacity-50" onClick={generateSku} disabled={skuBusy}>
              {skuBusy ? "…" : "توليد"}
            </button>
          </div>
        </Field>
        <Field label="Barcode">
          <div className="flex gap-2">
            <input className="input flex-1" value={form.barcode} onChange={(e) => set("barcode", e.target.value)} onKeyDown={(e) => onBarcodeEnter(e, 0)} />
            <button type="button" className="btn-ghost whitespace-nowrap" onClick={generateBarcode}>توليد</button>
          </div>
        </Field>
        <Field label="Name (EN)"><input className="input" value={form.name_en} onChange={(e) => set("name_en", e.target.value)} /></Field>
        <Field label="Name (AR)"><input dir="rtl" className="input" value={form.name_ar} onChange={(e) => set("name_ar", e.target.value)} /></Field>
      </Section>

      {/* Classification */}
      <Section title="Classification">
        <Field label="Brand">
          <select className="input" value={form.brand_id} onChange={(e) => set("brand_id", e.target.value)}>
            <option value="">— Select brand —</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <select className="input" value={form.main_category} onChange={(e) => set("main_category", e.target.value)}>
            <option value="">— Select category —</option>
            {/* Always include the product's current category, even if it's not
                in the known list, so editing never silently drops it. */}
            {(form.main_category && !CATEGORIES.includes(form.main_category as (typeof CATEGORIES)[number])
              ? [form.main_category, ...CATEGORIES]
              : CATEGORIES
            ).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Sub-category"><input className="input" value={form.sub_category} onChange={(e) => set("sub_category", e.target.value)} /></Field>
        <Field label="Product type"><input className="input" value={form.product_type} onChange={(e) => set("product_type", e.target.value)} /></Field>
        <Field label="Color"><input className="input" value={form.color} onChange={(e) => set("color", e.target.value)} /></Field>
        <Field label="Size"><input className="input" value={form.size} onChange={(e) => set("size", e.target.value)} /></Field>
      </Section>

      {/* Pricing & stock */}
      <Section title="Pricing & Stock">
        <Field label="Price"><input type="number" step="0.01" className="input" value={form.price} onChange={(e) => set("price", e.target.value)} /></Field>
        <Field label="Discount price"><input type="number" step="0.01" className="input" value={form.discount_price} onChange={(e) => set("discount_price", e.target.value)} /></Field>
        <Field label="Cost"><input type="number" step="0.01" className="input" value={form.cost} onChange={(e) => set("cost", e.target.value)} /></Field>
        <Field label="Stock quantity"><input type="number" className="input" value={form.stock_quantity} onChange={(e) => set("stock_quantity", e.target.value)} /></Field>
        <Field label="Stock status">
          <select className="input" value={form.stock_status} onChange={(e) => set("stock_status", e.target.value)}>
            <option value="">— Select —</option>
            {STOCK_STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </Field>
        <Field label="Platform status"><input className="input" value={form.platform_status} onChange={(e) => set("platform_status", e.target.value)} /></Field>
        <Field label="حالة الاعتماد · Approval">
          <select className="input" value={form.approval} onChange={(e) => set("approval", e.target.value)}>
            <option value="">— بدون / unset —</option>
            <option value="Approved">Approved · معتمد</option>
            <option value="Rejected">Rejected · مرفوض</option>
            <option value="SentAI">SentAI</option>
          </select>
        </Field>
        {form.approval === "Rejected" ? (
          <Field label="سبب الرفض · Rejection reason">
            <input className="input" value={form.rejection_reason} onChange={(e) => set("rejection_reason", e.target.value)} placeholder="مثال: بسبب الصورة" />
          </Field>
        ) : null}
      </Section>

      {/* Media */}
      <Section title="Media">
        {!productId && (
          <Field label="رفع صورة من الكمبيوتر · Upload image" wide>
            <div className="flex flex-wrap items-center gap-3">
              <label className="btn-ghost cursor-pointer whitespace-nowrap">
                {upBusy ? "…يرفع" : "📁 اختر صورة"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  disabled={upBusy}
                  onChange={(e) => { void onUploadImage(e.target.files?.[0]); e.target.value = ""; }}
                />
              </label>
              {form.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={form.image_url} alt="" className="h-14 w-14 rounded-sm border border-slate-200 object-contain" />
              ) : (
                <span className="text-xs text-muted">JPG / PNG / WebP / GIF · حتى 10MB</span>
              )}
            </div>
          </Field>
        )}
        <Field label="Image filename"><input className="input" value={form.image_filename} onChange={(e) => set("image_filename", e.target.value)} /></Field>
        <Field label="Image URL">
          <input
            className="input"
            value={form.image_url}
            onChange={(e) => set("image_url", e.target.value)}
            onBlur={() => {
              // Auto-draft once when an image is added and content is still empty.
              if (form.image_url.trim() && !form.name_en.trim() && !form.description_en.trim() && !aiBusy) void describeFromImage();
            }}
          />
        </Field>
        <Field label="الذكاء · AI" wide>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-ghost whitespace-nowrap disabled:opacity-50"
              onClick={() => void describeFromImage()}
              disabled={aiBusy || !form.image_url.trim()}
            >
              {aiBusy ? "…يحلّل الصورة" : "✨ توليد العنوان والوصف من الصورة"}
            </button>
            {aiMsg ? <span className="text-xs text-muted">{aiMsg}</span> : null}
          </div>
          {form.image_url.trim() ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="input flex-1 text-sm"
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
                placeholder="عدّل الصورة بالذكاء — مثال: خلفية بيضاء نظيفة، إضاءة أنقى"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void editImage(); } }}
              />
              <button
                type="button"
                className="btn-ghost whitespace-nowrap disabled:opacity-50"
                onClick={() => void editImage()}
                disabled={editBusy || !editPrompt.trim()}
              >
                {editBusy ? "…يعدّل" : "✨ عدّل الصورة"}
              </button>
            </div>
          ) : null}
        </Field>
      </Section>

      {/* Content */}
      <Section title="Content">
        <Field label="Description (EN)" wide><textarea className="input min-h-20" value={form.description_en} onChange={(e) => set("description_en", e.target.value)} /></Field>
        <Field label="Description (AR)" wide><textarea dir="rtl" className="input min-h-20" value={form.description_ar} onChange={(e) => set("description_ar", e.target.value)} /></Field>
        <Field label="Keywords (EN)"><input className="input" value={form.keywords_en} onChange={(e) => set("keywords_en", e.target.value)} /></Field>
        <Field label="Keywords (AR)"><input dir="rtl" className="input" value={form.keywords_ar} onChange={(e) => set("keywords_ar", e.target.value)} /></Field>
        <Field label="Notes" wide><textarea className="input min-h-16" value={form.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
      </Section>

      {/* Variants (parent-child) */}
      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">Variants</h3>
            <p className="text-xs text-muted">Parent–child rows. Drives the Talabat splitter in a later phase.</p>
          </div>
          <div className="flex gap-2">
            {form.variants.length > 0 ? (
              <>
                <button type="button" className="btn-ghost whitespace-nowrap" onClick={generateVariantSkus} title="{SKU الرئيسي}-1-اسم-الخيار…">
                  توليد SKU الخيارات
                </button>
                <button type="button" className="btn-ghost whitespace-nowrap" onClick={generateVariantBarcodes} title="نفس الباركود الرئيسي + -1، -2…">
                  توليد باركود الخيارات
                </button>
              </>
            ) : null}
            <button type="button" className="btn-ghost" onClick={addVariant}>+ Add variant</button>
          </div>
        </div>
        {form.variants.length === 0 ? (
          <p className="text-sm text-slate-400">No variants. This product is sold as a single item.</p>
        ) : (
          <div className="space-y-2">
            {form.variants.map((v, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-7">
                <input className="input" placeholder="Variant name" value={v.variant_name} onChange={(e) => setVariant(i, "variant_name", e.target.value)} />
                <input className="input" placeholder="SKU" value={v.sku} onChange={(e) => setVariant(i, "sku", e.target.value)} />
                <input className="input" placeholder="Barcode" data-vbc={i} value={v.barcode} onChange={(e) => setVariant(i, "barcode", e.target.value)} onKeyDown={(e) => onBarcodeEnter(e, i + 1)} />
                <input className="input" placeholder="Color" value={v.color} onChange={(e) => setVariant(i, "color", e.target.value)} />
                <input className="input" placeholder="Size" value={v.size} onChange={(e) => setVariant(i, "size", e.target.value)} />
                <input className="input" type="number" step="0.01" placeholder="Price" value={v.price} onChange={(e) => setVariant(i, "price", e.target.value)} />
                <div className="flex gap-2">
                  <input className="input" type="number" placeholder="Stock" value={v.stock_quantity} onChange={(e) => setVariant(i, "stock_quantity", e.target.value)} />
                  <button type="button" className="btn-ghost px-2 text-red-600" onClick={() => removeVariant(i)} title="Remove">✕</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions — sticky so the Save button is always reachable on mobile,
          where the long form would otherwise push it below the fold. */}
      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-3 shadow-[0_-2px_10px_rgba(0,0,0,0.06)] backdrop-blur-sm">
        <div className="flex gap-2">
          <button type="submit" disabled={saving} className="btn-primary disabled:opacity-60">
            {saving ? "Saving…" : productId ? "Save changes" : "Create product"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => router.push("/products")}>Cancel</button>
        </div>
        {productId ? (
          <button type="button" onClick={onDelete} disabled={saving} className="btn-ghost text-red-600">Delete</button>
        ) : null}
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3 className="mb-3 text-sm font-semibold text-ink">{title}</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}
