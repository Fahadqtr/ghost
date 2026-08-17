// INT.2A — /v2/export/[destination] — destination detail (read-only).
// Validates the destination key against the canonical registry (unknown → a
// single constant not-found message, never the raw key). Shows capabilities, the
// validation/preview FRAMEWORK (placeholder), the history state (UNAVAILABLE),
// and future actions as disabled — nothing mutates or generates in INT.2A.

import Link from "next/link";
import InPageNav from "@/components/v2/InPageNav";
import { exportDestinationByKey } from "@/lib/export/destinations";
import { EMPTY_VALIDATION_SUMMARY } from "@/lib/export/validation";
import { emptyPreview } from "@/lib/export/preview";
import { unavailableHistory } from "@/lib/export/history";
import { loadTalabatPreview } from "@/lib/export/talabat/preview.server";
import { previewGenerationPlan } from "@/lib/export/talabat/package";
import TalabatPreview, { type TalabatPreviewVM } from "@/components/v2/export/TalabatPreview";
import TalabatPackageControls from "@/components/v2/export/TalabatPackageControls";
import { loadSnoonuPreview } from "@/lib/export/snoonu/preview.server";
import type { SnoonuStorefrontKey } from "@/lib/export/snoonu/preview";
import SnoonuExport, { type SnoonuRowVM } from "@/components/v2/export/SnoonuExport";
import { requireMalakWriter } from "@/lib/malak/authz";

export const dynamic = "force-dynamic";

const NOT_FOUND = "لا توجد وجهة تصدير بهذا المعرّف.";

type Params = Promise<{ destination: string }>;

const GRAIN_LABEL: Record<string, string> = { product: "منتج", variant: "متغيّر (قابل للبيع)" };

export default async function ExportDestinationPage({ params }: { params: Params }) {
  const { destination } = await params;
  const dest = exportDestinationByKey(destination);

  if (!dest) {
    return (
      <div className="space-y-4">
        <Link href="/v2/export" className="btn-ghost">رجوع لمركز التصدير</Link>
        <div className="card text-center text-sm text-muted">{NOT_FOUND}</div>
      </div>
    );
  }

  // INT.2B — the Talabat adapter renders a REAL sellable-listing preview.
  if (dest.key === "talabat:malikas") {
    return <TalabatDetail dest={dest} />;
  }

  // INT.2C — Snoonu multi-store adapters (independent storefronts).
  if (dest.key === "snoonu:malikas" || dest.key === "snoonu:pure_seoul") {
    return <SnoonuDetail dest={dest} />;
  }

  // Foundation placeholders — no real validation/preview/history is produced yet.
  const summary = EMPTY_VALIDATION_SUMMARY;
  const preview = emptyPreview(dest.key, dest.listingGrain === "variant" ? "SELLABLE_LISTING" : "PRODUCT");
  const history = unavailableHistory(dest.key);

  return (
    <div className="space-y-4">
      <Link href="/v2/export" className="btn-ghost">رجوع لمركز التصدير</Link>

      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold text-ink">{dest.label}</h1>
        <p className="text-sm text-muted" dir="ltr">{dest.key}</p>
      </div>

      <InPageNav
        items={[
          { href: "#capabilities", label: "القدرات" },
          { href: "#validation", label: "التحقق" },
          { href: "#preview", label: "المعاينة" },
          { href: "#history", label: "السجل" },
          { href: "#actions", label: "الإجراءات" },
        ]}
      />

      <section id="capabilities" className="scroll-mt-28 card space-y-2">
        <h2 className="text-sm font-semibold text-ink">القدرات</h2>
        <div className="flex flex-wrap gap-1">
          <span className="rounded-full bg-brand-light px-2 py-0.5 text-[11px] text-brand">
            حبيبة القائمة: {GRAIN_LABEL[dest.listingGrain] ?? dest.listingGrain}
          </span>
          {dest.capabilities.map((c) => (
            <span key={c} className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-muted">{c}</span>
          ))}
        </div>
      </section>

      <section id="validation" className="scroll-mt-28 card space-y-2">
        <h2 className="text-sm font-semibold text-ink">حالة التحقق</h2>
        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          <div className="rounded-lg border border-slate-200 p-2"><div className="font-bold">{summary.ready}</div><div className="text-[10px] text-muted">جاهز</div></div>
          <div className="rounded-lg border border-slate-200 p-2"><div className="font-bold">{summary.warnings}</div><div className="text-[10px] text-muted">تحذير</div></div>
          <div className="rounded-lg border border-slate-200 p-2"><div className="font-bold">{summary.blocked}</div><div className="text-[10px] text-muted">محظور</div></div>
          <div className="rounded-lg border border-slate-200 p-2"><div className="font-bold">{summary.unknown}</div><div className="text-[10px] text-muted">غير معروف</div></div>
        </div>
        <p className="text-[11px] text-muted">قواعد التحقق الخاصة بالوجهة تُنفَّذ في مرحلة لاحقة (INT.2B+).</p>
      </section>

      <section id="preview" className="scroll-mt-28 card space-y-2">
        <h2 className="text-sm font-semibold text-ink">المعاينة</h2>
        <p className="text-sm text-muted">
          إطار المعاينة بحبيبة <span dir="ltr">{preview.grain}</span> — لا توجد صفوف بعد (الأساس فقط).
        </p>
      </section>

      <section id="history" className="scroll-mt-28 card space-y-2">
        <h2 className="text-sm font-semibold text-ink">سجل التصدير</h2>
        <p className="text-sm text-muted">
          {history.availability === "UNAVAILABLE"
            ? "غير متوفّر — لا يوجد مصدر دائم لسجل التصدير بعد."
            : `${history.runs.length} عملية`}
        </p>
      </section>

      <section id="actions" className="scroll-mt-28 card space-y-2">
        <h2 className="text-sm font-semibold text-ink">الإجراءات المستقبلية</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled className="btn-ghost cursor-not-allowed opacity-50">تحقق</button>
          <button type="button" disabled className="btn-ghost cursor-not-allowed opacity-50">معاينة</button>
          <button type="button" disabled className="btn-ghost cursor-not-allowed opacity-50">توليد الحزمة</button>
          <button type="button" disabled className="btn-ghost cursor-not-allowed opacity-50">نشر</button>
        </div>
        <p className="text-[11px] text-muted">لا يوجد تنفيذ في هذه المرحلة — الإجراءات معطّلة (للقراءة فقط).</p>
      </section>
    </div>
  );
}

