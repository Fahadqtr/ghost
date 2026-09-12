"use client";

// STAFF COPY PANEL — نسخ بيانات المنتج.
//
// READ-ONLY. Every control here either writes to the clipboard or starts a
// download; there is no form, no mutation, and no write endpoint in the file.
// Downloads go through the existing same-origin image proxy so cross-origin
// storage images work without CORS, and the ZIP is requested BY PRODUCT ID so
// the server — not the browser — decides which photos belong to this product.

import { useCallback, useMemo, useState } from "react";
import {
  buildCopyAllText,
  buildCopyFields,
  buildDownloadUrlPayload,
  buildVariantCopyAllText,
  buildVariantFields,
  imagesZipFilename,
  planProductImageZip,
  type CopyField,
  type CopyPanelImage,
  type CopyPanelProduct,
  type CopyPanelVariant,
} from "@/lib/catalog/copy-panel/copy-panel";

const COPIED = "تم النسخ ✓";
const COPY_FAILED = "تعذّر النسخ";

/** The app's own download endpoint — never the raw storage URL. */
function proxyHref(url: string, filename: string): string {
  return `/api/products/image?url=${encodeURIComponent(url)}&dl=1&name=${encodeURIComponent(filename)}`;
}

function absolute(href: string): string {
  if (typeof window === "undefined") return "";
  try {
    return new URL(href, window.location.origin).toString();
  } catch {
    return "";
  }
}

function useFlash() {
  const [flash, setFlash] = useState<{ key: string; text: string } | null>(null);
  const show = useCallback((key: string, text: string) => {
    setFlash({ key, text });
    setTimeout(() => setFlash((c) => (c && c.key === key ? null : c)), 1600);
  }, []);
  return { flash, show };
}

async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({
  value, fieldKey, onCopied, label = "نسخ", className = "",
}: { value: string; fieldKey: string; onCopied: (key: string, ok: boolean) => void; label?: string; className?: string }) {
  return (
    <button
      type="button"
      data-testid={`copy-${fieldKey}`}
      className={`btn-ghost shrink-0 px-3 py-1 text-xs ${className}`}
      onClick={async () => onCopied(fieldKey, await writeClipboard(value))}
    >
      {label}
    </button>
  );
}

function FieldRow({ field, flashKey, flashText, onCopied }: {
  field: CopyField; flashKey: string | null; flashText: string; onCopied: (k: string, ok: boolean) => void;
}) {
  const flashing = flashKey === field.key;
  return (
    <div data-testid={`field-${field.key}`} className="rounded-xl border border-[#efe3d6] bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-muted">{field.label}</div>
          {field.multiline ? (
            <div className="mt-1 max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-[#faf6f1] p-2 text-xs leading-relaxed text-ink">
              {field.value}
            </div>
          ) : (
            <div className="mt-0.5 break-words text-sm text-ink">{field.value}</div>
          )}
        </div>
        <CopyButton value={field.value} fieldKey={field.key} onCopied={onCopied} />
      </div>
      {flashing ? <div className="mt-1 text-[11px] text-emerald-700">{flashText}</div> : null}
    </div>
  );
}

function ImageCard({ image, filename, onCopied, flashKey, flashText }: {
  image: CopyPanelImage; filename: string; onCopied: (k: string, ok: boolean) => void;
  flashKey: string | null; flashText: string;
}) {
  const key = `img-${filename}`;
  const href = proxyHref(image.url, filename);

  // Drag-to-desktop: Chromium reads `DownloadURL` and writes the file where it
  // is dropped. Other browsers ignore it and the drag simply does nothing —
  // the Download button below is the documented fallback, so support is never
  // faked. text/uri-list keeps the drag meaningful for other drop targets.
  const onDragStart = (e: React.DragEvent<HTMLElement>) => {
    const payload = buildDownloadUrlPayload(filename, absolute(href));
    if (payload) e.dataTransfer.setData("DownloadURL", payload);
    const direct = absolute(href);
    if (direct !== "") {
      e.dataTransfer.setData("text/uri-list", direct);
      e.dataTransfer.setData("text/plain", direct);
    }
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div data-testid={key} className="space-y-1.5 rounded-xl border border-[#efe3d6] bg-white p-2">
      <div
        draggable
        onDragStart={onDragStart}
        data-drag-filename={filename}
        title="اسحب الصورة إلى سطح المكتب، أو استخدم زر التنزيل"
        className="relative aspect-square cursor-grab overflow-hidden rounded-lg border border-[#efe3d6] bg-[#faf6f1] active:cursor-grabbing"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- storage URL, no next/image remote config */}
        <img src={image.url} alt={filename} loading="lazy" draggable={false} className="block h-full w-full object-cover" />
        {image.isPrimary ? (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-brand px-2 py-0.5 text-[10px] font-bold text-white">الأساسية</span>
        ) : null}
      </div>
      <div className="truncate text-[11px] text-muted" title={filename}>{filename}</div>
      <div className="flex flex-wrap gap-1.5">
        <a href={href} download className="btn-ghost px-2 py-1 text-[11px]" data-testid={`download-${filename}`}>تنزيل الصورة</a>
        <CopyButton value={image.url} fieldKey={`url-${filename}`} onCopied={onCopied} label="نسخ رابط الصورة" />
      </div>
      {flashKey === `url-${filename}` ? <div className="text-[11px] text-emerald-700">{flashText}</div> : null}
    </div>
  );
}

