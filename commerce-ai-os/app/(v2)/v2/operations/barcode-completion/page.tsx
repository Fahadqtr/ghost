// /v2/operations/barcode-completion — Snoonu Barcode Completion (CH.6D).
//
// Server Component. Renders the operator surface. The apply is writer-gated inside
// the server action + orchestrator; here we only compute a UI affordance
// (canWrite) so a read-only user sees a locked Apply. Nothing is written on
// render — the page performs no scan/apply itself.

import { requireMalakWriter } from "@/lib/malak/authz";
import { parseBarcodeFilter } from "@/lib/operations/barcode-filter";
import BarcodeCompletion from "@/components/v2/operations/BarcodeCompletion";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function BarcodeCompletionPage({ searchParams }: { searchParams?: SearchParams }) {
  const writer = await requireMalakWriter();
  const canWrite = writer.ok;
  // OPS.7 — validated read-only deep-link filter (sku/status) from Operations.
  const params = searchParams ? await searchParams : {};
  const initialFilter = parseBarcodeFilter(params);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">إكمال باركود سنونو</h1>
        <p className="text-sm text-muted">
          إكمال الباركود الناقص للمنتجات والخيارات من أدلة سنونو الحتمية عبر هوية ECL فقط.
          لا يُعدّل الكميات أو التوفّر أو الصور، ولا يستبدل باركودًا موجودًا. المعاينة للقراءة، والإكمال يمرّ عبر حدّ الباركود المعتمد فقط.
        </p>
      </header>
      <BarcodeCompletion canWrite={canWrite} initialFilter={initialFilter} />
    </div>
  );
}