// INT.2B — Talabat sellable-listing preview detail (read-only). Loads the REAL
// adapter output in ONE bounded read and hands the flattened + validated rows to
// the presentational client component. It generates no file and mutates nothing;
// the future generate/publish actions stay disabled.
async function TalabatDetail({ dest }: { dest: NonNullable<ReturnType<typeof exportDestinationByKey>> }) {
  const result = await loadTalabatPreview();

  return (
    <div className="space-y-4">
      <Link href="/v2/export" className="btn-ghost">رجوع لمركز التصدير</Link>

      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold text-ink">{dest.label}</h1>
        <p className="text-sm text-muted" dir="ltr">{dest.key}</p>
        <p className="text-[11px] text-muted">
          حبيبة التصدير: قائمة قابلة للبيع — المنتج البسيط صف واحد، وكل متغيّر صف مستقل (لا يوجد صف أب).
        </p>
      </div>

      {result === null ? (
        <div className="card text-center text-sm text-muted">
          تعذّر تحميل المعاينة الآن — الرجاء المحاولة لاحقاً (لا توجد بيانات ملفّقة).
        </div>
      ) : (
        <>
          <TalabatPreview
            vm={{
              rows: result.rows.map<TalabatPreviewVM["rows"][number]>((r) => ({
                internalProductId: r.internalProductId,
                variantId: r.variantId,
                isVariant: r.isVariant,
                sku: r.sku,
                barcode: r.barcode,
                title: r.title,
                price: r.price,
                category: r.category,
                hasImage: r.hasImage,
                imageExportName: r.imageExportName,
                inheritedParentImage: r.inheritedParentImage,
                mappingStatus: r.mapping.status,
                status: r.status,
                reasons: r.reasons.map((x) => ({ code: x.code, blocking: x.blocking })),
              })),
              summary: result.summary,
              counts: result.counts,
            }}
          />

          {/* INT.2B.2 — real package generation (Generate Ready Package). The
              generator runs server-side through a writer-gated API route; this
              page renders only the read-only preview + the controls. Talabat
              publish stays unavailable — this phase produces files only. */}
          <TalabatPackageControls plan={previewGenerationPlan(result.rows, { mode: "ready" })} />
        </>
      )}
    </div>
  );
}

// INT.2C — Snoonu storefront detail (read-only preview + writer-gated package).
// Loads ONE storefront's certified preview (storefront-scoped ECL identity) in a
// single bounded read and hands the flattened + validated rows to the client
// surface. It generates no file and mutates nothing; the API route (writer-gated)
// produces the package on demand. Snoonu publish stays unavailable.
async function SnoonuDetail({ dest }: { dest: NonNullable<ReturnType<typeof exportDestinationByKey>> }) {
  const key = dest.key as SnoonuStorefrontKey;
  const unit: "malikas" | "pure-seoul" = key === "snoonu:malikas" ? "malikas" : "pure-seoul";
  const [result, writer] = await Promise.all([loadSnoonuPreview(key), requireMalakWriter()]);
  const canWrite = writer.ok;

  return (
    <div className="space-y-4">
      <Link href="/v2/export" className="btn-ghost">رجوع لمركز التصدير</Link>

      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-semibold text-ink">{dest.label}</h1>
        <p className="text-sm text-muted" dir="ltr">{dest.key}</p>
      </div>

      {result === null ? (
        <div className="card text-center text-sm text-muted">
          تعذّر تحميل المعاينة الآن — الرجاء المحاولة لاحقاً (لا توجد بيانات ملفّقة).
        </div>
      ) : (
        <SnoonuExport
          vm={{
            unit,
            storefrontKey: key,
            label: dest.label,
            canWrite,
            counts: result.counts,
            rows: result.rows.map<SnoonuRowVM>((r) => ({
              id: r.internalProductId,
              sku: r.sku,
              barcode: r.barcode,
              title: r.title,
              category: r.category,
              price: r.price,
              spi: r.spi,
              snoonuStatus: r.snoonuStatus,
              hasImage: r.hasImage,
              imageExportName: r.imageExportName,
              imageCount: r.imageCount,
              status: r.status,
              reasons: r.reasons.map((x) => ({ code: x.code, blocking: x.blocking })),
            })),
          }}
        />
      )}
    </div>
  );
}
