// /v2/operations/missing-products — Missing Products Discovery & Repair Wizard
// (CH.6F).
//
// Server Component. Renders the operator surface. Scan is read-only; ECL repair
// and product import are writer-gated inside the server actions + orchestrator.
// Here we only compute a UI affordance (canWrite) so a read-only user sees the
// repair/import actions locked. Nothing is written on render.

import { requireMalakWriter } from "@/lib/malak/authz";
import { CATEGORIES } from "@/lib/constants";
import { STOREFRONTS } from "@/lib/channels/storefronts";
import MissingProducts from "@/components/v2/operations/MissingProducts";

export const dynamic = "force-dynamic";

// The five storefronts CH.6F scans (channel:business_unit), from the CH.5 registry.
const CH6F_STOREFRONTS = STOREFRONTS.filter((s) =>
  ["shopify:malikas", "snoonu:malikas", "snoonu:pure_seoul", "talabat:malikas", "rafeeq:malikas"].includes(s.key),
).map((s) => ({ key: s.key, label: s.label ?? s.key }));

export default async function MissingProductsPage() {
  const writer = await requireMalakWriter();
  const canWrite = writer.ok;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">اكتشاف المنتجات الناقصة وإصلاحها</h1>
        <p className="text-sm text-muted">
          فحص للقراءة فقط يكشف الفجوات بين الكتالوج الداخلي والواجهات الخارجية، ويشرح سبب كل فجوة، ويتيح إصلاحًا خاضعًا
          للمعاينة عبر هوية ECL فقط. لا ينشئ منتجات أو روابط تلقائيًا، ولا يعدّل الكميات أو التوفّر، ولا يستورد كمية من
          القنوات. الاستيراد وإنشاء الروابط يمرّان عبر مسارات الإنشاء والهوية المعتمدة فقط.
        </p>
      </header>
      <MissingProducts canWrite={canWrite} storefronts={CH6F_STOREFRONTS} categories={CATEGORIES as unknown as string[]} />
    </div>
  );
}
