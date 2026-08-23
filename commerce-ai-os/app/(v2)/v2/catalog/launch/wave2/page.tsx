// /v2/catalog/launch/wave2 — Wave 2 Bulk Review Workspace (CATALOG.GOLIVE.3A).
//
// READ-ONLY Server Component: rendering this page performs ZERO writes — it
// composes the select-only wave2 read model (certified projection + readiness)
// and the audited review seeds. Every mutation is an EXPLICIT operator action
// in Wave2Review, and each one delegates to an existing certified boundary
// (editor save core / Availability Engine / approval action / lifecycle
// boundary) — see ./actions.ts.

import Link from "next/link";
import { loadWave2Review } from "@/lib/catalog/wave2/wave2-review.server";
import { requireMalakWriter } from "@/lib/malak/authz";
import Wave2Review from "@/components/v2/catalog/Wave2Review";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذّر تحميل مساحة مراجعة الدفعة.";

export default async function Wave2ReviewPage() {
  let model: Awaited<ReturnType<typeof loadWave2Review>> | null = null;
  try {
    model = await loadWave2Review();
  } catch {
    model = null;
  }
  // Display-only signal: the real boundary is server-side in every action.
  const writer = await requireMalakWriter();

  if (model === null) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {LOAD_ERROR}
      </div>
    );
  }

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/v2/catalog/launch" className="text-xs text-brand hover:underline">
            ← حملة الإطلاق
          </Link>
          <h1 className="text-lg font-bold text-ink">مراجعة دفعة الإدخال — الموجة 2</h1>
          <p className="text-xs text-muted">
            الاقتراحات مجرد قيم افتراضية للمراجعة — لا يُكتب أي شيء إلا بأمر صريح منك عبر المسارات المعتمدة.
          </p>
        </div>
      </div>
      {!writer.ok && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
          وضع القراءة فقط — تنفيذ الفئات والتوفّر والاعتماد والتفعيل يتطلب صلاحية كتابة (ملاك). أي طلب غير مصرّح يُرفض من الخادم.
        </div>
      )}
      <Wave2Review rows={model.rows} progress={model.progress} />
    </div>
  );
}
