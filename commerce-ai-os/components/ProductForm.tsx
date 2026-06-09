"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CATEGORIES, STOCK_STATUSES } from "@/lib/constants";
import type { Brand } from "@/lib/types";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  type ProductInput,
  type VariantInput,
} from "@/app/(app)/products/actions";

const EMPTY_VARIANT: VariantInput = {
  variant_name: "",
  sku: "",
  color: "",
  size: "",
  price: "",
  stock_quantity: "",
};

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

      {/* Identity */}
      <Section title="Identity">
        <Field label="SKU"><input className="input" value={form.sku} onChange={(e) => set("sku", e.target.value)} /></Field>
        <Field label="Barcode"><input className="input" value={form.barcode} onChange={(e) => set("barcode", e.target.value)} /></Field>
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
      </Section>

      {/* Media */}
      <Section title="Media">
        <Field label="Image filename"><input className="input" value={form.image_filename} onChange={(e) => set("image_filename", e.target.value)} /></Field>
        <Field label="Image URL"><input className="input" value={form.image_url} onChange={(e) => set("image_url", e.target.value)} /></Field>
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
          <button type="button" className="btn-ghost" onClick={addVariant}>+ Add variant</button>
        </div>
        {form.variants.length === 0 ? (
          <p className="text-sm text-slate-400">No variants. This product is sold as a single item.</p>
        ) : (
          <div className="space-y-2">
            {form.variants.map((v, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-6">
                <input className="input" placeholder="Variant name" value={v.variant_name} onChange={(e) => setVariant(i, "variant_name", e.target.value)} />
                <input className="input" placeholder="SKU" value={v.sku} onChange={(e) => setVariant(i, "sku", e.target.value)} />
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
      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-3 shadow-[0_-2px_10px_rgba(0,0,0,0.06)] backdrop-blur">
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