export default function CopyProductPanel({
  productId, product, variants, images,
}: {
  productId: string;
  product: CopyPanelProduct;
  variants: readonly CopyPanelVariant[];
  images: readonly CopyPanelImage[];
}) {
  const [open, setOpen] = useState(false);
  const { flash, show } = useFlash();

  const fields = useMemo(() => buildCopyFields(product), [product]);
  const copyAll = useMemo(() => buildCopyAllText(fields), [fields]);
  const sku = product.sku ?? "product";
  const plan = useMemo(() => planProductImageZip(sku, images, variants), [sku, images, variants]);
  const nameByUrl = useMemo(() => new Map(plan.map((p) => [p.url, p.name])), [plan]);

  const onCopied = useCallback((key: string, ok: boolean) => show(key, ok ? COPIED : COPY_FAILED), [show]);

  const primary = images.filter((i) => i.isPrimary);
  const extras = images.filter((i) => !i.isPrimary);
  const flashKey = flash?.key ?? null;
  const flashText = flash?.text ?? "";

  return (
    <>
      <button
        type="button"
        data-testid="open-copy-panel"
        onClick={() => setOpen(true)}
        className="btn-ghost px-3 py-1.5 text-xs"
        title="عرض البيانات للنسخ — لا يعدّل أي شيء"
      >
        نسخ بيانات المنتج
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex justify-start" role="dialog" aria-modal="true" aria-label="نسخ بيانات المنتج" dir="rtl">
          <button type="button" aria-label="إغلاق" className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <aside
            data-testid="copy-panel"
            className="relative ml-auto flex h-full w-full max-w-lg flex-col overflow-y-auto bg-[#fdfaf6] shadow-xl sm:max-w-xl"
          >
            <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[#efe3d6] bg-[#fdfaf6] px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">نسخ بيانات المنتج</h2>
                <p className="text-[11px] text-muted">للعرض والنسخ فقط — لا يُعدّل الكتالوج</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="btn-ghost px-3 py-1 text-xs">إغلاق</button>
            </header>

            <div className="space-y-5 px-4 py-4">
              {/* ── بيانات المنتج ── */}
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink">بيانات المنتج</h3>
                  <CopyButton value={copyAll} fieldKey="copy-all" onCopied={onCopied} label="نسخ جميع بيانات المنتج" />
                </div>
                {flashKey === "copy-all" ? <div className="text-[11px] text-emerald-700">{flashText}</div> : null}
                {fields.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-[#efe3d6] bg-white px-3 py-4 text-center text-xs text-muted">
                    لا توجد بيانات قابلة للنسخ
                  </p>
                ) : (
                  <div className="space-y-2">
                    {fields.map((f) => (
                      <FieldRow key={f.key} field={f} flashKey={flashKey} flashText={flashText} onCopied={onCopied} />
                    ))}
                  </div>
                )}
              </section>

              {/* ── صور المنتج ── */}
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink">صور المنتج</h3>
                  {images.length > 0 ? (
                    <a
                      data-testid="download-all-zip"
                      href={`/api/catalog/copy-panel/images?productId=${encodeURIComponent(productId)}`}
                      download={imagesZipFilename(sku)}
                      className="btn-ghost px-3 py-1 text-xs"
                    >
                      تنزيل جميع الصور
                    </a>
                  ) : null}
                </div>

                {images.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-[#efe3d6] bg-white px-3 py-4 text-center text-xs text-muted">
                    لا توجد صور لهذا المنتج
                  </p>
                ) : (
                  <>
                    {primary.length > 0 ? (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-semibold text-muted">الصورة الرئيسية</div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {primary.map((img) => (
                            <ImageCard key={img.url} image={img} filename={nameByUrl.get(img.url) ?? `${sku}-main.jpg`}
                              onCopied={onCopied} flashKey={flashKey} flashText={flashText} />
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {extras.length > 0 ? (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-semibold text-muted">صور إضافية</div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {extras.map((img, i) => (
                            <ImageCard key={img.url} image={img} filename={nameByUrl.get(img.url) ?? `${sku}-${String(i + 1).padStart(2, "0")}.jpg`}
                              onCopied={onCopied} flashKey={flashKey} flashText={flashText} />
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </section>

              {/* ── الخيارات ── */}
              {variants.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-ink">الخيارات</h3>
                  <div className="space-y-3">
                    {variants.map((v, idx) => {
                      const vFields = buildVariantFields(v);
                      const vKey = v.id ?? v.sku ?? `variant-${idx}`;
                      const vAll = buildVariantCopyAllText(v, vFields);
                      return (
                        <div key={vKey} data-testid={`variant-${vKey}`} className="space-y-2 rounded-xl border border-[#efe3d6] bg-white p-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-semibold text-ink">
                              {v.optionNameAr ?? v.optionNameEn ?? v.sku ?? `خيار ${idx + 1}`}
                            </div>
                            <CopyButton value={vAll} fieldKey={`variant-all-${vKey}`} onCopied={onCopied} label="نسخ بيانات الخيار" />
                          </div>
                          {flashKey === `variant-all-${vKey}` ? <div className="text-[11px] text-emerald-700">{flashText}</div> : null}
                          <div className="space-y-1.5">
                            {vFields.map((f) => (
                              <FieldRow key={`${vKey}-${f.key}`} field={{ ...f, key: `${vKey}-${f.key}` }}
                                flashKey={flashKey} flashText={flashText} onCopied={onCopied} />
                            ))}
                          </div>
                          {v.imageUrl ? (
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                              <ImageCard
                                image={{ url: v.imageUrl, filename: null, isPrimary: false }}
                                filename={nameByUrl.get(v.imageUrl) ?? `${sku}-variant-${v.sku ?? idx + 1}.jpg`}
                                onCopied={onCopied} flashKey={flashKey} flashText={flashText}
                              />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
