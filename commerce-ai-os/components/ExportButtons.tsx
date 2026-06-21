// Per-channel export buttons. Each links to a server route that pulls the live
// DB and streams a real download (all products). Rafeeq is highlighted as the
// ready-to-upload file (real 10-column template + image name + Arabic category).

const EXPORTS = [
  { key: "shopify", label: "Shopify CSV" },
  { key: "snoonu", label: "Snoonu masterlist" },
  { key: "talabat", label: "Talabat split-CSV" },
] as const;

// Images are downloaded in batches so each ZIP finishes well under the
// serverless time limit (a single ~900 MB stream times out).
const BATCH = 100;

export default function ExportButtons({ imageCount = 0 }: { imageCount?: number }) {
  const batches = imageCount > 0
    ? Array.from({ length: Math.ceil(imageCount / BATCH) }, (_, i) => {
        const from = i * BATCH;
        const to = Math.min(from + BATCH, imageCount);
        return { from, label: `${from + 1}–${to}` };
      })
    : [];

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">التصدير لكل منصة</h3>
        <p className="text-xs text-muted">
          يولّد ملفًا حيًّا من قاعدة البيانات (كل المنتجات). ينزّل على جهازك — ما يُرسل لأي منصة.
        </p>
      </div>

      {/* Rafeeq — the ready-to-upload file (real template + images) */}
      <div className="rounded-xl border border-brand/30 bg-brand-light/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-bold text-ink">🟢 رفيق — ملف الرفع الجاهز</h4>
            <p className="text-xs text-muted">
              نفس قالب رفيق بالضبط (10 أعمدة + الفئة بالعربي + اسم الصورة) — حمّله وارفعه مباشرة على رفيق.
            </p>
          </div>
          <a href="/api/export/rafeeq" className="btn-primary shrink-0" download>
            ⬇ تحميل ملف رفيق
          </a>
        </div>
      </div>

      {/* Other channels */}
      <div className="flex flex-wrap gap-2">
        {EXPORTS.map((e) => (
          <a key={e.key} href={`/api/export/${e.key}`} className="btn-ghost" download>
            ⬇ {e.label}
          </a>
        ))}
      </div>

      <div className="border-t border-slate-100 pt-3">
        <h3 className="text-sm font-semibold text-ink">
          Product images {imageCount > 0 ? `(${imageCount})` : ""}
        </h3>
        <p className="text-xs text-muted">
          صور المنتجات كـ ZIP، كل صورة باسم image filename (يطابق عمود New Image Filename).
          تنزّل على دفعات (كل دفعة {BATCH} صورة) عشان كل ملف يخلص بسرعة وما ينقطع. اضغط كل زر بالترتيب،
          وخلّي التبويب مفتوح لين يخلص.
        </p>
        {batches.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {batches.map((b, i) => (
              <a
                key={b.from}
                href={`/api/export/images?from=${b.from}&count=${BATCH}`}
                className="btn-primary"
                download
              >
                ⬇ دفعة {i + 1} ({b.label})
              </a>
            ))}
          </div>
        ) : (
          <a href="/api/export/images" className="btn-primary mt-2 inline-flex" download>
            ⬇ تحميل كل الصور (ZIP)
          </a>
        )}
      </div>
    </div>
  );
}
