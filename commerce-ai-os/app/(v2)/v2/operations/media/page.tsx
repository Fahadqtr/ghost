// /v2/operations/media — Media Center (OPS.2).
//
// Server Component. Loads the read-only Media Center view (dashboard cards,
// missing-images queue, duplicate report, per-product media health) via the
// reader that reuses the existing product + product_images reads. Snoonu image
// recovery is writer-gated inside the CH.6B orchestrator the client calls; here
// we only compute a canWrite affordance. Nothing is written on render.

import { requireMalakWriter } from "@/lib/malak/authz";
import { loadMediaCenter } from "@/lib/operations/media/media-center.server";
import MediaCenter from "@/components/v2/operations/MediaCenter";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذّر تحميل مركز الوسائط.";

export default async function MediaCenterPage() {
  const writer = await requireMalakWriter();
  const canWrite = writer.ok;
  const view = await loadMediaCenter();

  if ("error" in view) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {LOAD_ERROR}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">مركز الوسائط</h1>
        <p className="text-sm text-muted">
          إدارة صور المنتجات من مكان واحد: نظرة عامة، قائمة الصور الناقصة، الصور المكررة، وصحّة الوسائط. الاسترجاع من
          سنونو والرفع اليدوي يمرّان عبر مسارات الصور المعتمدة فقط — لا تُعدَّل الكميات أو التوفّر أو القنوات، ولا تُحذف
          صورة تلقائيًا. المعاينة للقراءة، والتنفيذ يتطلب صلاحية تعديل.
        </p>
      </header>
      <MediaCenter
        canWrite={canWrite}
        dashboard={view.dashboard}
        products={view.products}
        missing={view.missing}
        duplicates={view.duplicates}
        degraded={view.degraded}
      />
    </div>
  );
}
